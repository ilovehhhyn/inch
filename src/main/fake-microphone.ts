// Reads the test-only setting that feeds a WAV file to the window as the microphone, so end-to-end tests can speak without a person.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export type FakeMicrophone = Readonly<{ wavPath: string }>;

/** `MARGIN_FAKE_MICROPHONE_WAV` is read once at start-up; unset means the real microphone, and any other value must be a path to an existing WAV file. */
export function readFakeMicrophone(env: Readonly<Record<string, string | undefined>>): FakeMicrophone | undefined {
  const value = env["MARGIN_FAKE_MICROPHONE_WAV"];
  if (value === undefined) return undefined;
  if (value === "") throw new Error("MARGIN_FAKE_MICROPHONE_WAV is set but empty; unset it or give the full path to a WAV file");
  if (!isAbsolute(value)) throw new Error(`MARGIN_FAKE_MICROPHONE_WAV must be an absolute path, got \`${value}\`; give the full path to a WAV file`);
  if (!value.endsWith(".wav")) throw new Error(`MARGIN_FAKE_MICROPHONE_WAV must name a .wav file, got \`${value}\``);
  if (!existsSync(value)) throw new Error(`MARGIN_FAKE_MICROPHONE_WAV names \`${value}\`, which does not exist; create the file or unset the variable`);
  return { wavPath: value };
}

/** The Chromium switches that replace the microphone with `wavPath`, played once (`%noloop`) and accepted without a prompt. */
export function fakeMicrophoneSwitches(microphone: FakeMicrophone): ReadonlyArray<readonly [string, string?]> {
  return [["use-fake-device-for-media-stream"], ["use-fake-ui-for-media-stream"], ["use-file-for-fake-audio-capture", `${microphone.wavPath}%noloop`]];
}
