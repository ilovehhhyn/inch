// Invariant: holding the right option key records, releasing it transcribes and sends with the context read when the key went down, and every way a recording can fail ends in a visible message and nothing sent.
import { expect, test } from "vitest";

import type { Capture } from "../../src/renderer/context/capture-context";
import {
  createPushToTalk,
  MICROPHONE_DENIED_MESSAGE,
  PUSH_TO_TALK_KEY,
  SHORT_PRESS_MESSAGE,
  type PushToTalk,
  type PushToTalkDeps,
  type Recording,
  type VoiceStatus,
} from "../../src/renderer/voice/push-to-talk";
import { MAX_RECORDING_MS, MIN_RECORDING_MS } from "../../src/shared/speech";

const WAV = Uint8Array.from([82, 73, 70, 70]);
const CAPTURE: Capture = { text: "MARGIN SCREEN CONTEXT v1\npane: chat · Plan\n--- message 2 (assistant)\nWarm up.\nEND MARGIN SCREEN CONTEXT", elapsedMs: 1, paneKind: "chat", blockCount: 1 };

type Harness = Readonly<{
  voice: PushToTalk;
  clock: { now: number };
  statuses: Array<VoiceStatus>;
  sent: Array<Readonly<{ question: string; capture: Capture }>>;
  unsent: Array<string>;
  captures: { count: number };
  recordings: Array<{ stopped: boolean; cancelled: boolean }>;
  transcripts: Array<Uint8Array>;
  timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
  requests: { count: number };
}>;

function harness(overrides: Partial<PushToTalkDeps> & Readonly<{ microphone?: boolean; text?: string; sendResult?: boolean }> = {}): Harness {
  const clock = { now: 1000 };
  const statuses: Array<VoiceStatus> = [];
  const sent: Array<{ question: string; capture: Capture }> = [];
  const unsent: Array<string> = [];
  const captures = { count: 0 };
  const recordings: Array<{ stopped: boolean; cancelled: boolean }> = [];
  const transcripts: Array<Uint8Array> = [];
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const requests = { count: 0 };
  const deps: PushToTalkDeps = {
    requestMicrophone: async () => {
      requests.count += 1;
      return overrides.microphone ?? true;
    },
    startRecording: async (): Promise<Recording> => {
      const state = { stopped: false, cancelled: false };
      recordings.push(state);
      return {
        stop: async () => {
          state.stopped = true;
          return WAV;
        },
        cancel: () => {
          state.cancelled = true;
        },
      };
    },
    transcribe: async (wav) => {
      transcripts.push(wav);
      return overrides.text ?? "does this look right?";
    },
    captureContext: () => {
      captures.count += 1;
      return CAPTURE;
    },
    send: async (question, capture) => {
      sent.push({ question, capture });
      return overrides.sendResult ?? true;
    },
    onUnsent: (text) => unsent.push(text),
    onStatus: (status) => statuses.push(status),
    now: () => clock.now,
    schedule: (ms, fire) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  };
  return { voice: createPushToTalk(deps), clock, statuses, sent, unsent, captures, recordings, transcripts, timers, requests };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function hold(context: Harness, heldMs: number): Promise<void> {
  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  context.clock.now += heldMs;
  context.voice.keyUp({ code: PUSH_TO_TALK_KEY.code });
  await settle();
}

test("the_push_to_talk_key_is_the_right_option_key", () => {
  expect(PUSH_TO_TALK_KEY).toEqual({ code: "AltRight", label: "right ⌥" });
  expect(MIN_RECORDING_MS).toBe(300);
  expect(MAX_RECORDING_MS).toBe(120_000);
});

test("release_transcribes_and_sends_with_context", async () => {
  const context = harness();

  await hold(context, 1500);

  expect(context.transcripts).toEqual([WAV]);
  expect(context.sent).toEqual([{ question: "does this look right?", capture: CAPTURE }]);
  expect(context.recordings).toEqual([{ stopped: true, cancelled: false }]);
  expect(context.statuses.map((status) => status.kind)).toEqual(["listening", "transcribing", "idle"]);
});

test("release_after_under_300_ms_sends_nothing", async () => {
  const context = harness();

  await hold(context, MIN_RECORDING_MS - 1);

  expect(context.transcripts).toEqual([]);
  expect(context.sent).toEqual([]);
  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: SHORT_PRESS_MESSAGE });
  expect(context.recordings).toEqual([{ stopped: false, cancelled: true }]);
});

test("a_press_of_exactly_300_ms_is_sent", async () => {
  const context = harness();

  await hold(context, MIN_RECORDING_MS);

  expect(context.sent).toHaveLength(1);
});

test("only_the_right_option_key_starts_recording", async () => {
  const context = harness();

  context.voice.keyDown({ code: "AltLeft", repeat: false });
  context.voice.keyDown({ code: "KeyI", repeat: false });
  await settle();
  context.voice.keyUp({ code: "AltLeft" });
  await settle();

  expect(context.recordings).toEqual([]);
  expect(context.requests.count).toBe(0);
  expect(context.captures.count).toBe(0);
  expect(context.statuses).toEqual([]);
});

test("a_repeated_key_down_while_held_does_not_start_a_second_recording", async () => {
  const context = harness();

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: true });
  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();

  expect(context.recordings).toHaveLength(1);
  expect(context.captures.count).toBe(1);
});

test("context_is_read_at_key_down_not_key_up", async () => {
  const reads: Array<string> = [];
  const context = harness({
    captureContext: () => {
      reads.push("read");
      return { ...CAPTURE, text: `read number ${reads.length}` };
    },
  });

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  reads.push("the user scrolls another pane while talking");
  context.clock.now += 2000;
  context.voice.keyUp({ code: PUSH_TO_TALK_KEY.code });
  await settle();

  expect(reads).toEqual(["read", "the user scrolls another pane while talking"]);
  expect(context.sent[0]?.capture.text).toBe("read number 1");
});

test("denied_microphone_shows_the_settings_path", async () => {
  const context = harness({ microphone: false });

  await hold(context, 1000);

  expect(MICROPHONE_DENIED_MESSAGE).toBe("Margin needs microphone access. Open System Settings › Privacy & Security › Microphone");
  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: MICROPHONE_DENIED_MESSAGE });
  expect(context.recordings).toEqual([]);
  expect(context.sent).toEqual([]);
});

test("a_pane_that_cannot_be_read_stops_before_the_microphone_is_asked", async () => {
  const context = harness({
    captureContext: () => {
      throw new Error("no pane to read: scroll a pane or click into one, then press Command-I");
    },
  });

  await hold(context, 1000);

  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: "no pane to read: scroll a pane or click into one, then press Command-I" });
  expect(context.requests.count).toBe(0);
  expect(context.recordings).toEqual([]);
});

test("release_before_the_recorder_has_started_sends_nothing_and_stops_it", async () => {
  let resolveMicrophone: (granted: boolean) => void = () => undefined;
  const context = harness({ requestMicrophone: () => new Promise<boolean>((resolve) => (resolveMicrophone = resolve)) });

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  context.voice.keyUp({ code: PUSH_TO_TALK_KEY.code });
  resolveMicrophone(true);
  await settle();

  expect(context.recordings).toEqual([]);
  expect(context.sent).toEqual([]);
  expect(context.statuses.at(-1)).toEqual({ kind: "idle" });
});

test("recording_stops_at_two_minutes_with_the_note_and_the_message_is_sent", async () => {
  const context = harness();

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  expect(context.timers.map((timer) => timer.ms)).toEqual([MAX_RECORDING_MS]);
  context.clock.now += MAX_RECORDING_MS;
  context.timers[0]?.fire();
  await settle();

  expect(context.sent).toHaveLength(1);
  expect(context.statuses).toContainEqual({ kind: "note", message: "Recording stopped at 2 minutes" });
  context.voice.keyUp({ code: PUSH_TO_TALK_KEY.code });
  await settle();
  expect(context.sent).toHaveLength(1);
});

test("the_two_minute_timer_is_cancelled_by_a_normal_release", async () => {
  const context = harness();

  await hold(context, 1000);

  expect(context.timers[0]?.cancelled).toBe(true);
});

test("silence_sends_nothing_and_says_no_speech_was_heard", async () => {
  const context = harness({ text: "" });

  await hold(context, 1000);

  expect(context.sent).toEqual([]);
  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: "No speech heard" });
});

test("a_transcription_failure_is_shown_and_sends_nothing", async () => {
  const context = harness({
    transcribe: async () => {
      throw new Error("whisper-cli was not found on PATH; install it with `brew install whisper-cpp`");
    },
  });

  await hold(context, 1000);

  expect(context.sent).toEqual([]);
  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: "whisper-cli was not found on PATH; install it with `brew install whisper-cpp`" });
});

test("a_refused_send_hands_the_transcript_back_so_the_words_are_not_lost", async () => {
  const context = harness({ sendResult: false });

  await hold(context, 1000);

  expect(context.unsent).toEqual(["does this look right?"]);
});

test("losing_window_focus_while_recording_cancels_it_and_says_so", async () => {
  const context = harness();

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  context.voice.cancel();
  await settle();

  expect(context.recordings).toEqual([{ stopped: false, cancelled: true }]);
  expect(context.sent).toEqual([]);
  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: "Recording cancelled" });
  expect(context.timers[0]?.cancelled).toBe(true);
});

test("a_new_press_while_a_message_is_being_transcribed_is_ignored", async () => {
  let release: (text: string) => void = () => undefined;
  const context = harness({ transcribe: () => new Promise<string>((resolve) => (release = resolve)) });

  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  context.clock.now += 1000;
  context.voice.keyUp({ code: PUSH_TO_TALK_KEY.code });
  await settle();
  context.voice.keyDown({ code: PUSH_TO_TALK_KEY.code, repeat: false });
  await settle();
  expect(context.recordings).toHaveLength(1);
  release("hello");
  await settle();

  expect(context.sent).toHaveLength(1);
});

test("a_recorder_that_cannot_start_shows_why", async () => {
  const context = harness({
    startRecording: async () => {
      throw new Error("no microphone was found; connect one");
    },
  });

  await hold(context, 1000);

  expect(context.statuses.at(-1)).toEqual({ kind: "note", message: "no microphone was found; connect one" });
  expect(context.sent).toEqual([]);
});
