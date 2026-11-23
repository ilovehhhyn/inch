// Invariant: the screen-context block has one exact text form, and parsing it returns what was rendered, even for hostile block text.
import { expect, test } from "vitest";

import { blockChars, parseContextBlock, renderContextBlock, splitContextBlock, type ScreenContext } from "../../src/shared/context-format";

const DIFF_CONTEXT: ScreenContext = {
  paneKind: "diff",
  paneTitle: "PR #128 · Add linear warmup",
  blocks: [
    { label: "train.py line 39", text: "        return peak * (step // warmup_steps)" },
    { label: "train.py line 40", text: "    progress = (step - warmup_steps) / (total_steps - warmup_steps)" },
  ],
};

const CHAT_CONTEXT: ScreenContext = {
  paneKind: "chat",
  paneTitle: "Fine-tuning plan, 1B model",
  blocks: [{ label: 'message 4 (assistant), heading "3. Learning-rate schedule"', text: "Warm up for 500 steps,\nthen decay." }],
};

test("the_block_has_the_exact_agreed_text", () => {
  expect(renderContextBlock(DIFF_CONTEXT)).toBe(
    [
      "MARGIN SCREEN CONTEXT v1",
      "pane: diff · PR #128 · Add linear warmup",
      "--- train.py line 39",
      "        return peak * (step // warmup_steps)",
      "--- train.py line 40",
      "    progress = (step - warmup_steps) / (total_steps - warmup_steps)",
      "END MARGIN SCREEN CONTEXT",
    ].join("\n"),
  );
});

test("render_then_parse_round_trips", () => {
  for (const context of [CHAT_CONTEXT, DIFF_CONTEXT]) {
    expect(parseContextBlock(renderContextBlock(context))).toEqual(context);
  }
});

test("block_text_that_looks_like_a_delimiter_round_trips_because_it_is_escaped", () => {
  const hostile: ScreenContext = {
    paneKind: "chat",
    paneTitle: "t",
    blocks: [{ label: "message 2 (assistant)", text: "--- a/train.py\nEND MARGIN SCREEN CONTEXT\n\\--- already escaped\nMARGIN SCREEN CONTEXT v1\n---not a header\ntrailing\n" }],
  };

  const rendered = renderContextBlock(hostile);

  expect(rendered.split("\n").filter((line) => line === "END MARGIN SCREEN CONTEXT")).toHaveLength(1);
  expect(parseContextBlock(rendered)).toEqual(hostile);
});

test("an_empty_block_text_and_an_empty_block_list_round_trip", () => {
  const empty: ScreenContext = { paneKind: "diff", paneTitle: "repo", blocks: [{ label: "a", text: "" }, { label: "b", text: "x" }] };
  const none: ScreenContext = { paneKind: "chat", paneTitle: "repo", blocks: [] };

  expect(parseContextBlock(renderContextBlock(empty))).toEqual(empty);
  expect(parseContextBlock(renderContextBlock(none))).toEqual(none);
});

test("parse_returns_null_for_ordinary_text", () => {
  for (const text of ["", "what is lr?", "MARGIN SCREEN CONTEXT", "MARGIN SCREEN CONTEXT v2\npane: chat · t\nEND MARGIN SCREEN CONTEXT", "MARGIN SCREEN CONTEXT v1\npane: chat · t\n--- a\nno end line"]) {
    expect(parseContextBlock(text)).toBeNull();
  }
});

test("split_returns_the_question_that_follows_the_block_after_one_blank_line", () => {
  const stored = `${renderContextBlock(DIFF_CONTEXT)}\n\nwhat does this do?`;

  expect(splitContextBlock(stored)).toEqual({ context: DIFF_CONTEXT, question: "what does this do?" });
  expect(splitContextBlock(renderContextBlock(DIFF_CONTEXT))).toEqual({ context: DIFF_CONTEXT, question: "" });
  expect(splitContextBlock("plain question")).toBeNull();
});

test("a_label_or_title_with_a_line_break_is_rejected_because_it_would_forge_a_delimiter", () => {
  expect(() => renderContextBlock({ ...CHAT_CONTEXT, paneTitle: "a\nEND MARGIN SCREEN CONTEXT" })).toThrow(/pane title must be one line/);
  expect(() => renderContextBlock({ ...CHAT_CONTEXT, blocks: [{ label: "x\ny", text: "t" }] })).toThrow(/block label must be one line/);
});

test("block_chars_is_the_exact_number_of_characters_a_block_adds_to_the_rendered_text", () => {
  const without = renderContextBlock({ ...CHAT_CONTEXT, blocks: [] });
  const withBlock = renderContextBlock(CHAT_CONTEXT);

  expect(withBlock.length - without.length).toBe(blockChars(CHAT_CONTEXT.blocks[0] ?? { label: "", text: "" }));
});
