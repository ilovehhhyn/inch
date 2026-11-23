// Stores each Claude chat as one JSON file of Anthropic messages, replaced atomically and parsed strictly, because the Messages API keeps no conversation.
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { asThreadId, asTurnId, type ThreadId, type TurnId } from "../shared/provider-events";

export type ClaudeEffort = "low" | "medium";

export type TurnRecord = Readonly<{ turnId: TurnId; userMessageIndex: number }>;

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
  messages: ReadonlyArray<Anthropic.Beta.BetaMessageParam>;
  turns: ReadonlyArray<TurnRecord>;
}>;

export type StoredThread = Readonly<{ file: ClaudeThreadFile; updatedAtMs: number }>;

export type ClaudeThreadStore = Readonly<{
  /** Rejects when the chat is not stored or its file is invalid. */
  read: (threadId: ThreadId) => Promise<ClaudeThreadFile>;
  /** Validates, then replaces the chat's file atomically. */
  write: (file: ClaudeThreadFile) => Promise<void>;
  /** Every stored chat; one invalid file fails the whole list so it is never skipped unseen. */
  list: () => Promise<ReadonlyArray<StoredThread>>;
}>;

export type ThreadStoreIo = Readonly<{ rename: (from: string, to: string) => Promise<void> }>;

const FILE_KEYS: ReadonlyArray<string> = ["version", "threadId", "forkedFrom", "model", "effort", "messages", "turns"];
const TURN_KEYS: ReadonlyArray<string> = ["turnId", "userMessageIndex"];
const SAFE_THREAD_ID = /^[A-Za-z0-9-]+$/;
const EXTENSION = ".json";

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

function parseMessage(value: unknown, index: number, source: string): Anthropic.Beta.BetaMessageParam {
  if (!isRecord(value)) throw invalid(source, `message ${index} must be an object; delete the file to remove this chat`);
  const role = value["role"];
  if (role !== "user" && role !== "assistant") throw invalid(source, `message ${index} has role ${JSON.stringify(role)}; the role must be user or assistant`);
  const content = value["content"];
  const isBlocks = Array.isArray(content) && content.every((block) => isRecord(block) && typeof block["type"] === "string");
  if (typeof content !== "string" && !isBlocks) throw invalid(source, `message ${index} has content that is neither text nor a list of blocks with a type; delete the file to remove this chat`);
  // The shape of content was checked above; the block fields are the SDK's own, written by this store.
  return role === "user" ? { role, content: content as Anthropic.Beta.BetaUserMessageParam["content"] } : { role, content: content as Anthropic.Beta.BetaAssistantMessageParam["content"] };
}

function requireAlternation(messages: ReadonlyArray<Anthropic.Beta.BetaMessageParam>, source: string): void {
  if (messages.length > 0 && messages[0]?.role !== "user") throw invalid(source, "must start with a user message; delete the file to remove this chat");
  messages.forEach((message, index) => {
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (message.role !== expected) throw invalid(source, `must alternate user and assistant messages; message ${index} is ${message.role}`);
  });
}

function parseTurn(value: unknown, messages: ReadonlyArray<Anthropic.Beta.BetaMessageParam>, source: string): TurnRecord {
  if (!isRecord(value)) throw invalid(source, "has a turn that is not an object; delete the file to remove this chat");
  rejectUnknownKeys(value, TURN_KEYS, source);
  const index = value["userMessageIndex"];
  const isPair = typeof index === "number" && Number.isInteger(index) && messages[index]?.role === "user" && messages[index + 1]?.role === "assistant";
  if (!isPair) throw invalid(source, `has a turn whose userMessageIndex ${JSON.stringify(index)} is not a user message followed by an assistant message`);
  return { turnId: asTurnId(requireText(value["turnId"], source, "turnId")), userMessageIndex: index };
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
  const effort = value["effort"];
  if (effort !== "low" && effort !== "medium") throw invalid(source, `has effort ${JSON.stringify(effort)}; effort must be low or medium`);
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
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.${temporaryCounter++}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
        await io.rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async list() {
      let names: Array<string>;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
      const stored: Array<StoredThread> = [];
      for (const name of names.filter((candidate) => candidate.endsWith(EXTENSION)).sort()) {
        const path = join(directory, name);
        const file = await readFileAt(path, asThreadId(name.slice(0, -EXTENSION.length)));
        stored.push({ file, updatedAtMs: (await stat(path)).mtimeMs });
      }
      return stored;
    },
  };
}
