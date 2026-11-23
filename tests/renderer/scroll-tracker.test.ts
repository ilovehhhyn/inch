// @vitest-environment jsdom
// Invariant: a pane counts as scrolled only when user input caused the scroll, and the latest such pane since the last send wins.
import { expect, test } from "vitest";

import { asPaneId } from "../../src/renderer/context/pane-id";
import { createScrollTracker, USER_SCROLL_WINDOW_MS } from "../../src/renderer/context/scroll-tracker";

const MAIN = asPaneId("main");
const DIFF = asPaneId("diff");
const SIDE = asPaneId("side:thread-2");

function setup() {
  let now = 0;
  const tracker = createScrollTracker(() => now);
  const elements = new Map<string, HTMLElement>();
  const element = (id: string): HTMLElement => {
    const found = elements.get(id) ?? document.createElement("div");
    elements.set(id, found);
    return found;
  };
  return {
    tracker,
    element,
    at: (time: number): void => {
      now = time;
    },
  };
}

function scroll(element: HTMLElement): void {
  element.dispatchEvent(new Event("scroll"));
}

function pointerDown(element: HTMLElement, offsetX: number): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 500 });
  const event = new MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(event, "offsetX", { value: offsetX });
  element.dispatchEvent(event);
}

test("wheel_scroll_marks_the_pane", () => {
  const { tracker, element, at } = setup();
  tracker.attach(DIFF, element("diff"));

  at(100);
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));

  expect(tracker.choosePane(MAIN)).toBe(DIFF);
});

test("programmatic_scroll_does_not_mark_the_pane", () => {
  const { tracker, element } = setup();
  tracker.attach(MAIN, element("main"));

  element("main").scrollTop = 500;
  scroll(element("main"));

  expect(tracker.choosePane(null)).toBeNull();
});

test("a_scroll_after_the_input_window_has_closed_is_programmatic", () => {
  const { tracker, element, at } = setup();
  tracker.attach(MAIN, element("main"));

  at(0);
  element("main").dispatchEvent(new WheelEvent("wheel"));
  at(USER_SCROLL_WINDOW_MS);
  scroll(element("main"));
  expect(tracker.choosePane(null)).toBe(MAIN);

  tracker.markMessageSent();
  at(0);
  element("main").dispatchEvent(new WheelEvent("wheel"));
  at(USER_SCROLL_WINDOW_MS + 1);
  scroll(element("main"));
  expect(tracker.choosePane(null)).toBeNull();
});

test("only_scrolling_keys_count_as_user_input", () => {
  for (const key of ["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]) {
    const { tracker, element } = setup();
    tracker.attach(MAIN, element("main"));
    element("main").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    scroll(element("main"));
    expect(tracker.choosePane(null), `key ${JSON.stringify(key)}`).toBe(MAIN);
  }
  const { tracker, element } = setup();
  tracker.attach(MAIN, element("main"));
  element("main").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  scroll(element("main"));
  expect(tracker.choosePane(null)).toBeNull();
});

test("dragging_the_scrollbar_keeps_counting_until_the_pointer_is_released", () => {
  const { tracker, element, at } = setup();
  tracker.attach(DIFF, element("diff"));

  at(0);
  pointerDown(element("diff"), 495);
  at(5_000);
  scroll(element("diff"));
  expect(tracker.choosePane(null)).toBe(DIFF);

  tracker.markMessageSent();
  document.dispatchEvent(new MouseEvent("pointerup"));
  at(6_000);
  scroll(element("diff"));
  expect(tracker.choosePane(null)).toBeNull();
});

test("a_pointer_press_on_the_text_is_not_a_scrollbar_press", () => {
  const { tracker, element, at } = setup();
  tracker.attach(DIFF, element("diff"));

  at(0);
  pointerDown(element("diff"), 100);
  at(5_000);
  scroll(element("diff"));

  expect(tracker.choosePane(null)).toBeNull();
});

test("latest_of_two_panes_wins", () => {
  const { tracker, element, at } = setup();
  tracker.attach(SIDE, element("side"));
  tracker.attach(DIFF, element("diff"));

  at(50);
  element("side").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("side"));
  at(100);
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));

  expect(tracker.choosePane(MAIN)).toBe(DIFF);
});

test("auto_scroll_in_one_pane_while_the_user_scrolls_another_does_not_mark_the_first", () => {
  const { tracker, element, at } = setup();
  tracker.attach(MAIN, element("main"));
  tracker.attach(DIFF, element("diff"));

  at(10);
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));
  at(20);
  scroll(element("main"));

  expect(tracker.choosePane(null)).toBe(DIFF);
});

test("sending_resets_to_focus", () => {
  const { tracker, element, at } = setup();
  tracker.attach(DIFF, element("diff"));
  at(10);
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));

  tracker.markMessageSent();

  expect(tracker.choosePane(MAIN)).toBe(MAIN);
});

test("a_detached_pane_is_forgotten_and_its_input_no_longer_counts", () => {
  const { tracker, element, at } = setup();
  const detach = tracker.attach(DIFF, element("diff"));
  at(10);
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));

  detach();
  element("diff").dispatchEvent(new WheelEvent("wheel"));
  scroll(element("diff"));

  expect(tracker.choosePane(MAIN)).toBe(MAIN);
});

test("attaching_the_same_pane_twice_is_rejected", () => {
  const { tracker, element } = setup();
  tracker.attach(MAIN, element("main"));

  expect(() => tracker.attach(MAIN, element("other"))).toThrow(/already attached/);
});
