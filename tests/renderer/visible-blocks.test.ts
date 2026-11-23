// @vitest-environment jsdom
// Invariant: a pane reports exactly the blocks inside its visible rectangle, in document order, with positions clipped to the view.
import { expect, test } from "vitest";

import { asPaneId } from "../../src/renderer/context/pane-id";
import { readPane, registerPane } from "../../src/renderer/context/pane-registry";
import { readVisibleBlocks, MAX_LABEL_CHARS } from "../../src/renderer/context/visible-blocks";

const VIEW = { top: 100, bottom: 500 };

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

function place(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = () => rect(top, bottom);
}

function block(text: string, label: string, top: number, bottom: number, attributes: Readonly<Record<string, string>> = {}): HTMLElement {
  const element = document.createElement("p");
  element.textContent = text;
  element.setAttribute("data-context-block", "");
  element.setAttribute("data-context-label", label);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  place(element, top, bottom);
  return element;
}

function pane(...children: Array<Element>): HTMLElement {
  const container = document.createElement("div");
  place(container, VIEW.top, VIEW.bottom);
  container.append(...children);
  return container;
}

test("only_blocks_intersecting_the_view_are_returned", () => {
  const container = pane(block("above", "a", 0, 100), block("inside", "b", 150, 200), block("below", "c", 500, 560), block("far", "d", 900, 950));

  expect(readVisibleBlocks(container).map((found) => found.text)).toEqual(["inside"]);
});

test("blocks_keep_document_order", () => {
  const container = pane(block("first", "a", 120, 160), block("second", "b", 170, 210), block("third", "c", 220, 260));

  expect(readVisibleBlocks(container).map((found) => found.text)).toEqual(["first", "second", "third"]);
});

test("a_partly_visible_block_keeps_its_full_text_and_is_clipped_to_the_view", () => {
  const container = pane(block("cut at the top", "a", 40, 160), block("cut at the bottom", "b", 450, 700));

  const [top, bottom] = readVisibleBlocks(container);

  expect(top).toMatchObject({ text: "cut at the top", top: 0, bottom: 60 });
  expect(bottom).toMatchObject({ text: "cut at the bottom", top: 350, bottom: 400 });
});

test("positions_are_relative_to_the_pane_view", () => {
  const container = pane(block("x", "a", 250, 300));

  expect(readVisibleBlocks(container)[0]).toMatchObject({ top: 150, bottom: 200 });
});

test("nearest_heading_above_the_view_is_added_to_the_label", () => {
  const heading = block("3. Learning-rate schedule", "message 4 (assistant)", 20, 60, { "data-context-heading": "" });
  const body = block("Warm up for 500 steps.", "message 4 (assistant)", 150, 200);
  const message = document.createElement("article");
  message.setAttribute("data-context-scope", "");
  message.append(block("1. Setup", "message 4 (assistant)", -300, -260, { "data-context-heading": "" }), heading, body);
  const container = pane(message);

  expect(readVisibleBlocks(container)).toEqual([{ text: "Warm up for 500 steps.", label: 'message 4 (assistant), heading "3. Learning-rate schedule"', top: 50, bottom: 100 }]);
});

test("a_visible_heading_block_names_itself_and_a_headingless_block_keeps_its_label", () => {
  const heading = block("Result", "message 2 (assistant)", 120, 150, { "data-context-heading": "" });
  const plain = block("no heading in this scope", "train.py line 39", 200, 230);
  const container = pane(heading, plain);

  expect(readVisibleBlocks(container).map((found) => found.label)).toEqual(['message 2 (assistant), heading "Result"', "train.py line 39"]);
});

test("a_heading_in_another_message_is_not_used", () => {
  const first = document.createElement("article");
  first.setAttribute("data-context-scope", "");
  first.append(block("Old heading", "message 2 (assistant)", -100, -60, { "data-context-heading": "" }));
  const second = document.createElement("article");
  second.setAttribute("data-context-scope", "");
  second.append(block("Fresh answer.", "message 4 (assistant)", 150, 200));

  expect(readVisibleBlocks(pane(first, second))[0]?.label).toBe("message 4 (assistant)");
});

test("a_block_inside_another_block_is_not_reported_twice", () => {
  const outer = block("", "outer list item", 120, 260);
  const inner = block("inner paragraph", "inner paragraph", 130, 160);
  outer.textContent = "";
  outer.append(inner);
  place(outer, 120, 260);

  const found = readVisibleBlocks(pane(outer));

  expect(found.map((entry) => entry.label)).toEqual(["outer list item"]);
});

test("leading_spaces_are_kept_and_trailing_whitespace_is_dropped", () => {
  const container = pane(block("        return peak * step  \n", "train.py line 39", 120, 146));

  expect(readVisibleBlocks(container)[0]?.text).toBe("        return peak * step");
});

test("leading_blank_lines_are_dropped_but_the_first_lines_indentation_is_kept", () => {
  const container = pane(block("\n\n  Fix the model.\n", "message 2 (assistant)", 120, 146));

  expect(readVisibleBlocks(container)[0]?.text).toBe("  Fix the model.");
});

test("labels_are_one_line_and_at_most_the_label_limit", () => {
  const container = pane(block("x", `line one\nline two ${"y".repeat(MAX_LABEL_CHARS)}`, 120, 146));

  const label = readVisibleBlocks(container)[0]?.label ?? "";

  expect(label).not.toContain("\n");
  expect(label.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
});

test("a_block_without_a_label_is_rejected_with_the_fix", () => {
  const unlabeled = document.createElement("p");
  unlabeled.setAttribute("data-context-block", "");
  place(unlabeled, 120, 140);

  expect(() => readVisibleBlocks(pane(unlabeled))).toThrow(/data-context-label/);
});

test("the_registry_reads_a_registered_pane_and_forgets_it_after_unregister", () => {
  const id = asPaneId("diff");
  const unregister = registerPane(id, () => [{ text: "t", label: "l", top: 0, bottom: 10 }], "diff", { title: () => "diff · repo", viewportHeight: () => 430 });

  expect(readPane(id)).toEqual([{ text: "t", label: "l", top: 0, bottom: 10 }]);
  unregister();

  expect(() => readPane(id)).toThrow(/no pane registered as `diff`/);
});

test("registering_the_same_pane_twice_is_rejected_because_two_readers_would_disagree", () => {
  const id = asPaneId("main");
  const details = { title: () => "chat", viewportHeight: () => 800 };
  const unregister = registerPane(id, () => [], "chat", details);

  expect(() => registerPane(id, () => [], "chat", details)).toThrow(/already registered/);

  unregister();
});
