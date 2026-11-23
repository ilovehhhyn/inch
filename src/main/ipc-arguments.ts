// Parses the untrusted arguments of IPC calls that carry more structure than a string.
import { ATTACHMENT_LIMITS } from "../shared/attachment";
import { parseContextBlock, type ScreenContext } from "../shared/context-format";
import type { ModelChoice } from "../shared/models";

/** The renderer keeps context under 12,000 characters (CONTEXT_BUDGET_CHARS); the bound leaves room for escapes and labels and stops a runaway value. */
export const MAX_CONTEXT_TEXT_CHARS = 64 * 1024;

/** Accepts null (a plain message) or a well-formed screen-context block no longer than the bound. */
export function parseContextText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`contextText must be a string or null, got ${typeof value}`);
  if (value.length > MAX_CONTEXT_TEXT_CHARS) throw new Error(`contextText must be at most ${MAX_CONTEXT_TEXT_CHARS} characters, got ${value.length}; the window must trim it to its budget`);
  if (parseContextBlock(value) === null) throw new Error("contextText must be a MARGIN SCREEN CONTEXT block; the window builds it with renderContextBlock");
  return value;
}

/** Accepts null or a well-formed block (see `parseContextText`) and returns the structured context the providers render themselves. */
export function parseScreenContext(value: unknown): ScreenContext | null {
  const text = parseContextText(value);
  if (text === null) return null;
  const context = parseContextBlock(text);
  if (context === null) throw new Error("contextText must be a MARGIN SCREEN CONTEXT block; the window builds it with renderContextBlock");
  return context;
}

/** The window may read the diff only of the folder the user chose and Margin saved. */
export function requireSavedDiffFolder(folder: string, saved: string | null): string {
  if (saved === null) throw new Error("no diff folder has been chosen; choose one with the folder button first");
  if (folder !== saved) throw new Error(`diff folder ${folder} is not the folder chosen in Margin (${saved}); choose it with the folder button`);
  return folder;
}

/** A saved layout may name only the folder it already holds or one the folder dialog returned, so the window cannot save a folder of its own choosing and then read its diff. */
export function requireChosenDiffFolder(folder: string | null, saved: string | null, chosen: ReadonlySet<string>): string | null {
  if (folder === null || folder === saved || chosen.has(folder)) return folder;
  throw new Error(`diff folder ${folder} was not chosen with the folder dialog; choose it with the folder button`);
}

/** Accepts exactly `{ model, reasoning }` with two non-empty strings; whether the provider offers them is checked by the provider. */
export function parseModelChoice(value: unknown): ModelChoice {
  const fix = "choice must be { model, reasoning } with two non-empty strings; the window sends the pickers' values";
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(fix);
  const keys = Object.keys(value).sort();
  const { model, reasoning } = value as Record<string, unknown>; // the keys and their types are checked on the next lines
  const isExact = keys.length === 2 && keys[0] === "model" && keys[1] === "reasoning";
  if (!isExact || typeof model !== "string" || model === "" || typeof reasoning !== "string" || reasoning === "") throw new Error(fix);
  return { model, reasoning };
}

/** The largest file any kind allows; a larger buffer is refused before it is classified or copied. */
export const MAX_ATTACHMENT_BYTES = Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.pdfBytes, ATTACHMENT_LIMITS.textBytes);

/** A file name and its bytes, as the window sends them; the bytes are bounded before anything reads them. */
export function parseAttachmentFile(name: unknown, bytes: unknown): Readonly<{ name: string; bytes: Uint8Array }> {
  if (typeof name !== "string") throw new Error(`attachment name must be a string, got ${typeof name}`);
  if (!(bytes instanceof Uint8Array)) throw new Error("attachment bytes must be a Uint8Array; the window reads the file with arrayBuffer()");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`cannot attach \`${name}\`; no file may be larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
  return { name, bytes };
}

/** Accepts a list of at most the per-message limit of strings. */
export function parseAttachmentIds(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string")) throw new Error("attachmentIds must be a list of strings; the window sends the ids attachmentAdd returned");
  if (value.length > ATTACHMENT_LIMITS.perMessage) throw new Error(`cannot attach more than ${ATTACHMENT_LIMITS.perMessage} files to one message; remove one first`);
  return value;
}
