// Invariant: speech is transcribed on this Mac by whisper.cpp with the pinned base.en model, a model whose SHA-256 differs is never used, and a missing tool or a slow run is an error that names its fix.
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { createSpeechService, MAX_WAV_BYTES, resolveWhisperBinary, resolveWhisperModel } from "../../src/main/speech/speech-service";
import {
  BinaryNotFound,
  ExecTimeout,
  nodeExecFile,
  TRANSCRIBE_TIMEOUT_MS,
  transcribe,
  verifyWhisperModel,
  WHISPER_BASE_EN_SHA256,
  WHISPER_INSTALL_COMMAND,
  type ExecFile,
} from "../../src/main/speech/transcriber";

type Call = Readonly<{ file: string; args: ReadonlyArray<string>; timeoutMs: number }>;

function recordingExec(stdout: string): Readonly<{ exec: ExecFile; calls: Array<Call> }> {
  const calls: Array<Call> = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, timeoutMs: options.timeoutMs });
      return { stdout, stderr: "" };
    },
  };
}

test("transcribe_runs_the_binary_with_the_model_and_the_wav_and_no_timestamps", async () => {
  const { exec, calls } = recordingExec(" does this look right?\n");

  const text = await transcribe("/tmp/a.wav", { binary: "/opt/homebrew/bin/whisper-cli", model: "/models/ggml-base.en.bin", exec });

  expect(text).toBe("does this look right?");
  expect(calls).toEqual([{ file: "/opt/homebrew/bin/whisper-cli", args: ["-m", "/models/ggml-base.en.bin", "-f", "/tmp/a.wav", "-nt", "-np", "-l", "en"], timeoutMs: TRANSCRIBE_TIMEOUT_MS }]);
  expect(TRANSCRIBE_TIMEOUT_MS).toBe(30_000);
});

test("lines_of_one_utterance_are_joined_with_single_spaces", async () => {
  const { exec } = recordingExec(" first part\n second part \n\n");

  expect(await transcribe("/a.wav", { binary: "b", model: "m", exec })).toBe("first part second part");
});

test.each(["[BLANK_AUDIO]\n", " [ Silence ] \n", "\n", ""])("output_%j_means_no_speech_and_gives_an_empty_text", async (stdout) => {
  const { exec } = recordingExec(stdout);

  expect(await transcribe("/a.wav", { binary: "b", model: "m", exec })).toBe("");
});

test("transcriber_timeout_names_the_limit", async () => {
  const slow: ExecFile = async () => {
    throw new ExecTimeout();
  };

  await expect(transcribe("/a.wav", { binary: "b", model: "m", exec: slow })).rejects.toThrow("speech transcription did not finish within 30 s; record a shorter message");
});

test("a_missing_binary_names_the_install_command", async () => {
  const missing: ExecFile = async () => {
    throw new BinaryNotFound("/nowhere/whisper-cli");
  };

  await expect(transcribe("/a.wav", { binary: "/nowhere/whisper-cli", model: "m", exec: missing })).rejects.toThrow(`whisper-cli was not found at /nowhere/whisper-cli; install it with \`${WHISPER_INSTALL_COMMAND}\``);
  expect(WHISPER_INSTALL_COMMAND).toBe("brew install whisper-cpp");
});

test("another_failure_keeps_the_exit_reason_and_the_stderr_tail", async () => {
  const broken: ExecFile = async () => {
    throw new Error("exit code 3: failed to load model");
  };

  await expect(transcribe("/a.wav", { binary: "b", model: "m", exec: broken })).rejects.toThrow("speech transcription failed: exit code 3: failed to load model");
});

test("the_real_exec_kills_a_process_that_outlives_its_timeout", async () => {
  await expect(nodeExecFile("/bin/sleep", ["5"], { timeoutMs: 50 })).rejects.toBeInstanceOf(ExecTimeout);
});

test("the_real_exec_reports_a_missing_binary_and_a_failing_exit", async () => {
  await expect(nodeExecFile("/nonexistent/whisper-cli", [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(BinaryNotFound);
  await expect(nodeExecFile("/bin/sh", ["-c", "echo oops >&2; exit 3"], { timeoutMs: 5000 })).rejects.toThrow(/exit code 3.*oops/s);
});

test("the_real_exec_starts_the_child_with_an_empty_environment", async () => {
  const result = await nodeExecFile("/usr/bin/env", [], { timeoutMs: 5000 });

  expect(result.stdout).toBe("");
});

async function modelFile(content: string): Promise<Readonly<{ path: string; sha256: string }>> {
  const path = join(await mkdtemp(join(tmpdir(), "margin-model-")), "ggml-base.en.bin");
  await writeFile(path, content);
  return { path, sha256: createHash("sha256").update(content).digest("hex") };
}

test("whisper_model_with_a_wrong_hash_is_rejected", async () => {
  const { path, sha256 } = await modelFile("not the real model");
  const wrong = "0".repeat(64);

  await expect(verifyWhisperModel(path, wrong)).rejects.toThrow(`speech model ${path} has SHA-256 ${sha256} but ${wrong} was expected; delete it and run \`scripts/fetch-whisper-model.sh\``);
  await expect(verifyWhisperModel(path, sha256)).resolves.toBeUndefined();
});

test("a_model_file_that_is_missing_is_an_error_naming_the_download_script", async () => {
  await expect(verifyWhisperModel("/nowhere/ggml-base.en.bin", WHISPER_BASE_EN_SHA256)).rejects.toThrow("the speech model was not found at /nowhere/ggml-base.en.bin; download it with `scripts/fetch-whisper-model.sh`");
});

test("the_download_script_pins_the_same_digest_and_a_revision", async () => {
  const script = await readFile(new URL("../../scripts/fetch-whisper-model.sh", import.meta.url), "utf8");

  expect(script).toContain(`SHA256="${WHISPER_BASE_EN_SHA256}"`);
  expect(script).toMatch(/REVISION="[0-9a-f]{40}"/);
  expect(script).toContain("ggml-base.en.bin");
});

test("the_binary_comes_from_the_override_or_the_login_shell_path_and_a_missing_one_names_the_install_command", async () => {
  const executable = async (path: string): Promise<boolean> => path === "/opt/homebrew/bin/whisper-cli" || path === "/custom/whisper-cli";

  expect(await resolveWhisperBinary({ override: undefined, loginShellPath: "/usr/bin:/opt/homebrew/bin", isExecutable: executable })).toBe("/opt/homebrew/bin/whisper-cli");
  expect(await resolveWhisperBinary({ override: "/custom/whisper-cli", loginShellPath: "/usr/bin", isExecutable: executable })).toBe("/custom/whisper-cli");
  await expect(resolveWhisperBinary({ override: undefined, loginShellPath: "/usr/bin", isExecutable: executable })).rejects.toThrow("whisper-cli was not found on PATH; install it with `brew install whisper-cpp`");
  await expect(resolveWhisperBinary({ override: "relative/whisper", loginShellPath: "/usr/bin", isExecutable: executable })).rejects.toThrow("MARGIN_WHISPER_PATH must be an absolute path");
  await expect(resolveWhisperBinary({ override: "", loginShellPath: "/usr/bin", isExecutable: executable })).rejects.toThrow("MARGIN_WHISPER_PATH is set but empty");
  await expect(resolveWhisperBinary({ override: "/not/executable", loginShellPath: "/usr/bin", isExecutable: executable })).rejects.toThrow("MARGIN_WHISPER_PATH is not executable");
});

test("the_model_defaults_to_the_models_folder_and_an_override_needs_its_own_digest", () => {
  expect(resolveWhisperModel("/data/Margin", { path: undefined, sha256: undefined })).toEqual({ path: "/data/Margin/models/ggml-base.en.bin", sha256: WHISPER_BASE_EN_SHA256 });
  expect(resolveWhisperModel("/data/Margin", { path: "/m/model.bin", sha256: "a".repeat(64) })).toEqual({ path: "/m/model.bin", sha256: "a".repeat(64) });
  expect(() => resolveWhisperModel("/data/Margin", { path: "/m/model.bin", sha256: undefined })).toThrow("MARGIN_WHISPER_MODEL needs MARGIN_WHISPER_MODEL_SHA256");
  expect(() => resolveWhisperModel("/data/Margin", { path: undefined, sha256: "a".repeat(64) })).toThrow("MARGIN_WHISPER_MODEL_SHA256 needs MARGIN_WHISPER_MODEL");
  expect(() => resolveWhisperModel("/data/Margin", { path: "relative.bin", sha256: "a".repeat(64) })).toThrow("MARGIN_WHISPER_MODEL must be an absolute path");
});

function wav(bytes = 100): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set(new TextEncoder().encode("RIFF"), 0);
  data.set(new TextEncoder().encode("WAVE"), 8);
  return data;
}

async function service(stdout: string, overrides: Readonly<{ shaOfModel?: string }> = {}) {
  const model = await modelFile("model bytes");
  const { exec, calls } = recordingExec(stdout);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "margin-speech-root-"));
  const speech = createSpeechService({ binary: async () => "/bin/whisper-cli", model: async () => ({ path: model.path, sha256: overrides.shaOfModel ?? model.sha256 }), exec, temporaryRoot });
  return { speech, calls, temporaryRoot, model };
}

test("the_service_transcribes_a_wav_and_leaves_no_temporary_file", async () => {
  const { speech, calls, temporaryRoot } = await service("hello there\n");

  expect(await speech.transcribeWav(wav())).toBe("hello there");

  expect(calls[0]?.args[3]).toMatch(/audio\.wav$/);
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("the_service_leaves_no_temporary_file_after_a_failure", async () => {
  const { temporaryRoot, model } = await service("x");
  const failing = createSpeechService({
    binary: async () => "/bin/whisper-cli",
    model: async () => ({ path: model.path, sha256: model.sha256 }),
    exec: async () => {
      throw new ExecTimeout();
    },
    temporaryRoot,
  });

  await expect(failing.transcribeWav(wav())).rejects.toThrow("did not finish within 30 s");

  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("a_wrong_model_digest_stops_the_service_before_anything_runs", async () => {
  const { speech, calls, temporaryRoot } = await service("never used", { shaOfModel: "0".repeat(64) });

  await expect(speech.transcribeWav(wav())).rejects.toThrow("has SHA-256");

  expect(calls).toEqual([]);
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("a_failed_model_check_is_repeated_on_the_next_call_so_a_fixed_model_works_without_a_restart", async () => {
  const { exec } = recordingExec("hi");
  const model = await modelFile("model bytes");
  let answer = "0".repeat(64);
  const speech = createSpeechService({ binary: async () => "b", model: async () => ({ path: model.path, sha256: answer }), exec, temporaryRoot: await mkdtemp(join(tmpdir(), "margin-speech-root-")) });

  await expect(speech.transcribeWav(wav())).rejects.toThrow("has SHA-256");
  answer = model.sha256;

  expect(await speech.transcribeWav(wav())).toBe("hi");
});

test("the_model_is_hashed_once_for_many_transcriptions", async () => {
  const { exec } = recordingExec("hi");
  let checks = 0;
  const model = await modelFile("model bytes");
  const speech = createSpeechService({
    binary: async () => "b",
    model: async () => {
      checks += 1;
      return { path: model.path, sha256: model.sha256 };
    },
    exec,
    temporaryRoot: await mkdtemp(join(tmpdir(), "margin-speech-root-")),
  });

  await speech.transcribeWav(wav());
  await speech.transcribeWav(wav());

  expect(checks).toBe(1);
});

test.each([
  ["bytes that are not a wav", new TextEncoder().encode("not audio, just plain text bytes here"), "audio must be a WAV file"],
  ["an empty buffer", new Uint8Array(), "audio must be a WAV file"],
  ["a wav over the two-minute bound", wav(MAX_WAV_BYTES + 1), "audio is longer than the 2 minute recording limit"],
])("%s_is_rejected_before_anything_is_written", async (_name, bytes, fragment) => {
  const { speech, calls, temporaryRoot } = await service("x");

  await expect(speech.transcribeWav(bytes)).rejects.toThrow(fragment);

  expect(calls).toEqual([]);
  expect(await readdir(temporaryRoot)).toEqual([]);
});
