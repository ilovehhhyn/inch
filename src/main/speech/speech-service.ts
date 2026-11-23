// Finds whisper.cpp and its model, checks the model once, and transcribes the WAV bytes the window sends without leaving a file behind.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { BYTES_PER_SAMPLE, MAX_RECORDING_MS, SAMPLE_RATE_HZ } from "../../shared/speech";
import { transcribe, verifyWhisperModel, WHISPER_BASE_EN_SHA256, WHISPER_BINARY_NAME, WHISPER_INSTALL_COMMAND, WHISPER_MODEL_FILE, type ExecFile } from "./transcriber";

const WAV_HEADER_BYTES = 44;
/** Two minutes of 16 kHz 16-bit mono audio plus the header, and a small allowance for a longer header the browser may write. */
export const MAX_WAV_BYTES = WAV_HEADER_BYTES + (MAX_RECORDING_MS / 1000) * SAMPLE_RATE_HZ * BYTES_PER_SAMPLE + 4096;

export type WhisperModel = Readonly<{ path: string; sha256: string }>;

export type BinaryLookup = Readonly<{ override: string | undefined; loginShellPath: string; isExecutable: (path: string) => Promise<boolean> }>;

/** `MARGIN_WHISPER_PATH` (read once at start-up, for tests) or `whisper-cli` on the login-shell PATH; never a guess. */
export async function resolveWhisperBinary(lookup: BinaryLookup): Promise<string> {
  if (lookup.override !== undefined) {
    if (lookup.override === "") throw new Error("MARGIN_WHISPER_PATH is set but empty; unset it or give the full path to whisper-cli");
    if (!isAbsolute(lookup.override)) throw new Error(`MARGIN_WHISPER_PATH must be an absolute path, got \`${lookup.override}\`; give the full path to whisper-cli`);
    if (!(await lookup.isExecutable(lookup.override))) throw new Error(`MARGIN_WHISPER_PATH is not executable: ${lookup.override}; give the full path to whisper-cli`);
    return lookup.override;
  }
  for (const directory of lookup.loginShellPath.split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, WHISPER_BINARY_NAME);
    if (await lookup.isExecutable(candidate)) return candidate;
  }
  throw new Error(`${WHISPER_BINARY_NAME} was not found on PATH; install it with \`${WHISPER_INSTALL_COMMAND}\``);
}

/** The model in Margin's models folder with the pinned digest, or both overrides together (for tests, which use a small stand-in file). */
export function resolveWhisperModel(userDataDirectory: string, override: Readonly<{ path: string | undefined; sha256: string | undefined }>): WhisperModel {
  if (override.path === undefined && override.sha256 === undefined) return { path: join(userDataDirectory, "models", WHISPER_MODEL_FILE), sha256: WHISPER_BASE_EN_SHA256 };
  if (override.path === undefined) throw new Error("MARGIN_WHISPER_MODEL_SHA256 needs MARGIN_WHISPER_MODEL; set both or neither");
  if (override.sha256 === undefined) throw new Error("MARGIN_WHISPER_MODEL needs MARGIN_WHISPER_MODEL_SHA256; set both or neither");
  if (!isAbsolute(override.path)) throw new Error(`MARGIN_WHISPER_MODEL must be an absolute path, got \`${override.path}\`; give the full path to the model file`);
  return { path: override.path, sha256: override.sha256 };
}

export type SpeechServiceOptions = Readonly<{
  binary: () => Promise<string>;
  model: () => Promise<WhisperModel>;
  exec?: ExecFile;
  /** The folder that holds each recording while it is transcribed; the operating system's temporary folder by default. */
  temporaryRoot?: string;
}>;

export type SpeechService = Readonly<{
  /** Transcribes a 16 kHz mono WAV recording; "" means no speech was heard. */
  transcribeWav: (wav: Uint8Array) => Promise<string>;
}>;

function requireWav(wav: Uint8Array): void {
  const text = new TextDecoder("latin1");
  const isWav = wav.length >= WAV_HEADER_BYTES && text.decode(wav.subarray(0, 4)) === "RIFF" && text.decode(wav.subarray(8, 12)) === "WAVE";
  if (!isWav) throw new Error("audio must be a WAV file; the window records it before sending");
  if (wav.length > MAX_WAV_BYTES) throw new Error(`audio is longer than the ${MAX_RECORDING_MS / 60_000} minute recording limit; record a shorter message`);
}

export function createSpeechService(options: SpeechServiceOptions): SpeechService {
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  /** The model is hashed once per process after it passes; a failed check is forgotten, so a repaired model works without a restart. */
  let checked: Promise<WhisperModel> | undefined;
  const checkModelOnce = (): Promise<WhisperModel> => {
    checked ??= options
      .model()
      .then(async (model) => {
        await verifyWhisperModel(model.path, model.sha256);
        return model;
      })
      .catch((error: unknown) => {
        checked = undefined;
        throw error;
      });
    return checked;
  };

  return {
    async transcribeWav(wav) {
      requireWav(wav);
      const model = await checkModelOnce();
      const binary = await options.binary();
      await mkdir(temporaryRoot, { recursive: true });
      const folder = await mkdtemp(join(temporaryRoot, "margin-speech-"));
      try {
        const wavPath = join(folder, "audio.wav");
        await writeFile(wavPath, wav, { flag: "wx", mode: 0o600 });
        return await transcribe(wavPath, { binary, model: model.path, ...(options.exec === undefined ? {} : { exec: options.exec }) });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
