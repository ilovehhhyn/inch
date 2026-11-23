// Invariant: the fake microphone exists only when a test names an existing WAV file, and every other value is an error that names the fix.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { fakeMicrophoneSwitches, readFakeMicrophone } from "../../src/main/fake-microphone";

test("unset_means_the_real_microphone", () => {
  expect(readFakeMicrophone({})).toBeUndefined();
});

test("an_existing_wav_file_becomes_the_microphone_and_plays_once", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "margin-mic-")), "speech.wav");
  await writeFile(path, "RIFF");

  const microphone = readFakeMicrophone({ MARGIN_FAKE_MICROPHONE_WAV: path });

  expect(microphone).toEqual({ wavPath: path });
  expect(microphone === undefined ? [] : fakeMicrophoneSwitches(microphone)).toEqual([["use-fake-device-for-media-stream"], ["use-fake-ui-for-media-stream"], ["use-file-for-fake-audio-capture", `${path}%noloop`]]);
});

test.each([
  ["an empty value", "", "set but empty"],
  ["a relative path", "speech.wav", "must be an absolute path"],
  ["another extension", "/tmp/speech.mp3", "must name a .wav file"],
  ["a file that is missing", "/nonexistent/speech.wav", "does not exist"],
])("%s_is_rejected", (_name, value, fragment) => {
  expect(() => readFakeMicrophone({ MARGIN_FAKE_MICROPHONE_WAV: value })).toThrow(fragment);
});
