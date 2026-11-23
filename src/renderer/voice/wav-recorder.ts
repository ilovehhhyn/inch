// Records the microphone in the window and returns the audio as a 16 kHz mono WAV, which the browser cannot record directly.
import { SAMPLE_RATE_HZ } from "../../shared/speech";
import { encodeWav } from "../../shared/wav";
import type { Recording } from "./push-to-talk";

const NO_MICROPHONE = "no microphone was found; connect one and try again";

function describeCaptureFailure(error: unknown): Error {
  if (error instanceof DOMException && error.name === "NotFoundError") return new Error(NO_MICROPHONE);
  if (error instanceof DOMException && error.name === "NotAllowedError") return new Error("the microphone was blocked; allow it for Margin in System Settings › Privacy & Security › Microphone");
  return error instanceof Error ? error : new Error(String(error));
}

/** Decodes the recorded container (WebM/Opus in Chromium) and resamples it to 16 kHz mono with an offline renderer. */
async function toWav(recorded: Blob): Promise<Uint8Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recorded.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE_HZ)), SAMPLE_RATE_HZ);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return encodeWav((await offline.startRendering()).getChannelData(0));
  } finally {
    await context.close();
  }
}

/** Starts recording at once; the microphone is released by `stop` and by `cancel`. */
export async function startWavRecording(): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch (error) {
    throw describeCaptureFailure(error);
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Array<Blob> = [];
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  const ended = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve()));
  const release = (): void => stream.getTracks().forEach((track) => track.stop());
  recorder.start();
  return {
    async stop() {
      recorder.stop();
      await ended;
      release();
      return toWav(new Blob(chunks, { type: recorder.mimeType }));
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
