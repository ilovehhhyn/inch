// @vitest-environment jsdom
// Invariant: a message spoken with the right option key is sent exactly like a Command-I message, with the context read when the key went down, and a failed or refused recording leaves the chat unchanged.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { BUSY_HINT } from "../../src/renderer/components/Composer";
import { MICROPHONE_DENIED_MESSAGE } from "../../src/renderer/voice/push-to-talk";
import type { VoiceEnvironment } from "../../src/renderer/workspace";
import { renderContextBlock } from "../../src/shared/context-format";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import type { DisplayMessage } from "../../src/shared/thread-history";
import { CODEX_DEFAULT_CHOICE, FakeMarginApi } from "../fakes/fake-margin-api";
import { installFakeLayout, userScroll } from "../fakes/fake-layout";

const OLD = asThreadId("old-1");
const WAV = Uint8Array.from([82, 73, 70, 70]);
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

function threeExchanges(): Array<DisplayMessage> {
  return [1, 2, 3].flatMap((n) => [
    { turnId: asTurnId(`t${n}`), role: "user" as const, text: `question ${n}`, status: "done" as const },
    { turnId: asTurnId(`t${n}`), role: "assistant" as const, text: `answer ${n}`, status: "done" as const },
  ]);
}

type Fake = Readonly<{ started: { count: number }; recording: { stopped: boolean; cancelled: boolean } }>;

function fakeVoice(): Readonly<{ voice: VoiceEnvironment; fake: Fake }> {
  const fake: Fake = { started: { count: 0 }, recording: { stopped: false, cancelled: false } };
  return {
    fake,
    voice: {
      speech: { speak: () => undefined, stop: () => undefined },
      readAloudSetting: { read: () => false, write: () => undefined },
      startRecording: async () => {
        fake.started.count += 1;
        return {
          stop: async () => {
            fake.recording.stopped = true;
            return WAV;
          },
          cancel: () => {
            fake.recording.cancelled = true;
          },
        };
      },
    },
  };
}

async function openOldChat(api: FakeMarginApi, voice: VoiceEnvironment): Promise<HTMLElement> {
  api.threads = [{ id: OLD, provider: "codex", title: "Fine-tuning plan", updatedAtSec: 5 }];
  api.histories.set(OLD, threeExchanges());
  render(<App api={api} voice={voice} />);
  await userEvent.click(await screen.findByRole("button", { name: "Fine-tuning plan" }));
  await screen.findByText("answer 3");
  const view = document.querySelector(".chat-pane .view");
  if (!(view instanceof HTMLElement)) throw new Error("the main pane did not render");
  return view;
}

function context(blocks: Array<[string, string]>): string {
  return renderContextBlock({ paneKind: "chat", paneTitle: "Fine-tuning plan", blocks: blocks.map(([label, text]) => ({ label, text })) });
}

async function pause(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

test("release_transcribes_and_sends_with_context", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  act(() => userScroll(view, 300));

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  await waitFor(() => expect(fake.started.count).toBe(1));
  await pause(350);
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.recordings).toEqual([WAV]);
  expect(api.turnStarts[0]).toEqual({
    threadId: OLD,
    question: "does this look right?",
    contextText: context([["message 4 (assistant)", "answer 2"], ["message 5 (user)", "question 3"], ["message 6 (assistant)", "answer 3"]]),
    choice: CODEX_DEFAULT_CHOICE,
  });
  expect(await screen.findByText("does this look right?")).toBeInTheDocument();
});

test("context_is_read_at_key_down_not_key_up", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  act(() => userScroll(view, 300));
  const expected = context([["message 4 (assistant)", "answer 2"], ["message 5 (user)", "question 3"], ["message 6 (assistant)", "answer 3"]]);

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  await waitFor(() => expect(fake.started.count).toBe(1));
  act(() => userScroll(view, 0));
  await pause(350);
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.turnStarts[0]?.contextText).toBe(expected);
});

test("a_spoken_message_that_is_not_accepted_returns_to_the_draft_with_the_reason", async () => {
  const api = new FakeMarginApi();
  api.transcript = "why is this slow?";
  api.turnStart = async () => {
    throw new Error("Codex is busy");
  };
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  act(() => userScroll(view, 300));
  await userEvent.type(screen.getByLabelText("Message"), "my draft ");

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  await waitFor(() => expect(fake.started.count).toBe(1));
  await pause(350);
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });

  expect(await screen.findByRole("alert")).toHaveTextContent("Codex is busy");
  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("my draft why is this slow?"));
});

test("the_left_option_key_does_nothing", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = fakeVoice();
  await openOldChat(api, voice);

  fireEvent.keyDown(window, { code: "AltLeft", key: "Alt" });
  await pause(50);
  fireEvent.keyUp(window, { code: "AltLeft", key: "Alt" });

  expect(fake.started.count).toBe(0);
  expect(api.turnStarts).toEqual([]);
});

test("denied_microphone_shows_the_settings_path", async () => {
  const api = new FakeMarginApi();
  api.microphoneGranted = false;
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  act(() => userScroll(view, 300));

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });

  expect(await screen.findByRole("status")).toHaveTextContent(MICROPHONE_DENIED_MESSAGE);
  expect(fake.started.count).toBe(0);
  expect(api.turnStarts).toEqual([]);
});

test("while_listening_the_composer_says_so_and_losing_focus_cancels_the_recording", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  act(() => userScroll(view, 300));

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  expect(await screen.findByRole("status")).toHaveTextContent("Listening");
  fireEvent.blur(window);

  await waitFor(() => expect(fake.recording.cancelled).toBe(true));
  expect(await screen.findByRole("status")).toHaveTextContent("Recording cancelled");
  expect(api.turnStarts).toEqual([]);
});

test("spoken_message_while_an_answer_streams_is_refused", async () => {
  const api = new FakeMarginApi();
  const { voice, fake } = fakeVoice();
  const view = await openOldChat(api, voice);
  await userEvent.type(screen.getByLabelText("Message"), "first{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => userScroll(view, 300));

  fireEvent.keyDown(window, { code: "AltRight", key: "Alt" });
  fireEvent.keyUp(window, { code: "AltRight", key: "Alt" });

  expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(BUSY_HINT);
  expect(fake.started.count).toBe(0);
  expect(api.turnStarts).toHaveLength(1);
  expect(api.recordings).toEqual([]);
});
