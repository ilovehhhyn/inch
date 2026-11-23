// Stores attached files in Margin's own folder, hands a send exactly the files it names, and reads their content for the providers.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ATTACHMENT_LIMITS,
  classifyAttachment,
  mediaTypeOf,
  requireWithinLimit,
  safeAttachmentName,
  SNIFF_BYTES,
  type Attachment,
  type AttachmentContent,
} from "../shared/attachment";
import type { ThreadId } from "../shared/provider-events";

/** Staged files live here until a send adopts them; a start-up clears what a crashed session left. */
const STAGING_FOLDER = "pending";
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]+$/;
/** Text that Margin sends in place of a PDF; a longer PDF is an error because cutting it would hide pages from the model without saying so. */
export const PDF_TEXT_LIMIT_CHARS = 400_000;
/** A 600-page PDF is the Claude limit; 30 s bounds parsing it. */
export const PDF_EXTRACT_TIMEOUT_MS = 30 * 1000;

export type AttachmentStore = Readonly<{
  /** Classifies by content, checks the size, then copies the bytes under the file's own name; a rejected file leaves nothing on disk. */
  add: (file: Readonly<{ name: string; bytes: Uint8Array }>) => Promise<Attachment>;
  /** Removes a file the user took off the message: a staged one, or one that a send adopted but the provider refused. A file of a sent message cannot be removed. */
  discard: (id: string) => Promise<void>;
  /** Marks adopted files as part of a message that was sent; from then on they stay. */
  commit: (ids: ReadonlyArray<string>) => void;
  /** Moves the named staged files into the chat's folder and returns them; the same ids for the same chat return the same files again, so a retry works. */
  adopt: (chatId: ThreadId, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<Attachment>>;
}>;

export type AttachmentStoreOptions = Readonly<{ directory: string; createId?: () => string }>;

function requireSafeChatId(chatId: string): void {
  if (!SAFE_CHAT_ID.test(chatId)) throw new Error(`chat id \`${chatId}\` must be letters, digits, dashes or underscores; it names a folder in Margin's attachments folder`);
}

/** Deletes the staging folder; a folder that never existed is fine. */
export async function clearStagedAttachments(directory: string): Promise<void> {
  await rm(join(directory, STAGING_FOLDER), { recursive: true, force: true });
}

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
  const createId = options.createId ?? randomUUID;
  const staged = new Map<string, Attachment>();
  const adopted = new Map<string, Readonly<{ chatId: ThreadId; attachment: Attachment; isCommitted: boolean }>>();

  return {
    async add({ name: fullName, bytes }) {
      const name = safeAttachmentName(fullName);
      const kind = classifyAttachment(name, bytes.subarray(0, SNIFF_BYTES));
      requireWithinLimit(kind, name, bytes.length);
      const id = createId();
      const folder = join(options.directory, STAGING_FOLDER, id);
      const storedPath = join(folder, name);
      await mkdir(folder, { recursive: true });
      try {
        await writeFile(storedPath, bytes, { flag: "wx" });
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      const attachment: Attachment = { id, kind, name, storedPath, bytes: bytes.length, mediaType: mediaTypeOf(kind, bytes.subarray(0, SNIFF_BYTES)) };
      staged.set(id, attachment);
      return attachment;
    },
    async discard(id) {
      const owner = adopted.get(id);
      if (owner?.isCommitted === true) throw new Error(`attachment \`${id}\` belongs to a message that was sent; it cannot be removed`);
      if (owner === undefined && !staged.has(id)) throw new Error(`attachment \`${id}\` is not attached; there is nothing to remove`);
      const folder = owner === undefined ? join(options.directory, STAGING_FOLDER, id) : join(options.directory, owner.chatId, id);
      staged.delete(id);
      adopted.delete(id);
      await rm(folder, { recursive: true, force: true });
    },
    commit(ids) {
      const missing = ids.find((id) => !adopted.has(id));
      if (missing !== undefined) throw new Error(`attachment \`${missing}\` was not adopted by a send; there is nothing to commit`);
      for (const id of ids) {
        const owner = adopted.get(id);
        if (owner !== undefined) adopted.set(id, { ...owner, isCommitted: true });
      }
    },
    async adopt(chatId, ids) {
      requireSafeChatId(chatId);
      if (ids.length > ATTACHMENT_LIMITS.perMessage) throw new Error(`cannot attach more than ${ATTACHMENT_LIMITS.perMessage} files to one message; remove one first`);
      const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
      if (repeated !== undefined) throw new Error(`attachment \`${repeated}\` is listed twice; list each file once`);
      for (const id of ids) {
        const owner = adopted.get(id);
        if (owner !== undefined && owner.chatId !== chatId && owner.isCommitted) throw new Error(`attachment \`${id}\` belongs to a message that was sent; attach the file again`);
        if (owner === undefined && !staged.has(id)) throw new Error(`attachment \`${id}\` is not attached; attach the file again`);
      }
      const moved: Array<Readonly<{ from: string; to: string }>> = [];
      const result: Array<Attachment> = [];
      try {
        for (const id of ids) {
          const owner = adopted.get(id);
          if (owner?.chatId === chatId) {
            result.push(owner.attachment);
            continue;
          }
          const attachment = owner?.attachment ?? staged.get(id);
          if (attachment === undefined) throw new Error(`attachment \`${id}\` is not attached; attach the file again`);
          const from = owner === undefined ? join(options.directory, STAGING_FOLDER, id) : join(options.directory, owner.chatId, id);
          const to = join(options.directory, chatId, id);
          await mkdir(join(options.directory, chatId), { recursive: true });
          await rename(from, to);
          moved.push({ from, to });
          result.push({ ...attachment, storedPath: join(to, attachment.name) });
        }
      } catch (error) {
        for (const { from, to } of moved.reverse()) await rename(to, from);
        throw error;
      }
      for (const attachment of result) {
        staged.delete(attachment.id);
        adopted.set(attachment.id, { chatId, attachment, isCommitted: adopted.get(attachment.id)?.isCommitted ?? false });
      }
      return result;
    },
  };
}

export type AttachmentContentOptions = Readonly<{ pdfTextLimitChars?: number }>;

/** Reads the stored copy of an attachment for a provider: UTF-8 text, base64 bytes, or the text layer of a PDF. */
export function createAttachmentContent(options: AttachmentContentOptions = {}): AttachmentContent {
  const pdfTextLimitChars = options.pdfTextLimitChars ?? PDF_TEXT_LIMIT_CHARS;

  async function readPages(attachment: Attachment): Promise<Array<string>> {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"); // heavy and used only for a PDF sent to Codex
    const task = getDocument({ data: new Uint8Array(await readFile(attachment.storedPath)), verbosity: 0 });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`reading it took longer than ${PDF_EXTRACT_TIMEOUT_MS / 1000} s`)), PDF_EXTRACT_TIMEOUT_MS).unref();
    });
    try {
      const document = await Promise.race([task.promise, timeout]);
      const pages: Array<string> = [];
      for (let number = 1; number <= document.numPages; number++) {
        const content = await Promise.race([(await document.getPage(number)).getTextContent(), timeout]);
        pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim());
      }
      return pages;
    } finally {
      await task.destroy();
    }
  }

  return {
    async readText(attachment) {
      const bytes = await readFile(attachment.storedPath);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`cannot read \`${attachment.name}\` as UTF-8 text; save it as UTF-8 or attach it as a PDF`);
      }
    },
    async readBase64(attachment) {
      return (await readFile(attachment.storedPath)).toString("base64");
    },
    async extractPdfText(attachment) {
      let pages: Array<string>;
      try {
        pages = await readPages(attachment);
      } catch (error) {
        throw new Error(`cannot read \`${attachment.name}\` as text; ${error instanceof Error ? error.message : String(error)}`);
      }
      const text = pages.map((page, index) => `[page ${index + 1}]\n${page}`).join("\n\n");
      if (pages.every((page) => page === "")) throw new Error(`cannot read \`${attachment.name}\` as text; the PDF has no text layer (it may be scanned), so attach it to a Claude chat or paste its text`);
      if (text.length > pdfTextLimitChars) throw new Error(`cannot read \`${attachment.name}\` as text; it has more than ${pdfTextLimitChars} characters of text, so attach fewer pages`);
      return text;
    },
  };
}
