// Invariant: a stored thread becomes the user's questions and the assistant's answers, in order, with failed turns marked.
import { expect, test } from "vitest";

import { listChats, summarizeThread, toHistory } from "../../src/codex/thread-history";
import { renderContextBlock } from "../../src/shared/context-format";
import type { Thread } from "../../src/codex/generated/v2/Thread";
import type { ThreadItem } from "../../src/codex/generated/v2/ThreadItem";
import type { Turn } from "../../src/codex/generated/v2/Turn";

function userItem(...texts: Array<string>): ThreadItem {
  return { type: "userMessage", id: "u", clientId: null, content: texts.map((text) => ({ type: "text" as const, text, text_elements: [] })) };
}

function answerItem(text: string): ThreadItem {
  return { type: "agentMessage", id: "a", text, phase: null, memoryCitation: null };
}

function turn(id: string, status: Turn["status"], items: Array<ThreadItem>): Turn {
  return { id, items, itemsView: "full", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}

function thread(turns: Array<Turn>, fields: Partial<Thread> = {}): Thread {
  return { id: "thread-1", preview: "", name: null, forkedFromId: null, updatedAt: 100, turns, ...fields } as Thread; // the fixture sets only the fields the code reads
}

test("each_turn_becomes_a_user_message_then_an_assistant_message", () => {
  const history = toHistory(thread([turn("t1", "completed", [userItem("what is lr?"), answerItem("The step size.")]), turn("t2", "completed", [userItem("and wd?"), answerItem("Weight decay.")])]));

  expect(history.map((message) => [message.turnId, message.role, message.text, message.status])).toEqual([
    ["t1", "user", "what is lr?", "done"],
    ["t1", "assistant", "The step size.", "done"],
    ["t2", "user", "and wd?", "done"],
    ["t2", "assistant", "Weight decay.", "done"],
  ]);
});

test("a_failed_turn_marks_its_answer_failed_and_an_interrupted_turn_is_done", () => {
  const history = toHistory(thread([turn("t1", "failed", [userItem("q"), answerItem("partial")]), turn("t2", "interrupted", [userItem("q2"), answerItem("cut")])]));

  expect(history.filter((message) => message.role === "assistant").map((message) => message.status)).toEqual(["failed", "done"]);
});

test("a_turn_still_in_progress_is_rejected_because_the_window_cannot_show_a_half_turn", () => {
  expect(() => toHistory(thread([turn("t1", "inProgress", [userItem("q")])]))).toThrow(/turn t1 is still in progress/);
});

test("items_other_than_messages_are_skipped_and_text_items_are_joined_without_a_separator", () => {
  const other = { type: "reasoning", id: "r", summary: [], content: [] } as unknown as ThreadItem; // an item kind the window does not show
  const history = toHistory(thread([turn("t1", "completed", [userItem("one ", "two"), other, answerItem("a1"), answerItem("a2")])]));

  expect(history.map((message) => message.text)).toEqual(["one two", "a1\n\na2"]);
});

test("a_turn_with_no_answer_yet_has_only_its_user_message", () => {
  expect(toHistory(thread([turn("t1", "failed", [userItem("q")])])).map((message) => message.role)).toEqual(["user"]);
});

test("the_title_is_the_thread_name_or_the_first_line_of_the_preview_and_never_empty", () => {
  expect(summarizeThread(thread([], { name: "Fine-tuning plan", preview: "ignored" })).title).toBe("Fine-tuning plan");
  expect(summarizeThread(thread([], { preview: "what is lr?\nmore detail" })).title).toBe("what is lr?");
  expect(summarizeThread(thread([], { preview: "   " })).title).toBe("New chat");
  expect(summarizeThread(thread([], { preview: "x".repeat(200) })).title).toHaveLength(60);
  expect(summarizeThread(thread([], { id: "t9", updatedAt: 7 }))).toMatchObject({ id: "t9", provider: "codex", updatedAtSec: 7 });
});

const CONTEXT = renderContextBlock({ paneKind: "chat", paneTitle: "Plan", blocks: [{ label: "message 2 (assistant)", text: "Warm up for 500 steps." }] });

test("reloaded_thread_hides_the_context_item", () => {
  const stored = turn("t1", "completed", [userItem(`${CONTEXT}\n\n`, "why 500?"), answerItem("It is 5% of training.")]);

  const history = toHistory(thread([stored]));

  expect(history.map((message) => message.text)).toEqual(["why 500?", "It is 5% of training."]);
  expect(JSON.stringify(history)).not.toContain("MARGIN SCREEN CONTEXT");
});

test("a_user_message_that_merely_mentions_the_marker_is_shown_unchanged", () => {
  const history = toHistory(thread([turn("t1", "completed", [userItem("what does MARGIN SCREEN CONTEXT v1 mean?"), answerItem("a")])]));

  expect(history[0]?.text).toBe("what does MARGIN SCREEN CONTEXT v1 mean?");
});

test("the_chat_list_title_skips_the_context_block_and_never_shows_a_cut_one", () => {
  expect(summarizeThread(thread([], { preview: `${CONTEXT}\n\nwhy 500?` })).title).toBe("why 500?");
  expect(summarizeThread(thread([], { preview: CONTEXT.slice(0, 40) })).title).toBe("New chat");
});

test("the_chat_list_leaves_out_forked_side_chats_and_lists_newest_first", () => {
  const main = thread([], { id: "main-1", updatedAt: 10 });
  const side = thread([], { id: "side-1", updatedAt: 30, forkedFromId: "main-1" });
  const newer = thread([], { id: "main-2", updatedAt: 20 });

  expect(listChats([main, side, newer]).map((chat) => chat.id)).toEqual(["main-2", "main-1"]);
});
