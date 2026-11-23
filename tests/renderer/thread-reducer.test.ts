// Invariant: the reducer shows each provider event on the message of the active turn and ignores every other turn.
import { expect, test } from "vitest";

import { beginTurn, EMPTY_THREAD, reduceThread, type ThreadView } from "../../src/renderer/state/thread-reducer";
import { asThreadId, asTurnId, type ProviderEvent } from "../../src/shared/provider-events";

const THREAD = asThreadId("thread-1");
const TURN = asTurnId("turn-1");

function delta(text: string, turnId = TURN, threadId = THREAD): ProviderEvent {
  return { type: "delta", threadId, turnId, text };
}

function started(): ThreadView {
  return beginTurn(EMPTY_THREAD, { turnId: TURN, question: "what is lr?" });
}

test("begin_turn_adds_the_user_message_and_an_empty_streaming_answer", () => {
  const view = started();

  expect(view.activeTurn).toBe(TURN);
  expect(view.messages).toEqual([
    { id: "turn-1:user", role: "user", text: "what is lr?", status: "done" },
    { id: "turn-1:assistant", role: "assistant", text: "", status: "streaming" },
  ]);
});

test("deltas_append_to_the_streaming_message_in_order", () => {
  const view = ["The ", "learning ", "rate"].reduce((state, text) => reduceThread(state, delta(text)), started());

  expect(view.messages).toHaveLength(2);
  expect(view.messages[1]).toMatchObject({ role: "assistant", text: "The learning rate", status: "streaming" });
});

test("deltas_for_another_thread_are_ignored", () => {
  const before = started();

  const after = reduceThread(before, delta("stray", asTurnId("turn-9"), asThreadId("thread-9")));

  expect(after).toBe(before);
});

test("deltas_before_any_turn_started_are_ignored", () => {
  expect(reduceThread(EMPTY_THREAD, delta("stray"))).toBe(EMPTY_THREAD);
});

test("turn_completed_marks_the_message_done_and_clears_the_active_turn", () => {
  const streamed = reduceThread(started(), delta("answer"));

  const view = reduceThread(streamed, { type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null });

  expect(view.activeTurn).toBeNull();
  expect(view.error).toBeNull();
  expect(view.messages[1]).toMatchObject({ text: "answer", status: "done" });
});

test("turn_completed_failed_marks_the_message_failed_with_the_error_text", () => {
  const streamed = reduceThread(started(), delta("partial"));

  const view = reduceThread(streamed, { type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: "Codex stopped unexpectedly. Retry" });

  expect(view.activeTurn).toBeNull();
  expect(view.error).toBe("Codex stopped unexpectedly. Retry");
  expect(view.messages[1]).toMatchObject({ text: "partial", status: "failed" });
});

test("a_failed_turn_without_an_error_text_still_reports_an_error", () => {
  const view = reduceThread(started(), { type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: null });

  expect(view.error).toBe("The turn failed without a reason from the provider");
  expect(view.messages[1]).toMatchObject({ status: "failed" });
});

test("a_refused_turn_is_failed_with_the_provider_reason", () => {
  const view = reduceThread(started(), { type: "completed", threadId: THREAD, turnId: TURN, status: "refused", error: "declined by safety policy" });

  expect(view.error).toBe("declined by safety policy");
  expect(view.messages[1]).toMatchObject({ status: "failed" });
});

test("an_interrupted_turn_keeps_the_partial_text_as_done_without_an_error", () => {
  const streamed = reduceThread(started(), delta("half an ans"));

  const view = reduceThread(streamed, { type: "completed", threadId: THREAD, turnId: TURN, status: "interrupted", error: null });

  expect(view.activeTurn).toBeNull();
  expect(view.error).toBeNull();
  expect(view.messages[1]).toMatchObject({ text: "half an ans", status: "done" });
});

test("completion_of_another_turn_is_ignored", () => {
  const before = started();

  const after = reduceThread(before, { type: "completed", threadId: THREAD, turnId: asTurnId("turn-9"), status: "failed", error: "x" });

  expect(after).toBe(before);
});

test("account_changes_do_not_alter_the_thread", () => {
  const before = started();

  expect(reduceThread(before, { type: "accountChanged", provider: "codex" })).toBe(before);
});

test("begin_turn_while_a_turn_is_active_is_an_error", () => {
  expect(() => beginTurn(started(), { turnId: asTurnId("turn-2"), question: "again" })).toThrow(/turn-1 is still active; wait for it or interrupt it/);
});

test("a_new_turn_after_a_failure_clears_the_old_error_and_keeps_the_history", () => {
  const failed = reduceThread(started(), { type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: "boom" });

  const view = beginTurn(failed, { turnId: asTurnId("turn-2"), question: "retry" });

  expect(view.error).toBeNull();
  expect(view.messages.map((message) => message.id)).toEqual(["turn-1:user", "turn-1:assistant", "turn-2:user", "turn-2:assistant"]);
});

test("the_reducer_does_not_modify_the_state_it_is_given", () => {
  const before = started();
  const snapshot = JSON.stringify(before);

  reduceThread(before, delta("x"));

  expect(JSON.stringify(before)).toBe(snapshot);
});
