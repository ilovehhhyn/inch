// Invariant: the model, reasoning level and attached files reach Codex as chosen, an image is refused for a text-only model, and a message spoken with the right option key is transcribed on this Mac and sent with the context read at key down.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSyntheticMicrophone, launchMargin, readCodexLog, readTurnTexts, REPOSITORY_ROOT, synthesizeSpeechWav, writeFakeWhisper, type RunningMargin } from "./support";

const FIXTURES = join(REPOSITORY_ROOT, "tests/fixtures/attachments");
const LONG_THREAD_SEED = join(REPOSITORY_ROOT, "tests/e2e/fixtures/long-thread.json");
const SPEECH_HOLD_MS = 2500;

let margin: RunningMargin | null = null;

test.afterEach(async () => {
  await margin?.app.close();
  margin = null;
});

type TurnParams = Readonly<{ threadId: string; model: string; effort: string; input: ReadonlyArray<Readonly<{ type: string; text?: string; path?: string }>> }>;

async function readTurns(path: string): Promise<Array<TurnParams>> {
  return (await readCodexLog(path)).filter((entry) => entry.method === "turn/start").map((entry) => entry.params as TurnParams); // shape written by Margin's turn/start request
}

test("the_chosen_model_and_reasoning_level_reach_codex", async () => {
  margin = await launchMargin();
  const { page, codexLogPath } = margin;
  await expect(page.getByLabel("Model")).toHaveValue("fake-model");
  await expect(page.getByLabel("Reasoning")).toHaveValue("medium");

  await page.getByLabel("Reasoning").selectOption("high");
  await page.getByLabel("Message", { exact: true }).fill("hello");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByRole("region", { name: "Chat", exact: true }).getByRole("button", { name: "Open side chat" })).toBeVisible();
  await page.getByLabel("Model").selectOption("fake-text-model");
  await page.getByLabel("Message", { exact: true }).fill("again");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect.poll(async () => (await readTurns(codexLogPath)).length).toBe(2);

  const turns = await readTurns(codexLogPath);
  expect(turns.map((turn) => [turn.model, turn.effort])).toEqual([["fake-model", "high"], ["fake-text-model", "high"]]);
});

test("an_attached_image_and_text_file_reach_codex_before_the_question_and_the_image_is_a_copy", async () => {
  margin = await launchMargin();
  const { page, codexLogPath, userDataPath } = margin;
  await page.getByLabel("Choose files").setInputFiles([join(FIXTURES, "pixel.png"), join(FIXTURES, "train.py")]);
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("pixel.png");

  await page.getByLabel("Message", { exact: true }).fill("what is in these?");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByRole("region", { name: "Chat", exact: true })).toContainText("Fake answer");

  const [turn] = await readTurns(codexLogPath);
  const image = turn?.input[0];
  expect(image?.type).toBe("localImage");
  expect(image?.path?.startsWith(join(await realpath(userDataPath), "attachments", turn?.threadId ?? "missing"))).toBe(true);
  expect(await readFile(image?.path ?? "")).toEqual(await readFile(join(FIXTURES, "pixel.png")));
  expect(turn?.input[1]?.text).toMatch(/^ATTACHED FILE train\.py\ndef get_lr/);
  expect(turn?.input.at(-1)?.text).toBe("what is in these?");
  await expect(page.getByRole("region", { name: "Chat", exact: true }).locator(".u").getByText("pixel.png")).toBeVisible();
  await expect(page.locator(".composer .chips")).toHaveCount(0);
});

test("an_image_for_a_text_only_model_is_refused_before_anything_is_sent", async () => {
  margin = await launchMargin();
  const { page, codexLogPath } = margin;
  await page.getByLabel("Model").selectOption("fake-text-model");
  await page.getByLabel("Choose files").setInputFiles([join(FIXTURES, "pixel.png")]);
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("pixel.png");

  await page.getByLabel("Message", { exact: true }).fill("look");
  await page.getByLabel("Message", { exact: true }).press("Enter");

  await expect(page.getByRole("alert")).toContainText("cannot send image `pixel.png` to `fake-text-model`, which reads text only");
  expect(await readTurns(codexLogPath)).toEqual([]);
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("pixel.png");
});

test("a_zip_file_is_refused_with_the_accepted_kinds_and_nothing_is_stored", async () => {
  margin = await launchMargin();
  const { page, userDataPath } = margin;

  await page.getByLabel("Choose files").setInputFiles([join(FIXTURES, "archive.zip")]);

  await expect(page.getByRole("status")).toContainText("cannot attach `archive.zip`; Margin accepts images, PDFs and text files");
  await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
  expect(await readdir(join(userDataPath, "attachments")).catch(() => [])).toEqual([]);
});

test("a_spoken_message_is_recorded_transcribed_on_this_mac_and_sent_with_the_context_read_at_key_down", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "margin-voice-"));
  const wav = await synthesizeSpeechWav(scratch, "does this look right?");
  const received = join(scratch, "received.wav");
  const whisper = await writeFakeWhisper(scratch, "does this look right?", received);
  const model = join(scratch, "ggml-base.en.bin");
  await writeFile(model, "stand-in model bytes");
  const sha256 = createHash("sha256").update("stand-in model bytes").digest("hex");
  margin = await launchMargin({
    seed: LONG_THREAD_SEED,
    env: { MARGIN_ASSUME_MICROPHONE_ACCESS: "1", MARGIN_WHISPER_PATH: whisper, MARGIN_WHISPER_MODEL: model, MARGIN_WHISPER_MODEL_SHA256: sha256 },
  });
  const { page, codexLogPath } = margin;
  await page.getByRole("button", { name: /Question 1:/ }).click();
  const main = page.getByRole("region", { name: "Chat", exact: true });
  await expect(main).toContainText("Answer 20.");
  await page.getByLabel("Message", { exact: true }).click();

  await installSyntheticMicrophone(page, wav);
  await page.keyboard.down("AltRight");
  await expect(page.getByRole("status")).toContainText("Listening");
  await page.waitForTimeout(SPEECH_HOLD_MS);
  await page.keyboard.up("AltRight");

  await expect.poll(async () => (await readTurnTexts(codexLogPath)).length, { timeout: 20_000 }).toBe(1);
  const [turn] = await readTurnTexts(codexLogPath);
  expect(turn?.text.startsWith("MARGIN SCREEN CONTEXT v1")).toBe(true);
  expect(turn?.text.endsWith("does this look right?")).toBe(true);
  const audio = await readFile(received);
  expect(audio.toString("latin1", 0, 4)).toBe("RIFF");
  expect([audio.readUInt16LE(22), audio.readUInt32LE(24), audio.readUInt16LE(34)]).toEqual([1, 16_000, 16]);
  expect(audio.length).toBeGreaterThan(44 + 16_000 * 2); // more than a second of recorded samples
});
