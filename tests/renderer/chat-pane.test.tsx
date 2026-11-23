// @vitest-environment jsdom
// Invariant: a thread renders its messages as plain markdown with no logo or product name, and follows the stream only from the bottom.
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, test } from "vitest";

import { ChatPane } from "../../src/renderer/components/ChatPane";
import { asPaneId } from "../../src/renderer/context/pane-id";
import { createScrollTracker } from "../../src/renderer/context/scroll-tracker";
import { ThreadStore } from "../../src/renderer/state/thread-store";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";

const THREAD = asThreadId("thread-1");
const TURN = asTurnId("turn-1");
const PANE = asPaneId("main");

function storeWith(answer: string): ThreadStore {
  const store = new ThreadStore();
  store.load(THREAD, [
    { turnId: TURN, role: "user", text: "what is lr?", status: "done" },
    { turnId: TURN, role: "assistant", text: answer, status: "done" },
  ]);
  return store;
}

test("answers_render_without_any_logo_or_assistant_name", () => {
  const { container } = render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith("The learning rate is the step size.")} />);

  expect(screen.getByText("The learning rate is the step size.")).toBeInTheDocument();
  expect(container.querySelector("img, svg, [role='img']")).toBeNull();
  expect(container.textContent).not.toMatch(/margin/i);
});

test("markdown_code_spans_render_as_code", () => {
  render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith("Set `lr` to **0.1** in `train.py`.")} />);

  const codes = screen.getAllByText((_, element) => element?.tagName === "CODE");
  expect(codes.map((element) => element.textContent)).toEqual(["lr", "train.py"]);
  expect(screen.getByText("0.1").tagName).toBe("STRONG");
});

test("raw_html_in_an_answer_is_shown_as_text_and_never_becomes_an_element", () => {
  const { container } = render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith('<img src="x" onerror="alert(1)"> and <script>alert(2)</script>')} />);

  expect(container.querySelector("img, script")).toBeNull();
  expect(container.textContent).toContain("<img");
});

test("the_scroll_container_is_exposed_through_the_ref_and_carries_the_pane_id", () => {
  const ref = createRef<HTMLDivElement>();

  render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith("a")} ref={ref} />);

  expect(ref.current).toBeInstanceOf(HTMLDivElement);
  expect(ref.current?.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("main");
});

function placeAtBottom(element: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
}

function streamOnto(store: ThreadStore, text: string): void {
  act(() => store.apply({ type: "delta", threadId: THREAD, turnId: asTurnId("turn-2"), text }));
}

test("streaming_follows_the_bottom_only_when_the_view_was_at_the_bottom", () => {
  const store = storeWith("a");
  const ref = createRef<HTMLDivElement>();
  render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={store} ref={ref} />);
  const element = ref.current;
  if (element === null) throw new Error("the scroll container did not mount");
  placeAtBottom(element, 1000);
  element.scrollTop = 600;
  act(() => {
    element.dispatchEvent(new Event("scroll"));
    store.begin(THREAD, { turnId: asTurnId("turn-2"), question: "again" });
  });
  placeAtBottom(element, 1200);

  streamOnto(store, "more");
  expect(element.scrollTop).toBe(1200);

  element.scrollTop = 100;
  act(() => {
    element.dispatchEvent(new Event("scroll"));
  });
  placeAtBottom(element, 1500);
  streamOnto(store, " and more");
  expect(element.scrollTop).toBe(100);
});

test("a_failed_turn_shows_its_error_as_an_alert", () => {
  const store = storeWith("a");
  store.begin(THREAD, { turnId: asTurnId("turn-2"), question: "again" });
  store.apply({ type: "completed", threadId: THREAD, turnId: asTurnId("turn-2"), status: "failed", error: "Codex stopped unexpectedly. Retry" });

  render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={store} />);

  expect(screen.getByRole("alert")).toHaveTextContent("Codex stopped unexpectedly. Retry");
});

const MARKED_ANSWER = "## 3. Learning-rate schedule\n\nWarm up for 500 steps.\n\n- first item\n- second item\n\n```python\nlr = 0.1\n```";

test("paragraphs_list_items_code_blocks_and_headings_are_labelled_context_blocks", () => {
  const { container } = render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith(MARKED_ANSWER)} />);

  const blocks = [...container.querySelectorAll("[data-context-block]")].map((element) => [element.tagName, element.getAttribute("data-context-label"), element.hasAttribute("data-context-heading")]);

  expect(blocks).toEqual([
    ["DIV", "message 1 (user)", false],
    ["H2", "message 2 (assistant)", true],
    ["P", "message 2 (assistant)", false],
    ["LI", "message 2 (assistant)", false],
    ["LI", "message 2 (assistant)", false],
    ["PRE", "message 2 (assistant)", false],
  ]);
  expect(container.querySelector("article")?.hasAttribute("data-context-scope")).toBe(true);
});

test("the_open_side_chat_button_is_not_part_of_any_context_block", () => {
  const { container } = render(<ChatPane paneId={PANE} label="Chat" title="Chat" tracker={createScrollTracker(() => 0)} threadId={THREAD} store={storeWith("a")} onOpenSideChat={() => undefined} />);

  expect(container.querySelector("button")?.closest("[data-context-block]")).toBeNull();
});
