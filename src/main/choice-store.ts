// Keeps the model and reasoning level last used in each chat in one JSON file that is replaced atomically.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ModelChoice } from "../shared/models";
import { asThreadId, type ThreadId } from "../shared/provider-events";

export type ChoiceStore = Readonly<{
  /** The chat's last choice, or null when it has none; rejects when the file is invalid. */
  read: (threadId: ThreadId) => Promise<ModelChoice | null>;
  /** Replaces the chat's choice; writes overlap safely because they run one after another. */
  write: (threadId: ThreadId, choice: ModelChoice) => Promise<void>;
}>;

export type ChoiceStoreIo = Readonly<{
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}>;

const NODE_IO: ChoiceStoreIo = { writeFile: (path, data) => writeFile(path, data, "utf8"), rename };
const FILE_KEYS: ReadonlyArray<string> = ["version", "choices"];
const CHOICE_KEYS: ReadonlyArray<string> = ["model", "reasoning"];

function invalid(source: string, problem: string): Error {
  return new Error(`choice file ${source} ${problem}; delete the file to forget the saved choices`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, source: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(source, `has unknown key \`${unknown}\``);
}

function parseChoice(value: unknown, threadId: string, source: string): ModelChoice {
  if (!isRecord(value)) throw invalid(source, `has a choice for ${threadId} that is not an object`);
  rejectUnknownKeys(value, CHOICE_KEYS, source);
  const { model, reasoning } = value;
  if (typeof model !== "string" || model === "") throw invalid(source, `has a choice for ${threadId} whose model is not a non-empty string`);
  if (typeof reasoning !== "string" || reasoning === "") throw invalid(source, `has a choice for ${threadId} whose reasoning is not a non-empty string`);
  return { model, reasoning };
}

function parseFile(text: string, source: string): Map<ThreadId, ModelChoice> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(source, "is not valid JSON");
  }
  if (!isRecord(value)) throw invalid(source, "must hold a JSON object");
  rejectUnknownKeys(value, FILE_KEYS, source);
  if (value["version"] !== 1) throw invalid(source, `has version ${JSON.stringify(value["version"])}; this Margin reads version 1`);
  const choices = value["choices"];
  if (!isRecord(choices)) throw invalid(source, "must hold an object of choices");
  return new Map(Object.entries(choices).map(([threadId, choice]) => [asThreadId(threadId), parseChoice(choice, threadId, source)]));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

let temporaryCounter = 0;

export function createChoiceStore(path: string, io: ChoiceStoreIo = NODE_IO): ChoiceStore {
  let queue: Promise<void> = Promise.resolve();

  async function load(): Promise<Map<ThreadId, ModelChoice>> {
    try {
      return parseFile(await readFile(path, "utf8"), path);
    } catch (error) {
      if (isMissingFile(error)) return new Map();
      throw error;
    }
  }

  async function save(choices: ReadonlyMap<ThreadId, ModelChoice>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${temporaryCounter++}.tmp`;
    try {
      await io.writeFile(temporary, `${JSON.stringify({ version: 1, choices: Object.fromEntries(choices) }, null, 2)}\n`);
      await io.rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return {
    async read(threadId) {
      await queue;
      return (await load()).get(threadId) ?? null;
    },
    write(threadId, choice) {
      const run = queue.then(async () => {
        const choices = await load();
        choices.set(threadId, { model: choice.model, reasoning: choice.reasoning });
        await save(choices);
      });
      queue = run.catch(() => undefined); // this write's failure goes to its caller through `run`; later writes must still run
      return run;
    },
  };
}
