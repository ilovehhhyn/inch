// Invariant: a side chat shows only the messages after the turn it was forked from, and refuses a history that lacks that turn.
import { expect, test } from "vitest";

import { asTurnId } from "../../src/shared/provider-events";
import { messagesAfterTurn, type DisplayMessage } from "../../src/shared/thread-history";

function pair(turn: string): Array<DisplayMessage> {
  return [
    { turnId: asTurnId(turn), role: "user", text: `q ${turn}`, status: "done" },
    { turnId: asTurnId(turn), role: "assistant", text: `a ${turn}`, status: "done" },
  ];
}

test("messages_after_the_fork_turn_are_kept_and_the_inherited_ones_dropped", () => {
  const history = [...pair("t1"), ...pair("t2"), ...pair("t3")];

  expect(messagesAfterTurn(history, asTurnId("t2")).map((message) => message.text)).toEqual(["q t3", "a t3"]);
});

test("a_fork_through_the_last_turn_has_no_messages_yet", () => {
  expect(messagesAfterTurn([...pair("t1")], asTurnId("t1"))).toEqual([]);
});

test("a_history_without_the_fork_turn_is_rejected_with_the_fix", () => {
  expect(() => messagesAfterTurn(pair("t1"), asTurnId("t9"))).toThrow(/does not contain turn t9; open the chat it was forked from or close this side chat/);
});
