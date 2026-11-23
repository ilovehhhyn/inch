// Measures push-to-talk dictation through the built app with the real recorder and the real whisper.cpp: word error and time from key release to the sent message.
// The speaker is a macOS synthetic voice played as the window's microphone, not a person, so the word error is a floor and not a measure of real speech.
// Run it with: MARGIN_MEASURE_VOICE=1 npx playwright test voice-measure   (needs whisper-cli and scripts/fetch-whisper-model.sh already run)
import { test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { WHISPER_BASE_EN_SHA256, WHISPER_MODEL_FILE } from "../../src/main/speech/transcriber";
import { installSyntheticMicrophone, launchMargin, REPOSITORY_ROOT, synthesizeSpeechWav } from "./support";

const REFERENCE = "does this look right?";
const VOICES = ["Samantha", "Daniel", "Karen", "Moira", "Tessa"];
const SEED = join(REPOSITORY_ROOT, "tests/e2e/fixtures/long-thread.json");
const MODEL = join(homedir(), "Library/Application Support/Margin/models", WHISPER_MODEL_FILE);
/** The key is held for about the length of the phrase plus a short pause, as a person would. */
const HOLD_MS = 1800;
const SEEDED_MESSAGES = 20;
const MEASUREMENT_TIMEOUT_MS = 240 * 1000;

test.skip(process.env["MARGIN_MEASURE_VOICE"] !== "1", "an opt-in measurement: set MARGIN_MEASURE_VOICE=1");

function words(text: string): Array<string> {
  return text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((word) => word !== "");
}

/** Word error rate: the word-level edit distance divided by the number of reference words. */
function wordErrorRate(reference: string, heard: string): number {
  const expected = words(reference);
  const actual = words(heard);
  const row = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 1; i <= expected.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= actual.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + (expected[i - 1] === actual[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return (row[actual.length] ?? 0) / expected.length;
}

test("five_dictations_with_real_whisper", async () => {
  test.setTimeout(MEASUREMENT_TIMEOUT_MS);
  const scratch = await mkdtemp(join(tmpdir(), "margin-voice-measure-"));
  const margin = await launchMargin({ seed: SEED, env: { MARGIN_ASSUME_MICROPHONE_ACCESS: "1", MARGIN_WHISPER_MODEL: MODEL, MARGIN_WHISPER_MODEL_SHA256: WHISPER_BASE_EN_SHA256 } });
  const { page } = margin;
  try {
    await page.getByRole("button", { name: /Question 1:/ }).click();
    await page.getByRole("region", { name: "Chat", exact: true }).getByText("Answer 20.").waitFor();
    for (const [index, voice] of VOICES.entries()) {
      const wav = await synthesizeSpeechWav(await mkdtemp(join(scratch, `${voice}-`)), REFERENCE);
      await installSyntheticMicrophone(page, wav);
      await page.getByLabel("Message", { exact: true }).click();
      await page.keyboard.down("AltRight");
      await page.getByRole("status").getByText(/Listening/).waitFor();
      await page.waitForTimeout(HOLD_MS);
      const releasedAt = performance.now();
      await page.keyboard.up("AltRight");
      await page.waitForFunction((count) => document.querySelectorAll(".chat-pane .u").length >= count, SEEDED_MESSAGES + index + 1);
      const releaseToSentMs = Math.round(performance.now() - releasedAt);
      const heard = (await page.locator(".chat-pane .u").last().innerText()).trim();
      console.log(JSON.stringify({ run: index + 1, voice, heard, wordErrorRate: wordErrorRate(REFERENCE, heard), releaseToSentMs }));
      await page.getByRole("region", { name: "Chat", exact: true }).getByRole("button", { name: "Open side chat" }).nth(SEEDED_MESSAGES + index).waitFor();
    }
  } finally {
    await margin.app.close();
  }
});
