// @vitest-environment jsdom
// Invariant: each finished answer has a speaker button that reads it without its code, the answer to a spoken question is read only when the setting is on, and Escape stops the speech.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import type { SpeechEngine } from "../../src/renderer/voice/read-aloud";
import type { VoiceEnvironment } from "../../src/renderer/workspace";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";
import { installFakeLayout, userScroll } from "../fakes/fake-layout";

const OLD = asThreadId("old-1");
const WAV = Uint8Array.from([82, 73, 70, 70]);
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

const ANSWER = "Use a smaller step.\n\n```python\nlr = 0.1\nwd = 0.0\n```\n";

type Fake = Readonly<{ spoken: Array<string>; stops: { count: number }; stored: Map<string, string> }>;

function setup(initialSetting?: "on" | "off"): Readonly<{ voice: VoiceEnvironment; fake: Fake }> {
  const fake: Fake = { spoken: [], stops: { count: 0 }, stored: new Map(initialSetting === undefined ? [] : [["setting", initialSetting]]) };
  const speech: SpeechEngine = {
    speak: (text) => void fake.spoken.push(text),
    stop: () => {
      fake.stops.count += 1;
    },
  };
  return {
    fake,
    voice: {
      speech,
      readAloudSetting: { read: () => fake.stored.get("setting") === "on", write: (isOn) => void fake.stored.set("setting", isOn ? "on" : "off") },
      startRecording: async () => ({ stop: async () => WAV, cancel: () => undefined }),
    },
  };
}

async function openChat(api: FakeMarginApi, voice: VoiceEnvironment): Promise<HTMLElement> {
  api.threads = [{ id: OLD, provider: "codex", title: "Fine-tuning plan", updatedAtSec: 5 }];
  api.histories.set(OLD, [
    { turnId: asTurnId("t1"), role: "user", text: "why is it slow?", status: "done" },
    { turnId: asTurnId("t1"), role: "assistant", text: ANSWER, status: "done" },
  ]);
  render(<App api={api} voice={voice} />);
  await userEvent.click(await screen.findByRole("button", { name: "Fine-tuning plan" }));
  await screen.findByText("Use a smaller step.");
  const view = document.querySelector(".chat-pane .view");
  if (!(view instanceof HTMLElement)) throw new Error("the main pane did not render");
  return view;
}

async function pause(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

async function speak(api: FakeMarginApi, view: HTMLElement): Promise<void> {
  act(() => userScroll(view, 100));
  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  await pause(350);
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
}

function completeTurn(api: FakeMarginApi, text: string): void {
  act(() => {
    api.emitProvider({ type: "delta", threadId: OLD, turnId: asTurnId("turn-1"), text });
    api.emitProvider({ type: "completed", threadId: OLD, turnId: asTurnId("turn-1"), status: "completed", error: null });
  });
}

test("code_blocks_are_not_read_verbatim_when_the_speaker_button_is_pressed", async () => {
  const { voice, fake } = setup();
  await openChat(new FakeMarginApi(), voice);

  await userEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));

  expect(fake.spoken).toEqual(["Use a smaller step."]);
  expect(await screen.findByRole("button", { name: "Stop reading" })).toBeInTheDocument();
});

test("pressing_the_button_of_the_answer_being_read_stops_it", async () => {
  const { voice, fake } = setup();
  await openChat(new FakeMarginApi(), voice);
  await userEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));

  await userEvent.click(await screen.findByRole("button", { name: "Stop reading" }));

  expect(fake.stops.count).toBe(1);
  expect(await screen.findByRole("button", { name: "Read answer aloud" })).toBeInTheDocument();
});

test("escape_stops_speech", async () => {
  const { voice, fake } = setup();
  await openChat(new FakeMarginApi(), voice);
  await userEvent.click(screen.getByRole("button", { name: "Read answer aloud" }));

  await userEvent.keyboard("{Escape}");

  expect(fake.stops.count).toBe(1);
  expect(await screen.findByRole("button", { name: "Read answer aloud" })).toBeInTheDocument();
});

test("an_answer_that_is_still_streaming_has_no_speaker_button", async () => {
  const api = new FakeMarginApi();
  const { voice } = setup();
  await openChat(api, voice);
  await userEvent.type(screen.getByLabelText("Message"), "again{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "delta", threadId: OLD, turnId: asTurnId("turn-1"), text: "partial" }));

  expect(await screen.findByText("partial")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Read answer aloud" })).toHaveLength(1);
});

test("answers_to_typed_questions_are_not_read_by_default", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = setup("on");
  await openChat(api, voice);

  await userEvent.type(screen.getByLabelText("Message"), "typed question{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  completeTurn(api, "A typed answer.");

  await screen.findByText("A typed answer.");
  expect(fake.spoken).toEqual([]);
});

test("the_answer_to_a_spoken_question_is_read_when_the_setting_is_on", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = setup("on");
  const view = await openChat(api, voice);

  await speak(api, view);
  completeTurn(api, "Spoken answer.\n\n```sh\nls\n```");

  await waitFor(() => expect(fake.spoken).toEqual(["Spoken answer."]));
});

test("the_answer_to_a_spoken_question_is_not_read_when_the_setting_is_off", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = setup();
  const view = await openChat(api, voice);

  await speak(api, view);
  completeTurn(api, "Spoken answer.");

  await screen.findByText("Spoken answer.");
  expect(fake.spoken).toEqual([]);
});

test("a_failed_spoken_answer_is_not_read", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = setup("on");
  const view = await openChat(api, voice);

  await speak(api, view);
  act(() => api.emitProvider({ type: "completed", threadId: OLD, turnId: asTurnId("turn-1"), status: "failed", error: "Codex stopped" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Codex stopped");
  expect(fake.spoken).toEqual([]);
});

test("the_sidebar_setting_starts_from_the_saved_value_and_saves_a_change", async () => {
  const { voice, fake } = setup("on");
  await openChat(new FakeMarginApi(), voice);
  const box = screen.getByRole("checkbox", { name: "Read spoken answers aloud" });
  expect(box).toBeChecked();

  await userEvent.click(box);

  expect(box).not.toBeChecked();
  expect(fake.stored.get("setting")).toBe("off");
});

test("a_saved_setting_that_cannot_be_read_is_off_and_the_window_says_why", async () => {
  const { voice } = setup();
  const broken: VoiceEnvironment = {
    ...voice,
    readAloudSetting: {
      read: () => {
        throw new Error("the saved read-aloud setting is `maybe`; it must be on or off");
      },
      write: () => undefined,
    },
  };
  render(<App api={new FakeMarginApi()} voice={broken} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("the saved read-aloud setting is `maybe`");
  expect(screen.getByRole("checkbox", { name: "Read spoken answers aloud" })).not.toBeChecked();
});
