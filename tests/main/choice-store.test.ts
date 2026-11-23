// Invariant: the model and reasoning level last used in each chat are kept in one file that is replaced atomically, read back exactly and never accepted with unknown keys or another version.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createChoiceStore } from "../../src/main/choice-store";
import { asThreadId } from "../../src/shared/provider-events";

const FIRST = asThreadId("thread-1");
const SECOND = asThreadId("thread-2");

async function path(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "margin-choices-")), "choices.json");
}

test("a_chat_without_a_stored_choice_reads_as_null", async () => {
  expect(await createChoiceStore(await path()).read(FIRST)).toBeNull();
});

test("a_written_choice_is_read_back_by_a_new_store", async () => {
  const file = await path();
  await createChoiceStore(file).write(FIRST, { model: "claude-opus-5-5", reasoning: "xhigh" });

  expect(await createChoiceStore(file).read(FIRST)).toEqual({ model: "claude-opus-5-5", reasoning: "xhigh" });
});

test("overlapping_writes_for_two_chats_both_survive", async () => {
  const file = await path();
  const store = createChoiceStore(file);

  await Promise.all([store.write(FIRST, { model: "a", reasoning: "low" }), store.write(SECOND, { model: "b", reasoning: "high" })]);

  expect(await store.read(FIRST)).toEqual({ model: "a", reasoning: "low" });
  expect(await store.read(SECOND)).toEqual({ model: "b", reasoning: "high" });
});

test("a_crash_between_write_and_rename_leaves_the_old_file_whole", async () => {
  const file = await path();
  await createChoiceStore(file).write(FIRST, { model: "a", reasoning: "low" });
  const crashing = createChoiceStore(file, {
    writeFile,
    rename: async () => {
      throw new Error("power cut between write and rename");
    },
  });

  await expect(crashing.write(FIRST, { model: "b", reasoning: "high" })).rejects.toThrow("power cut");

  expect(await createChoiceStore(file).read(FIRST)).toEqual({ model: "a", reasoning: "low" });
});

test.each([
  ["text that is not json", "{not json", "is not valid JSON"],
  ["another version", JSON.stringify({ version: 2, choices: {} }), "version"],
  ["an unknown top-level key", JSON.stringify({ version: 1, choices: {}, extra: 1 }), "unknown key `extra`"],
  ["a choice with an unknown key", JSON.stringify({ version: 1, choices: { "thread-1": { model: "a", reasoning: "low", extra: 1 } } }), "unknown key `extra`"],
  ["a choice without a model", JSON.stringify({ version: 1, choices: { "thread-1": { model: "", reasoning: "low" } } }), "model"],
])("a_file_with_%s_is_rejected_naming_the_file", async (_name, content, fragment) => {
  const file = await path();
  await writeFile(file, content);

  await expect(createChoiceStore(file).read(FIRST)).rejects.toThrow(file);
  await expect(createChoiceStore(file).read(FIRST)).rejects.toThrow(fragment);
});

test("a_rejected_file_is_left_untouched_by_a_later_write", async () => {
  const file = await path();
  await writeFile(file, "{not json");

  await expect(createChoiceStore(file).write(FIRST, { model: "a", reasoning: "low" })).rejects.toThrow("is not valid JSON");

  expect(await readFile(file, "utf8")).toBe("{not json");
});
