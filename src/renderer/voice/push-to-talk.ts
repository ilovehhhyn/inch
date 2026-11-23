// Turns holding the right option key into one spoken message: records while it is down, transcribes on release and sends with the context read at key down.
import type { Capture } from "../context/capture-context";
import { MAX_RECORDING_MS, MIN_RECORDING_MS } from "../../shared/speech";

/** The key that records while held; the right option key (Helen, 2026-11-21), so the left one stays free for typing. */
export const PUSH_TO_TALK_KEY = { code: "AltRight", label: "right ⌥" } as const;

export const MICROPHONE_DENIED_MESSAGE = "Margin needs microphone access. Open System Settings › Privacy & Security › Microphone";
export const SHORT_PRESS_MESSAGE = "Hold the key while you speak";
const MAX_RECORDING_NOTE = "Recording stopped at 2 minutes";
const NO_SPEECH_NOTE = "No speech heard";
const CANCELLED_NOTE = "Recording cancelled";

export type VoiceStatus = Readonly<{ kind: "idle" }> | Readonly<{ kind: "listening" }> | Readonly<{ kind: "transcribing" }> | Readonly<{ kind: "note"; message: string }>;

/** A running recording; `stop` ends it and returns the 16 kHz mono WAV, `cancel` throws the audio away. */
export type Recording = Readonly<{ stop: () => Promise<Uint8Array>; cancel: () => void }>;

export type PushToTalkDeps = Readonly<{
  requestMicrophone: () => Promise<boolean>;
  startRecording: () => Promise<Recording>;
  /** The WAV as text; "" when nobody spoke. */
  transcribe: (wav: Uint8Array) => Promise<string>;
  /** Reads the pane the way Command-I does; throws when there is no pane to read. */
  captureContext: () => Capture;
  /** Sends the spoken question with `capture` as a Command-I send; true once the question was accepted. */
  send: (question: string, capture: Capture) => Promise<boolean>;
  /** Receives the transcript of a message that was not sent, so the words are not lost. */
  onUnsent: (text: string) => void;
  onStatus: (status: VoiceStatus) => void;
  now: () => number;
  /** Runs `fire` after `ms`; the returned function cancels it. */
  schedule: (ms: number, fire: () => void) => () => void;
}>;

export type PushToTalk = Readonly<{
  keyDown: (event: Readonly<{ code: string; repeat: boolean }>) => void;
  keyUp: (event: Readonly<{ code: string }>) => void;
  /** Stops a recording without sending, for a window that lost focus. */
  cancel: () => void;
}>;

type Phase =
  | Readonly<{ name: "idle" }>
  | Readonly<{ name: "starting"; isReleased: boolean }>
  | Readonly<{ name: "recording"; recording: Recording; startedAtMs: number; cancelTimer: () => void }>
  | Readonly<{ name: "transcribing" }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPushToTalk(deps: PushToTalkDeps): PushToTalk {
  let phase: Phase = { name: "idle" };
  /** The context read when the key went down; it belongs to this press and no other. */
  let capture: Capture | null = null;

  function note(message: string): void {
    phase = { name: "idle" };
    deps.onStatus({ kind: "note", message });
  }

  function idle(): void {
    phase = { name: "idle" };
    deps.onStatus({ kind: "idle" });
  }

  async function finish(recording: Recording, startedAtMs: number, stopNote: string | null): Promise<void> {
    const heldMs = deps.now() - startedAtMs;
    const context = capture;
    if (heldMs < MIN_RECORDING_MS || context === null) {
      recording.cancel();
      return note(SHORT_PRESS_MESSAGE);
    }
    phase = { name: "transcribing" };
    deps.onStatus({ kind: "transcribing" });
    let text: string;
    try {
      text = await recording.stop().then((wav) => deps.transcribe(wav));
    } catch (error) {
      return note(messageOf(error));
    }
    if (text === "") return note(NO_SPEECH_NOTE);
    const wasSent = await deps.send(text, context);
    if (!wasSent) deps.onUnsent(text);
    if (stopNote === null) idle();
    else note(stopNote);
  }

  async function begin(): Promise<void> {
    try {
      capture = deps.captureContext();
    } catch (error) {
      return note(messageOf(error));
    }
    phase = { name: "starting", isReleased: false };
    let recording: Recording;
    try {
      if (!(await deps.requestMicrophone())) return note(MICROPHONE_DENIED_MESSAGE);
      if (phase.name === "starting" && phase.isReleased) return idle();
      recording = await deps.startRecording();
    } catch (error) {
      return note(messageOf(error));
    }
    if (phase.name === "starting" && phase.isReleased) {
      recording.cancel();
      return idle();
    }
    const startedAtMs = deps.now();
    const cancelTimer = deps.schedule(MAX_RECORDING_MS, () => {
      if (phase.name !== "recording") return;
      void finish(phase.recording, phase.startedAtMs, MAX_RECORDING_NOTE);
    });
    phase = { name: "recording", recording, startedAtMs, cancelTimer };
    deps.onStatus({ kind: "listening" });
  }

  return {
    keyDown(event) {
      if (event.code !== PUSH_TO_TALK_KEY.code || event.repeat || phase.name !== "idle") return;
      void begin();
    },
    keyUp(event) {
      if (event.code !== PUSH_TO_TALK_KEY.code) return;
      if (phase.name === "starting") phase = { name: "starting", isReleased: true };
      else if (phase.name === "recording") {
        const { recording, startedAtMs, cancelTimer } = phase;
        cancelTimer();
        void finish(recording, startedAtMs, null);
      }
    },
    cancel() {
      if (phase.name === "recording") {
        phase.cancelTimer();
        phase.recording.cancel();
        note(CANCELLED_NOTE);
      } else if (phase.name === "starting") {
        phase = { name: "starting", isReleased: true };
      }
    },
  };
}
