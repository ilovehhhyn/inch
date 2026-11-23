// Invariant: a Claude chat is one JSON file per thread, replaced atomically, read back exactly, and never accepted with unknown keys, another version or messages that break the user and assistant alternation.
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createClaudeThreadStore, type ClaudeThreadFile } from "../../src/claude/claude-thread-store";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";

const THREAD = asThreadId("11111111-aaaa-bbbb-cccc-222222222222");

const SAVED: ClaudeThreadFile = {
  version: 1,
  threadId: THREAD,
  forkedFrom: null,
  model: "claude-opus-5-5",
  effort: "low",
  messages: [
    { role: "user", content: [{ type: "text", text: "MARGIN SCREEN CONTEXT v1" }, { type: "text", text: "what is lr?" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "text", text: "The step size." }] },
  ],
  turns: [{ turnId: asTurnId("turn-1"), userMessageIndex: 0 }],
};

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "margin-claude-threads-"));
}

test("write_then_read_returns_the_same_file_including_thinking_blocks", async () => {
  const store = createClaudeThreadStore(await folder());

  await store.write(SAVED);

  expect(await store.read(THREAD)).toEqual(SAVED);
});

test("a_write_leaves_only_the_thread_file_in_the_folder", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);

  await store.write(SAVED);
  await store.write({ ...SAVED, model: "claude-opus-5-5" });

  expect(await readdir(directory)).toEqual([`${THREAD}.json`]);
});

test("a_failed_rename_leaves_the_old_file_whole_and_no_temporary_file", async () => {
  const directory = await folder();
  await createClaudeThreadStore(directory).write(SAVED);
  const crashing = createClaudeThreadStore(directory, {
    rename: async () => {
      throw new Error("power cut between write and rename");
    },
  });

  await expect(crashing.write({ ...SAVED, effort: "medium" })).rejects.toThrow("power cut between write and rename");

  expect(await readdir(directory)).toEqual([`${THREAD}.json`]);
  expect((await createClaudeThreadStore(directory).read(THREAD)).effort).toBe("low");
});

test("a_missing_thread_is_an_error_that_names_the_chat", async () => {
  await expect(createClaudeThreadStore(await folder()).read(THREAD)).rejects.toThrow(`no stored Claude chat ${THREAD}; open another chat from the list`);
});

test("thread_file_with_unknown_keys_is_rejected", async () => {
  const directory = await folder();
  const path = join(directory, `${THREAD}.json`);
  await writeFile(path, JSON.stringify({ ...SAVED, theme: "dark" }));

  await expect(createClaudeThreadStore(directory).read(THREAD)).rejects.toThrow(new RegExp(`${path}.*unknown key \`theme\``));
});

test("another_version_is_rejected_with_the_fix", async () => {
  const directory = await folder();
  const path = join(directory, `${THREAD}.json`);
  await writeFile(path, JSON.stringify({ ...SAVED, version: 2 }));

  await expect(createClaudeThreadStore(directory).read(THREAD)).rejects.toThrow(new RegExp(`${path}.*version 2.*delete the file`));
});

test("text_that_is_not_json_is_rejected_with_the_file_name", async () => {
  const directory = await folder();
  const path = join(directory, `${THREAD}.json`);
  await writeFile(path, "{not json");

  await expect(createClaudeThreadStore(directory).read(THREAD)).rejects.toThrow(`${path} is not valid JSON`);
});

test.each([
  ["a thread id that differs from the file name", { ...SAVED, threadId: "someone-else" }, "threadId"],
  ["an effort outside low and medium", { ...SAVED, effort: "max" }, "effort"],
  ["an empty model", { ...SAVED, model: "" }, "model"],
  ["a message with another role", { ...SAVED, messages: [{ role: "system", content: "x" }, SAVED.messages[1]] }, "role"],
  ["two user messages in a row", { ...SAVED, messages: [SAVED.messages[0], SAVED.messages[0]] }, "alternate"],
  ["a thread that starts with an assistant message", { ...SAVED, messages: [SAVED.messages[1], SAVED.messages[0]], turns: [{ turnId: "t", userMessageIndex: 1 }] }, "start with a user message"],
  ["a turn that points past the messages", { ...SAVED, turns: [{ turnId: "turn-1", userMessageIndex: 4 }] }, "userMessageIndex"],
  ["a turn that points at an assistant message", { ...SAVED, turns: [{ turnId: "turn-1", userMessageIndex: 1 }] }, "userMessageIndex"],
  ["a turn record with an extra key", { ...SAVED, turns: [{ turnId: "turn-1", userMessageIndex: 0, extra: 1 }] }, "unknown key `extra`"],
  ["content that is neither text nor blocks", { ...SAVED, messages: [{ role: "user", content: 5 }, SAVED.messages[1]] }, "content"],
  ["a content block without a type", { ...SAVED, messages: [{ role: "user", content: [{ text: "x" }] }, SAVED.messages[1]] }, "type"],
  ["a fork parent that is not text or null", { ...SAVED, forkedFrom: 5 }, "forkedFrom"],
])("%s is rejected naming the file and the field", async (_name, value, fragment) => {
  const directory = await folder();
  const path = join(directory, `${THREAD}.json`);
  await writeFile(path, JSON.stringify(value));

  await expect(createClaudeThreadStore(directory).read(THREAD)).rejects.toThrow(path);
  await expect(createClaudeThreadStore(directory).read(THREAD)).rejects.toThrow(fragment);
});

test("a_file_the_writer_would_reject_is_not_written", async () => {
  const directory = await folder();

  await expect(createClaudeThreadStore(directory).write({ ...SAVED, messages: [SAVED.messages[0] as ClaudeThreadFile["messages"][number], SAVED.messages[0] as ClaudeThreadFile["messages"][number]] })).rejects.toThrow("alternate");

  expect(await readdir(directory)).toEqual([]);
});

test("a_thread_id_that_is_not_safe_in_a_file_name_is_rejected_before_any_path_is_built", async () => {
  const store = createClaudeThreadStore(await folder());

  await expect(store.read(asThreadId("../../etc/passwd"))).rejects.toThrow("thread id `../../etc/passwd` must be letters, digits and dashes");
});

test("list_returns_every_file_with_its_modification_time_and_ignores_other_files", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write(SAVED);
  await store.write({ ...SAVED, threadId: asThreadId("second-chat") });
  await writeFile(join(directory, "notes.txt"), "not a thread");

  const listed = await store.list();

  expect(listed.map((entry) => entry.file.threadId).sort()).toEqual([THREAD, "second-chat"].sort());
  for (const entry of listed) expect(entry.updatedAtMs).toBeGreaterThan(0);
});

test("list_with_no_folder_yet_is_empty_and_one_bad_file_fails_the_list_naming_it", async () => {
  const parent = await folder();
  expect(await createClaudeThreadStore(join(parent, "claude-threads")).list()).toEqual([]);
  await createClaudeThreadStore(parent).write(SAVED);
  await writeFile(join(parent, "broken.json"), "{}");

  await expect(createClaudeThreadStore(parent).list()).rejects.toThrow(join(parent, "broken.json"));
  expect(await readFile(join(parent, `${THREAD}.json`), "utf8")).toContain(THREAD);
});
