// Turns a recorded WAV file into text on this Mac with whisper.cpp and the pinned base.en model, and checks the model's SHA-256 first.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const TRANSCRIBE_TIMEOUT_MS = 30 * 1000;
export const WHISPER_BINARY_NAME = "whisper-cli";
export const WHISPER_MODEL_FILE = "ggml-base.en.bin";
/** The SHA-256 Hugging Face publishes for ggml-base.en.bin; scripts/fetch-whisper-model.sh pins the same value. */
export const WHISPER_BASE_EN_SHA256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
export const WHISPER_INSTALL_COMMAND = "brew install whisper-cpp";
export const WHISPER_FETCH_COMMAND = "scripts/fetch-whisper-model.sh";

export class ExecTimeout extends Error {
  constructor() {
    super("the process outlived its time limit and was stopped");
  }
}

export class BinaryNotFound extends Error {
  readonly binary: string;
  constructor(binary: string) {
    super(`${binary} does not exist`);
    this.binary = binary;
  }
}

export type ExecResult = Readonly<{ stdout: string; stderr: string }>;
/** Runs `file` with `args`, an empty environment and a time limit; rejects with ExecTimeout, BinaryNotFound or an Error that holds the exit code and the stderr tail. */
export type ExecFile = (file: string, args: ReadonlyArray<string>, options: Readonly<{ timeoutMs: number }>) => Promise<ExecResult>;

/** Whisper prints a few progress lines to stderr; this bounds what an error message may quote. */
const STDERR_TAIL_CHARS = 400;
/** Whisper's own output for no speech; it is not something the user said. */
const NON_SPEECH = /^\[[A-Za-z_ ]+\]$/;

export const nodeExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: options.timeoutMs, encoding: "utf8", env: {}, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ stdout, stderr });
      if ("code" in error && error.code === "ENOENT") return reject(new BinaryNotFound(file));
      if (error.killed) return reject(new ExecTimeout());
      const tail = stderr.trim().slice(-STDERR_TAIL_CHARS);
      reject(new Error(`exit code ${String(error.code)}${tail === "" ? "" : `: ${tail}`}`));
    });
  });

export type TranscribeOptions = Readonly<{ binary: string; model: string; exec?: ExecFile; timeoutMs?: number }>;

/** The words in whisper's output, one line per segment, joined with single spaces; a run with no speech gives "". */
function speechIn(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !NON_SPEECH.test(line))
    .join(" ");
}

export async function transcribe(wavPath: string, options: TranscribeOptions): Promise<string> {
  const exec = options.exec ?? nodeExecFile;
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  try {
    const { stdout } = await exec(options.binary, ["-m", options.model, "-f", wavPath, "-nt", "-np", "-l", "en"], { timeoutMs });
    return speechIn(stdout);
  } catch (error) {
    if (error instanceof ExecTimeout) throw new Error(`speech transcription did not finish within ${timeoutMs / 1000} s; record a shorter message`);
    if (error instanceof BinaryNotFound) throw new Error(`${WHISPER_BINARY_NAME} was not found at ${error.binary}; install it with \`${WHISPER_INSTALL_COMMAND}\``);
    throw new Error(`speech transcription failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Rejects a model file that is absent or whose SHA-256 differs from `expectedSha256`; a model nobody checked is never used. */
export async function verifyWhisperModel(path: string, expectedSha256: string): Promise<void> {
  let actual: string;
  try {
    actual = await sha256Of(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`the speech model was not found at ${path}; download it with \`${WHISPER_FETCH_COMMAND}\``);
    throw error;
  }
  if (actual !== expectedSha256) throw new Error(`speech model ${path} has SHA-256 ${actual} but ${expectedSha256} was expected; delete it and run \`${WHISPER_FETCH_COMMAND}\``);
}
