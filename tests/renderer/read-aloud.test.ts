// @vitest-environment jsdom
// Invariant: an answer is spoken without its code, only on request or for a spoken question when the setting is on, and Escape stops the speech at once.
import { expect, test } from "vitest";

import {
  createReadAloud,
  createReadAloudSetting,
  READ_ANSWERS_ALOUD_DEFAULT,
  shouldReadAnswer,
  speakableParagraphs,
  type SpeechEngine,
} from "../../src/renderer/voice/read-aloud";

class FakeEngine implements SpeechEngine {
  readonly spoken: Array<string> = [];
  stops = 0;
  private finish: Array<() => void> = [];
  private fail: Array<(message: string) => void> = [];
  speak(text: string, handlers: Readonly<{ onEnd: () => void; onError: (message: string) => void }>): void {
    this.spoken.push(text);
    this.finish.push(handlers.onEnd);
    this.fail.push(handlers.onError);
  }
  stop(): void {
    this.stops += 1;
    this.finish = [];
    this.fail = [];
  }
  /** Ends the utterance that was spoken first and has not ended yet. */
  end(): void {
    this.fail.shift();
    this.finish.shift()?.();
  }
  error(message: string): void {
    this.finish.shift();
    this.fail.shift()?.(message);
  }
}

const ANSWER = ["The warmup divides by `warmup_steps`, so step 0 gives a rate of 0.", "", "```python", "def get_lr(step):", "    return peak * (step // warmup_steps)", "```", "", "Use `step / warmup_steps` instead."].join("\n");

test("code_blocks_are_not_read_verbatim", () => {
  expect(speakableParagraphs(ANSWER)).toEqual(["The warmup divides by warmup_steps, so step 0 gives a rate of 0.", "code block, 2 lines", "Use step / warmup_steps instead."]);
});

test("a_one_line_block_says_line_in_the_singular_and_tildes_and_a_language_tag_are_fences_too", () => {
  expect(speakableParagraphs("```\nx = 1\n```")).toEqual(["code block, 1 line"]);
  expect(speakableParagraphs("~~~sh\nls\npwd\n~~~")).toEqual(["code block, 2 lines"]);
});

test("a_block_that_never_closes_is_still_replaced_so_code_is_never_read", () => {
  expect(speakableParagraphs("Intro.\n\n```python\nprint(1)\nprint(2)")).toEqual(["Intro.", "code block, 2 lines"]);
});

test("markdown_marks_are_dropped_and_links_keep_their_words", () => {
  const text = ["# Fix", "", "- **First** item", "- second item", "", "> a quote", "", "See [the docs](https://example.com/docs) and ![chart](x.png)."].join("\n");

  expect(speakableParagraphs(text)).toEqual(["Fix", "First item second item", "a quote", "See the docs and chart."]);
});

test("empty_answers_have_nothing_to_speak", () => {
  expect(speakableParagraphs("   \n\n")).toEqual([]);
});

test("answers_to_typed_questions_are_not_read_by_default", () => {
  expect(READ_ANSWERS_ALOUD_DEFAULT).toBe(false);
  expect(shouldReadAnswer({ readAloudOn: READ_ANSWERS_ALOUD_DEFAULT, wasSpoken: false })).toBe(false);
  expect(shouldReadAnswer({ readAloudOn: true, wasSpoken: false })).toBe(false);
});

test("a_spoken_questions_answer_is_read_only_when_the_setting_is_on", () => {
  expect(shouldReadAnswer({ readAloudOn: true, wasSpoken: true })).toBe(true);
  expect(shouldReadAnswer({ readAloudOn: false, wasSpoken: true })).toBe(false);
});

test("toggle_speaks_each_paragraph_in_turn_and_reports_who_is_speaking", () => {
  const engine = new FakeEngine();
  const states: Array<string | null> = [];
  const readAloud = createReadAloud(engine, (id) => states.push(id));

  readAloud.toggle("turn-1:assistant", ANSWER);
  expect(engine.spoken).toEqual(["The warmup divides by warmup_steps, so step 0 gives a rate of 0."]);
  engine.end();
  engine.end();
  engine.end();

  expect(engine.spoken).toEqual(["The warmup divides by warmup_steps, so step 0 gives a rate of 0.", "code block, 2 lines", "Use step / warmup_steps instead."]);
  expect(states).toEqual(["turn-1:assistant", null]);
});

test("toggling_the_answer_that_is_speaking_stops_it", () => {
  const engine = new FakeEngine();
  const readAloud = createReadAloud(engine, () => undefined);
  readAloud.toggle("a", "Hello there.");

  readAloud.toggle("a", "Hello there.");

  expect(engine.stops).toBeGreaterThan(0);
  expect(readAloud.speakingId()).toBeNull();
});

test("speaking_another_answer_replaces_the_first", () => {
  const engine = new FakeEngine();
  const readAloud = createReadAloud(engine, () => undefined);
  readAloud.toggle("a", "First answer.");

  readAloud.toggle("b", "Second answer.");

  expect(readAloud.speakingId()).toBe("b");
  expect(engine.spoken).toEqual(["First answer.", "Second answer."]);
});

test("escape_stops_speech", () => {
  const engine = new FakeEngine();
  const readAloud = createReadAloud(engine, () => undefined);
  const target = new EventTarget();
  const detach = readAloud.attachEscape(target);
  readAloud.toggle("a", "A long answer.");

  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  expect(readAloud.speakingId()).toBeNull();
  expect(engine.stops).toBeGreaterThan(0);
  detach();
});

test("escape_with_nothing_speaking_does_nothing_and_other_keys_do_not_stop_speech", () => {
  const engine = new FakeEngine();
  const readAloud = createReadAloud(engine, () => undefined);
  const target = new EventTarget();
  readAloud.attachEscape(target);

  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  const stopsWhileIdle = engine.stops;
  readAloud.toggle("a", "A long answer.");
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

  expect(stopsWhileIdle).toBe(0);
  expect(readAloud.speakingId()).toBe("a");
});

test("a_detached_escape_listener_no_longer_stops_speech", () => {
  const readAloud = createReadAloud(new FakeEngine(), () => undefined);
  const target = new EventTarget();
  readAloud.attachEscape(target)();
  readAloud.toggle("a", "A long answer.");

  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  expect(readAloud.speakingId()).toBe("a");
});

test("an_engine_error_stops_the_queue_and_reports_the_reason", () => {
  const engine = new FakeEngine();
  const errors: Array<string> = [];
  const readAloud = createReadAloud(engine, () => undefined, (message) => errors.push(message));
  readAloud.toggle("a", "One.\n\nTwo.");

  engine.error("synthesis-failed");

  expect(errors).toEqual(["Could not read the answer aloud: synthesis-failed"]);
  expect(readAloud.speakingId()).toBeNull();
  expect(engine.spoken).toEqual(["One."]);
});

test("an_answer_with_nothing_to_say_is_not_spoken_and_leaves_nobody_speaking", () => {
  const engine = new FakeEngine();
  const readAloud = createReadAloud(engine, () => undefined);

  readAloud.toggle("a", "   ");

  expect(engine.spoken).toEqual([]);
  expect(readAloud.speakingId()).toBeNull();
});

function memoryStorage(initial?: string): Readonly<{ storage: Pick<Storage, "getItem" | "setItem">; values: Map<string, string> }> {
  const values = new Map<string, string>(initial === undefined ? [] : [["margin.readAnswersAloud", initial]]);
  return { values, storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) } };
}

test("the_setting_is_off_until_it_is_switched_on_and_is_remembered", () => {
  const { storage, values } = memoryStorage();
  const setting = createReadAloudSetting(storage);

  expect(setting.read()).toBe(false);
  setting.write(true);

  expect(values.get("margin.readAnswersAloud")).toBe("on");
  expect(createReadAloudSetting(storage).read()).toBe(true);
  setting.write(false);
  expect(createReadAloudSetting(storage).read()).toBe(false);
});

test("a_stored_value_other_than_on_or_off_is_an_error_naming_the_fix", () => {
  const { storage } = memoryStorage("maybe");

  expect(() => createReadAloudSetting(storage).read()).toThrow("the saved read-aloud setting is `maybe`; it must be on or off, so switch the setting again to repair it");
});
