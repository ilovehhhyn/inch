// Stores each Claude chat as one JSON file of Anthropic messages, replaced atomically and parsed strictly, because the Messages API keeps no conversation.
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { asThreadId, asTurnId, type ThreadId, type TurnId } from "../shared/provider-events";

/** The levels `output_config.effort` accepts on `claude-opus-5-5` (bundled Claude API reference, thinking table). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Narrows a reasoning level to a Claude effort, or fails naming the accepted levels. */
export function parseClaudeEffort(value: unknown): ClaudeEffort {
  const found = CLAUDE_EFFORTS.find((effort) => effort === value);
  if (found === undefined) throw new Error(`effort ${JSON.stringify(value)} is not a Claude effort; use ${CLAUDE_EFFORTS.join(", ")}`);
  return found;
}

/** A stored message is the user's or the assistant's; the beta endpoint's system messages are never stored. */
export type StoredMessage = Anthropic.Beta.BetaUserMessageParam | Anthropic.Beta.BetaAssistantMessageParam;

/**
 * `servedBy` names the model that wrote the answer when it differs from the chat's model. `refused` marks a turn that
 * Claude declined: it stays in the file so the window can show it, and is never sent again (see `replayMessages`).
 */
export type TurnRecord = Readonly<{ turnId: TurnId; userMessageIndex: number; servedBy?: string; refused?: true }>;

/**
 * One chat. `messages` alternate user and assistant, starting with a user message, and a turn `t` owns
 * `messages[t.userMessageIndex]` (the question, with its context block before it when Command-I sent one) and the
 * assistant message after it. `forkedFrom` is the parent chat of a side chat, null for a main chat.
 */
export type ClaudeThreadFile = Readonly<{
  version: 1;
  threadId: ThreadId;
  forkedFrom: ThreadId | null;
  model: string;
  effort: ClaudeEffort;
  messages: ReadonlyArray<StoredMessage>;
  turns: ReadonlyArray<TurnRecord>;
}>;

/**
 * One line of the chat list, read from the chat's small index file and never from its messages, which can hold megabytes
 * of base64. A chat whose file cannot be indexed is listed as `unreadable` with the reason, so one bad file hides no other chat.
 */
export type ChatListEntry =
  | Readonly<{ kind: "chat"; threadId: ThreadId; forkedFrom: ThreadId | null; title: string; hasTurns: boolean; updatedAtMs: number }>
  | Readonly<{ kind: "unreadable"; threadId: ThreadId; problem: string; updatedAtMs: number }>;

export type ClaudeThreadStore = Readonly<{
  /** Rejects when the chat is not stored or its file is invalid. */
  read: (threadId: ThreadId) => Promise<ClaudeThreadFile>;
  /** Validates, then replaces the chat's file atomically. */
  write: (file: ClaudeThreadFile) => Promise<void>;
  /** Every stored chat, sorted by id; each chat's problem stays in its own entry. */
  list: () => Promise<ReadonlyArray<ChatListEntry>>;
}>;

export type ThreadStoreIo = Readonly<{ rename: (from: string, to: string) => Promise<void> }>;

const FILE_KEYS: ReadonlyArray<string> = ["version", "threadId", "forkedFrom", "model", "effort", "messages", "turns"];
const TURN_KEYS: ReadonlyArray<string> = ["turnId", "userMessageIndex", "servedBy", "refused"];
const SAFE_THREAD_ID = /^[A-Za-z0-9-]+$/;
const EXTENSION = ".json";
/** `<id>.index.json` sits beside `<id>.json`; ids hold no dots, so the two names never collide. */
const INDEX_EXTENSION = ".index.json";
const INDEX_KEYS: ReadonlyArray<string> = ["version", "forkedFrom", "title", "hasTurns"];
const TITLE_MAX_CHARS = 60;
const EMPTY_TITLE = "New chat";

/** The part of a chat the list shows; it is derived from the chat file and is rebuilt from it when missing or invalid. */
type ChatIndex = Readonly<{ forkedFrom: ThreadId | null; title: string; hasTurns: boolean }>;

/** The question of a stored user message: its last text block, because a context block, when present, comes first. */
export function questionOf(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  const texts = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  return texts.at(-1) ?? "";
}

/** The first line of the chat's first question, cut to 60 characters; "New chat" when there is none. */
export function titleOf(file: ClaudeThreadFile): string {
  const first = file.messages[0];
  const title = first === undefined ? "" : (questionOf(first.content).split("\n")[0]?.trim().slice(0, TITLE_MAX_CHARS) ?? "");
  return title === "" ? EMPTY_TITLE : title;
}

function indexOf(file: ClaudeThreadFile): ChatIndex {
  return { forkedFrom: file.forkedFrom, title: titleOf(file), hasTurns: file.turns.length > 0 };
}

function indexText(index: ChatIndex): string {
  return `${JSON.stringify({ version: 1, ...index })}\n`;
}

function parseChatIndex(value: unknown): ChatIndex {
  if (!isRecord(value)) throw new Error("index must hold a JSON object");
  const unknown = Object.keys(value).find((key) => !INDEX_KEYS.includes(key));
  const { version, forkedFrom, title, hasTurns } = value;
  if (unknown !== undefined || version !== 1 || (forkedFrom !== null && typeof forkedFrom !== "string") || typeof title !== "string" || typeof hasTurns !== "boolean") throw new Error("not a version 1 chat index");
  return { forkedFrom: forkedFrom === null ? null : asThreadId(forkedFrom), title, hasTurns };
}

function invalid(source: string, problem: string): Error {
  return new Error(`Claude chat file ${source} ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, source: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(source, `has unknown key \`${unknown}\`; delete the file to remove this chat`);
}

function requireText(value: unknown, source: string, name: string): string {
  if (typeof value !== "string" || value === "") throw invalid(source, `${name} must be a non-empty string; delete the file to remove this chat`);
  return value;
}

function parseMessage(value: unknown, index: number, source: string): StoredMessage {
  if (!isRecord(value)) throw invalid(source, `message ${index} must be an object; delete the file to remove this chat`);
  const role = value["role"];
  if (role !== "user" && role !== "assistant") throw invalid(source, `message ${index} has role ${JSON.stringify(role)}; the role must be user or assistant`);
  const content = value["content"];
  const isBlocks = Array.isArray(content) && content.every((block) => isRecord(block) && typeof block["type"] === "string");
  if (typeof content !== "string" && !isBlocks) throw invalid(source, `message ${index} has content that is neither text nor a list of blocks with a type; delete the file to remove this chat`);
  // The shape of content was checked above; the block fields are the SDK's own, written by this store.
  return role === "user" ? { role, content: content as Anthropic.Beta.BetaUserMessageParam["content"] } : { role, content: content as Anthropic.Beta.BetaAssistantMessageParam["content"] };
}

function requireAlternation(messages: ReadonlyArray<StoredMessage>, source: string): void {
  if (messages.length > 0 && messages[0]?.role !== "user") throw invalid(source, "must start with a user message; delete the file to remove this chat");
  messages.forEach((message, index) => {
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (message.role !== expected) throw invalid(source, `must alternate user and assistant messages; message ${index} is ${message.role}`);
  });
}

function parseTurn(value: unknown, messages: ReadonlyArray<StoredMessage>, source: string): TurnRecord {
  if (!isRecord(value)) throw invalid(source, "has a turn that is not an object; delete the file to remove this chat");
  rejectUnknownKeys(value, TURN_KEYS, source);
  const index = value["userMessageIndex"];
  const isPair = typeof index === "number" && Number.isInteger(index) && messages[index]?.role === "user" && messages[index + 1]?.role === "assistant";
  if (!isPair) throw invalid(source, `has a turn whose userMessageIndex ${JSON.stringify(index)} is not a user message followed by an assistant message`);
  const servedBy = value["servedBy"];
  if (servedBy !== undefined && (typeof servedBy !== "string" || servedBy === "")) throw invalid(source, "has a turn whose servedBy is not a non-empty string; delete the file to remove this chat");
  const refused = value["refused"];
  if (refused !== undefined && refused !== true) throw invalid(source, "has a turn whose refused is not true; delete the file to remove this chat");
  return { turnId: asTurnId(requireText(value["turnId"], source, "turnId")), userMessageIndex: index, ...(servedBy === undefined ? {} : { servedBy }), ...(refused === undefined ? {} : { refused }) };
}

/** The messages to send back to the API: every turn except the refused ones, each as its user message and the answer after it, so the two roles still alternate. */
export function replayMessages(file: ClaudeThreadFile): Array<StoredMessage> {
  const refused = new Set(file.turns.filter((turn) => turn.refused === true).flatMap((turn) => [turn.userMessageIndex, turn.userMessageIndex + 1]));
  return file.messages.filter((_, index) => !refused.has(index));
}

/** Parses untrusted data into a ClaudeThreadFile; `source` is the file path, and `expectedId` the id its name promises. */
export function parseClaudeThreadFile(value: unknown, source: string, expectedId: ThreadId): ClaudeThreadFile {
  if (!isRecord(value)) throw invalid(source, "must hold a JSON object; delete the file to remove this chat");
  rejectUnknownKeys(value, FILE_KEYS, source);
  if (value["version"] !== 1) throw invalid(source, `has version ${JSON.stringify(value["version"])}; this Margin reads version 1, so delete the file to remove this chat`);
  const threadId = requireText(value["threadId"], source, "threadId");
  if (threadId !== expectedId) throw invalid(source, `names threadId ${threadId} but its file name says ${expectedId}; delete the file to remove this chat`);
  const forkedFrom = value["forkedFrom"];
  if (forkedFrom !== null && typeof forkedFrom !== "string") throw invalid(source, "has a forkedFrom that is neither a thread id nor null; delete the file to remove this chat");
  const effort = CLAUDE_EFFORTS.find((candidate) => candidate === value["effort"]);
  if (effort === undefined) throw invalid(source, `has effort ${JSON.stringify(value["effort"])}; effort must be ${CLAUDE_EFFORTS.join(", ")}`);
  const rawMessages = value["messages"];
  const rawTurns = value["turns"];
  if (!Array.isArray(rawMessages) || !Array.isArray(rawTurns)) throw invalid(source, "must hold lists of messages and turns; delete the file to remove this chat");
  const messages = rawMessages.map((message, index) => parseMessage(message, index, source));
  requireAlternation(messages, source);
  return {
    version: 1,
    threadId: asThreadId(threadId),
    forkedFrom: forkedFrom === null ? null : asThreadId(forkedFrom),
    model: requireText(value["model"], source, "model"),
    effort,
    messages,
    turns: rawTurns.map((turn) => parseTurn(turn, messages, source)),
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requireSafeId(threadId: string): void {
  if (!SAFE_THREAD_ID.test(threadId)) throw new Error(`thread id \`${threadId}\` must be letters, digits and dashes; it names a file in Margin's chat folder`);
}

let temporaryCounter = 0;

/** The store keeps its files in `directory`, which is created on the first write. */
export function createClaudeThreadStore(directory: string, io: ThreadStoreIo = { rename }): ClaudeThreadStore {
  const pathOf = (threadId: string): string => join(directory, `${threadId}${EXTENSION}`);
  const indexPathOf = (threadId: string): string => join(directory, `${threadId}${INDEX_EXTENSION}`);

  /** Writes to a temporary file in the same folder, then renames it over `path`; a failure leaves `path` as it was. */
  async function writeAtomically(path: string, text: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.${temporaryCounter++}.tmp`;
    try {
      await writeFile(temporary, text, "utf8");
      await io.rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function readFileAt(path: string, threadId: ThreadId): Promise<ClaudeThreadFile> {
    const text = await readFile(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalid(path, "is not valid JSON; delete the file to remove this chat");
    }
    return parseClaudeThreadFile(value, path, threadId);
  }

  /** The index file's content, or null when it is missing or invalid; it is derived data, so the caller rebuilds it from the chat file. */
  async function readIndex(path: string): Promise<ChatIndex | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    try {
      return parseChatIndex(JSON.parse(text));
    } catch {
      return null; // an unreadable index is rebuilt below, never trusted
    }
  }

  async function indexFor(threadId: ThreadId): Promise<ChatIndex> {
    const indexPath = indexPathOf(threadId);
    const stored = await readIndex(indexPath);
    if (stored !== null) return stored;
    const index = indexOf(await readFileAt(pathOf(threadId), threadId));
    await writeAtomically(indexPath, indexText(index));
    return index;
  }

  return {
    async read(threadId) {
      requireSafeId(threadId);
      try {
        return await readFileAt(pathOf(threadId), threadId);
      } catch (error) {
        if (isMissingFile(error)) throw new Error(`no stored Claude chat ${threadId}; open another chat from the list`);
        throw error;
      }
    },
    async write(file) {
      requireSafeId(file.threadId);
      const path = pathOf(file.threadId);
      const checked = parseClaudeThreadFile(JSON.parse(JSON.stringify(file)), path, file.threadId);
      await writeAtomically(indexPathOf(file.threadId), indexText(indexOf(checked))); // first: an index without a chat file is never listed
      await writeAtomically(path, `${JSON.stringify(checked, null, 2)}\n`);
    },
    async list() {
      let names: Array<string>;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
      const chatNames = names.filter((candidate) => candidate.endsWith(EXTENSION) && !candidate.endsWith(INDEX_EXTENSION) && SAFE_THREAD_ID.test(candidate.slice(0, -EXTENSION.length))).sort();
      const entries: Array<ChatListEntry> = [];
      for (const name of chatNames) {
        const threadId = asThreadId(name.slice(0, -EXTENSION.length));
        const path = join(directory, name);
        try {
          const updatedAtMs = (await stat(path)).mtimeMs;
          entries.push({ kind: "chat", threadId, ...(await indexFor(threadId)), updatedAtMs });
        } catch (error) {
          if (isMissingFile(error)) continue; // the chat was deleted between the listing and the read
          entries.push({ kind: "unreadable", threadId, problem: error instanceof Error ? error.message : String(error), updatedAtMs: 0 });
        }
      }
      return entries;
    },
  };
}
