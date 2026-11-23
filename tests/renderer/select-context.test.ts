// Invariant: the selected blocks are the ones nearest the pane's centre, never exceed the character budget, and keep document order.
import { expect, test } from "vitest";

import { CONTEXT_BUDGET_CHARS, selectContext } from "../../src/renderer/context/select-context";
import { blockChars } from "../../src/shared/context-format";
import type { VisibleBlock } from "../../src/renderer/context/visible-blocks";

const HEIGHT = 800;

function at(text: string, label: string, top: number, bottom: number): VisibleBlock {
  return { text, label, top, bottom };
}

function totalChars(blocks: ReadonlyArray<VisibleBlock>): number {
  return blocks.reduce((sum, block) => sum + blockChars(block), 0);
}

test("centre_block_is_always_kept_even_when_the_budget_holds_nothing_else", () => {
  const blocks = [at("top", "a", 0, 40), at("centre", "b", 380, 420), at("bottom", "c", 760, 800)];

  const chosen = selectContext(blocks, HEIGHT, blockChars(blocks[1] ?? at("", "", 0, 0)));

  expect(chosen.map((block) => block.text)).toEqual(["centre"]);
});

test("result_never_exceeds_the_budget", () => {
  for (const size of [0, 1, CONTEXT_BUDGET_CHARS - 1, CONTEXT_BUDGET_CHARS, CONTEXT_BUDGET_CHARS + 1]) {
    const blocks = [at("x".repeat(size), "message 2 (assistant)", 300, 500), at("y".repeat(size), "message 3 (assistant)", 100, 200)];

    const chosen = selectContext(blocks, HEIGHT, CONTEXT_BUDGET_CHARS);

    expect(totalChars(chosen)).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
    expect(chosen.length).toBeGreaterThanOrEqual(1);
  }
});

test("a_5000_line_pane_is_trimmed_to_the_budget_around_its_centre", () => {
  const blocks = Array.from({ length: 5000 }, (_, index) => at(`    line ${index} of a long diff`, `train.py line ${index}`, (index * 800) / 5000, ((index + 1) * 800) / 5000));

  const chosen = selectContext(blocks, HEIGHT, CONTEXT_BUDGET_CHARS);

  expect(totalChars(chosen)).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
  expect(chosen.some((block) => block.label === "train.py line 2500")).toBe(true);
  expect(chosen.length).toBeLessThan(5000);
});

test("huge_single_block_is_truncated_not_dropped", () => {
  const huge = at("z".repeat(50_000), "message 2 (assistant)", 0, 800);

  const [chosen] = selectContext([huge], HEIGHT, CONTEXT_BUDGET_CHARS);

  expect(chosen?.text.startsWith("zzz")).toBe(true);
  expect(chosen?.text.endsWith("[truncated]")).toBe(true);
  expect(blockChars(chosen ?? huge)).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
  expect(chosen?.label).toBe(huge.label);
});

test("output_is_in_document_order", () => {
  const blocks = [at("a", "a", 0, 100), at("b", "b", 150, 250), at("c", "c", 350, 450), at("d", "d", 500, 600), at("e", "e", 700, 800)];

  const chosen = selectContext(blocks, HEIGHT, CONTEXT_BUDGET_CHARS);

  expect(chosen.map((block) => block.text)).toEqual(["a", "b", "c", "d", "e"]);
});

test("blocks_are_added_by_weight_and_the_first_one_that_does_not_fit_ends_the_selection", () => {
  const near = at("n".repeat(100), "near", 360, 440);
  const big = at("b".repeat(500), "big", 200, 280);
  const small = at("s", "small", 0, 20);
  const budget = blockChars(near) + blockChars(small) + 5;

  const chosen = selectContext([small, big, near], HEIGHT, budget);

  expect(chosen.map((block) => block.label)).toEqual(["near"]);
});

test("equal_weights_prefer_the_earlier_block", () => {
  const first = at("first", "first", 380, 420);
  const second = at("second", "second", 380, 420);

  expect(selectContext([first, second], HEIGHT, blockChars(first)).map((block) => block.label)).toEqual(["first"]);
});

test("a_partly_visible_block_is_weighted_by_its_visible_part_only", () => {
  const clippedAtTop = at("clipped", "clipped", 0, 60);
  const lower = at("lower", "lower", 300, 340);

  expect(selectContext([clippedAtTop, lower], HEIGHT, blockChars(lower)).map((block) => block.label)).toEqual(["lower"]);
});

test("an_empty_pane_gives_no_blocks", () => {
  expect(selectContext([], HEIGHT, CONTEXT_BUDGET_CHARS)).toEqual([]);
});

test("an_unusable_height_or_budget_is_rejected_with_the_fix", () => {
  const block = at("x".repeat(100), "a", 0, 10);

  expect(() => selectContext([block], 0, CONTEXT_BUDGET_CHARS)).toThrow(/viewport height must be positive/);
  expect(() => selectContext([block], HEIGHT, 10)).toThrow(/budget of 10 characters cannot hold/);
});
