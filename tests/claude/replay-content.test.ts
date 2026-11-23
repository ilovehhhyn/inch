// Invariant: a stored assistant turn is replayed whole unless it crossed a fallback, and then the blocks the API says to leave out are left out and nothing else.
import type Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";

import { contentForReplay } from "../../src/claude/replay-content";

type Block = Anthropic.Beta.BetaContentBlock;

const thinking = (signature: string): Block => ({ type: "thinking", thinking: "", signature }) as Block;
const text = (value: string): Block => ({ type: "text", text: value, citations: null }) as Block;
const fallback = (to: string): Block => ({ type: "fallback", from: { model: "a" }, to: { model: to }, trigger: null }) as unknown as Block;

test("content_without_a_fallback_block_is_replayed_unchanged", () => {
  const content = [thinking("s"), text("answer")];

  expect(contentForReplay(content)).toEqual(content);
});

test("thinking_redacted_thinking_and_tool_use_before_the_fallback_block_are_left_out", () => {
  const redacted = { type: "redacted_thinking", data: "x" } as Block;
  const tool = { type: "tool_use", id: "t", name: "n", input: {} } as Block;
  const boundary = fallback("b");

  expect(contentForReplay([thinking("1"), text("kept"), redacted, tool, boundary, thinking("2"), text("after")])).toEqual([text("kept"), boundary, thinking("2"), text("after")]);
});

test("with_two_hops_only_the_final_boundary_decides_and_the_earlier_fallback_block_stays_in_place", () => {
  const first = fallback("b");
  const last = fallback("c");

  expect(contentForReplay([thinking("1"), first, thinking("2"), text("mid"), last, thinking("3"), text("end")])).toEqual([first, text("mid"), last, thinking("3"), text("end")]);
});

test("an_unrecognised_model_internal_block_before_the_boundary_is_left_out_and_after_it_kept", () => {
  const strange = { type: "model_internal_note", payload: 1 } as unknown as Block;
  const boundary = fallback("b");

  expect(contentForReplay([strange, boundary, strange])).toEqual([boundary, strange]);
});
