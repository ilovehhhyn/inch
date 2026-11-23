// Invariant: the main process accepts screen context only as a well-formed, bounded MARGIN SCREEN CONTEXT block or null.
import { expect, test } from "vitest";

import { MAX_ATTACHMENT_BYTES, MAX_CONTEXT_TEXT_CHARS, parseAttachmentFile, parseAttachmentIds, parseContextText, parseModelChoice, parseScreenContext, requireSavedDiffFolder } from "../../src/main/ipc-arguments";
import { renderContextBlock } from "../../src/shared/context-format";

const BLOCK = renderContextBlock({ paneKind: "diff", paneTitle: "repo", blocks: [{ label: "train.py line 39", text: "x" }] });

test("null_and_a_well_formed_block_are_accepted_unchanged", () => {
  expect(parseContextText(null)).toBeNull();
  expect(parseContextText(BLOCK)).toBe(BLOCK);
});

test("anything_else_is_rejected_with_the_fix", () => {
  expect(() => parseContextText(undefined)).toThrow(/contextText must be a string or null/);
  expect(() => parseContextText(5)).toThrow(/contextText must be a string or null/);
  expect(() => parseContextText("what is lr?")).toThrow(/contextText must be a MARGIN SCREEN CONTEXT block/);
});

test("a_block_longer_than_the_bound_is_rejected", () => {
  const huge = renderContextBlock({ paneKind: "chat", paneTitle: "t", blocks: [{ label: "a", text: "x".repeat(MAX_CONTEXT_TEXT_CHARS) }] });

  expect(() => parseContextText(huge)).toThrow(new RegExp(`at most ${MAX_CONTEXT_TEXT_CHARS} characters`));
});

test("a_diff_folder_other_than_the_saved_one_is_rejected", () => {
  expect(requireSavedDiffFolder("/Users/example/code/repo", "/Users/example/code/repo")).toBe("/Users/example/code/repo");
  expect(() => requireSavedDiffFolder("/etc", "/Users/example/code/repo")).toThrow(/diff folder \/etc is not the folder chosen in Margin/);
  expect(() => requireSavedDiffFolder("/etc", null)).toThrow(/no diff folder has been chosen/);
});

test("a_well_formed_block_parses_to_a_screen_context_that_renders_back_to_the_same_text", () => {
  const context = parseScreenContext(BLOCK);

  expect(context).toEqual({ paneKind: "diff", paneTitle: "repo", blocks: [{ label: "train.py line 39", text: "x" }] });
  expect(context === null ? null : renderContextBlock(context)).toBe(BLOCK);
});

test("a_null_context_stays_null_and_a_malformed_one_is_rejected_before_parsing", () => {
  expect(parseScreenContext(null)).toBeNull();
  expect(() => parseScreenContext("what is lr?")).toThrow(/contextText must be a MARGIN SCREEN CONTEXT block/);
});

test("a_model_choice_of_two_strings_is_accepted", () => {
  expect(parseModelChoice({ model: "claude-opus-5-5", reasoning: "high" })).toEqual({ model: "claude-opus-5-5", reasoning: "high" });
});

test.each([
  ["null", null],
  ["a string", "high"],
  ["a missing model", { reasoning: "high" }],
  ["an empty model", { model: "", reasoning: "high" }],
  ["a number for the reasoning", { model: "a", reasoning: 3 }],
  ["an extra key", { model: "a", reasoning: "high", extra: 1 }],
])("a_model_choice_with_%s_is_rejected_naming_the_fix", (_name, value) => {
  expect(() => parseModelChoice(value)).toThrow(/choice must be \{ model, reasoning \}/);
});

test("an_attachment_file_of_a_name_and_bytes_within_the_bound_is_accepted", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  expect(parseAttachmentFile("a.txt", bytes)).toEqual({ name: "a.txt", bytes });
  expect(MAX_ATTACHMENT_BYTES).toBe(32 * 1024 * 1024);
});

test.each([
  ["a name that is not a string", 5, new Uint8Array(1), "attachment name must be a string"],
  ["bytes that are not a Uint8Array", "a.txt", "text", "attachment bytes must be a Uint8Array"],
  ["bytes over the largest limit", "big.bin", { length: 0 }, "attachment bytes must be a Uint8Array"],
])("an_attachment_file_with_%s_is_rejected", (_name, name, bytes, fragment) => {
  expect(() => parseAttachmentFile(name, bytes)).toThrow(fragment);
});

test("bytes_over_the_largest_limit_are_rejected_before_classification", () => {
  expect(() => parseAttachmentFile("big.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toThrow("cannot attach `big.bin`; no file may be larger than 32 MB");
});

test("attachment_ids_are_a_short_list_of_strings", () => {
  expect(parseAttachmentIds([])).toEqual([]);
  expect(parseAttachmentIds(["a", "b"])).toEqual(["a", "b"]);
  expect(() => parseAttachmentIds("a")).toThrow("attachmentIds must be a list of strings");
  expect(() => parseAttachmentIds([1])).toThrow("attachmentIds must be a list of strings");
  expect(() => parseAttachmentIds(Array.from({ length: 11 }, (_, index) => String(index)))).toThrow("cannot attach more than 10 files");
});
