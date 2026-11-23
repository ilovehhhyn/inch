// Invariant: a Claude chat is one JSON file per thread, replaced atomically, read back exactly, and never accepted with unknown keys, another version or messages that break the user and assistant alternation.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createClaudeThreadStore, replayMessages, type ClaudeThreadFile, type StoredMessage } from "../../src/claude/claude-thread-store";
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

  expect((await readdir(directory)).sort()).toEqual([`${THREAD}.index.json`, `${THREAD}.json`]);
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

  expect((await readdir(directory)).sort()).toEqual([`${THREAD}.index.json`, `${THREAD}.json`]);
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

test.each(["low", "medium", "high", "xhigh", "max"] as const)("a chat stored with effort %s is read back with it", async (effort) => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);

  await store.write({ ...SAVED, effort });

  expect((await store.read(THREAD)).effort).toBe(effort);
});

test.each([
  ["a thread id that differs from the file name", { ...SAVED, threadId: "someone-else" }, "threadId"],
  ["an effort that Claude does not offer", { ...SAVED, effort: "turbo" }, "effort must be low, medium, high, xhigh, max"],
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

  await expect(createClaudeThreadStore(directory).write({ ...SAVED, messages: [SAVED.messages[0] as StoredMessage, SAVED.messages[0] as StoredMessage] })).rejects.toThrow("alternate");

  expect(await readdir(directory)).toEqual([]);
});

test("a_thread_id_that_is_not_safe_in_a_file_name_is_rejected_before_any_path_is_built", async () => {
  const store = createClaudeThreadStore(await folder());

  await expect(store.read(asThreadId("../../etc/passwd"))).rejects.toThrow("thread id `../../etc/passwd` must be letters, digits and dashes");
});

test("list_returns_every_chat_with_its_title_and_modification_time_and_ignores_other_files", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write(SAVED);
  await store.write({ ...SAVED, threadId: asThreadId("second-chat"), forkedFrom: THREAD });
  await writeFile(join(directory, "notes.txt"), "not a thread");

  const listed = await store.list();

  expect(listed.map((entry) => [entry.threadId, entry.kind]).sort()).toEqual([[THREAD, "chat"], ["second-chat", "chat"]].sort());
  expect(listed.find((entry) => entry.threadId === THREAD)).toMatchObject({ kind: "chat", title: "what is lr?", forkedFrom: null, hasTurns: true });
  expect(listed.find((entry) => entry.threadId === "second-chat")).toMatchObject({ forkedFrom: THREAD });
  for (const entry of listed) expect(entry.updatedAtMs).toBeGreaterThan(0);
});

test("list_with_no_folder_yet_is_empty", async () => {
  const parent = await folder();

  expect(await createClaudeThreadStore(join(parent, "claude-threads")).list()).toEqual([]);
});

test("one_bad_chat_file_becomes_an_unreadable_entry_naming_the_file_and_the_others_still_list", async () => {
  const parent = await folder();
  await createClaudeThreadStore(parent).write(SAVED);
  await writeFile(join(parent, "broken.json"), "{}");

  const listed = await createClaudeThreadStore(parent).list();

  const broken = listed.find((entry) => entry.threadId === "broken");
  expect(broken).toMatchObject({ kind: "unreadable" });
  expect(broken?.kind === "unreadable" ? broken.problem : "").toContain(join(parent, "broken.json"));
  expect(listed.find((entry) => entry.threadId === THREAD)?.kind).toBe("chat");
  expect(await readFile(join(parent, `${THREAD}.json`), "utf8")).toContain(THREAD);
});

test("list_reads_only_the_small_index_so_a_chat_file_with_huge_content_is_never_parsed", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write(SAVED);
  await writeFile(join(directory, `${THREAD}.json`), `{ this is not json ${"A".repeat(1024)}`); // opening this chat would fail; listing must not open it

  const listed = await store.list();

  expect(listed.map((entry) => [entry.threadId, entry.kind])).toEqual([[THREAD, "chat"]]);
});

test("a_chat_with_no_index_is_indexed_from_its_file_once_and_then_listed_from_the_index", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write(SAVED);
  await rm(join(directory, `${THREAD}.index.json`));

  expect((await store.list())[0]).toMatchObject({ kind: "chat", title: "what is lr?" });

  expect(await readdir(directory)).toContain(`${THREAD}.index.json`);
});

test("an_index_without_its_chat_file_is_not_listed", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write(SAVED);
  await rm(join(directory, `${THREAD}.json`));

  expect(await store.list()).toEqual([]);
});

test("a_turn_with_servedBy_and_refused_is_read_back_and_other_values_are_rejected", async () => {
  const directory = await folder();
  const store = createClaudeThreadStore(directory);
  await store.write({ ...SAVED, turns: [{ turnId: asTurnId("turn-1"), userMessageIndex: 0, servedBy: "claude-opus-4-8", refused: true }] });

  expect((await store.read(THREAD)).turns).toEqual([{ turnId: "turn-1", userMessageIndex: 0, servedBy: "claude-opus-4-8", refused: true }]);
  for (const [turn, fragment] of [[{ servedBy: "" }, "servedBy"], [{ servedBy: 5 }, "servedBy"], [{ refused: false }, "refused"]] as const) {
    await writeFile(join(directory, `${THREAD}.json`), JSON.stringify({ ...SAVED, turns: [{ turnId: "turn-1", userMessageIndex: 0, ...turn }] }));
    await expect(store.read(THREAD)).rejects.toThrow(fragment);
  }
});

test("replay_messages_leave_out_exactly_the_refused_turns_and_keep_the_alternation", () => {
  const messages: Array<StoredMessage> = [0, 1, 2].flatMap((turn) => [
    { role: "user" as const, content: [{ type: "text" as const, text: `q${turn}` }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: `a${turn}` }] },
  ]);
  const turns = [0, 1, 2].map((turn) => ({ turnId: asTurnId(`t${turn}`), userMessageIndex: turn * 2, ...(turn === 1 ? { refused: true as const } : {}) }));

  const replayed = replayMessages({ ...SAVED, messages, turns });

  expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(JSON.stringify(replayed)).not.toContain("q1");
  expect(replayMessages({ ...SAVED, messages, turns: turns.map((turn) => ({ turnId: turn.turnId, userMessageIndex: turn.userMessageIndex })) })).toHaveLength(6);
});
