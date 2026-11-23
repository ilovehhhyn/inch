// Invariant: provider events that arrive before the window knows its turn are applied once the turn begins, never lost or misapplied.
import { expect, test } from "vitest";

import { ThreadStore } from "../../src/renderer/state/thread-store";
import { asThreadId, asTurnId, type ProviderEvent } from "../../src/shared/provider-events";

const THREAD = asThreadId("thread-1");
const TURN = asTurnId("turn-1");

function delta(text: string, turnId = TURN, threadId = THREAD): ProviderEvent {
  return { type: "delta", threadId, turnId, text };
}

test("deltas_that_arrive_before_the_turn_begins_are_replayed_in_order", () => {
  const store = new ThreadStore();
  store.apply(delta("The "));
  store.apply(delta("answer"));
  store.apply({ type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null });

  store.begin(THREAD, { turnId: TURN, question: "what is lr?" });

  const view = store.view(THREAD);
  expect(view.messages.map((message) => message.text)).toEqual(["what is lr?", "The answer"]);
  expect(view.activeTurn).toBeNull();
  expect(view.messages[1]?.status).toBe("done");
});

test("a_delta_for_another_turn_is_ignored_while_a_turn_is_active", () => {
  const store = new ThreadStore();
  store.begin(THREAD, { turnId: TURN, question: "q" });

  store.apply(delta("stray", asTurnId("turn-9")));
  store.apply(delta("real"));
  store.begin(asThreadId("thread-2"), { turnId: asTurnId("turn-9"), question: "other" });

  expect(store.view(THREAD).messages[1]?.text).toBe("real");
  expect(store.view(asThreadId("thread-2")).messages[1]?.text).toBe("");
});

test("subscribers_are_notified_on_every_change_and_stop_after_unsubscribe", () => {
  const store = new ThreadStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });

  store.begin(THREAD, { turnId: TURN, question: "q" });
  store.apply(delta("a"));
  unsubscribe();
  store.apply(delta("b"));

  expect(calls).toBe(2);
});

test("view_returns_the_same_object_until_the_thread_changes", () => {
  const store = new ThreadStore();
  store.begin(THREAD, { turnId: TURN, question: "q" });
  const before = store.view(THREAD);

  expect(store.view(THREAD)).toBe(before);
  store.apply(delta("a"));

  expect(store.view(THREAD)).not.toBe(before);
});

test("load_replaces_a_thread_with_its_stored_messages_and_marks_it_loaded", () => {
  const store = new ThreadStore();

  expect(store.isLoaded(THREAD)).toBe(false);
  store.load(THREAD, [
    { turnId: TURN, role: "user", text: "q", status: "done" },
    { turnId: TURN, role: "assistant", text: "a", status: "failed" },
  ]);

  expect(store.isLoaded(THREAD)).toBe(true);
  expect(store.view(THREAD).messages).toEqual([
    { id: "turn-1:user", turnId: TURN, role: "user", text: "q", status: "done" },
    { id: "turn-1:assistant", turnId: TURN, role: "assistant", text: "a", status: "failed" },
  ]);
  expect(store.view(THREAD).activeTurn).toBeNull();
});

test("beginning_a_turn_while_another_is_active_is_rejected_and_changes_nothing", () => {
  const store = new ThreadStore();
  store.begin(THREAD, { turnId: TURN, question: "q" });
  const before = store.view(THREAD);

  expect(() => store.begin(THREAD, { turnId: asTurnId("turn-2"), question: "again" })).toThrow(/still active/);

  expect(store.view(THREAD)).toBe(before);
});
