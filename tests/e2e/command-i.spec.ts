// Invariant: Command-I sends the text of the pane scrolled last to Codex, changes nothing on screen, and reads the pane within the capture budget.
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CAPTURE_BUDGET_MS } from "../../src/renderer/context/capture-context";
import { createRepositoryWithDiff, createRepositoryWithLargeDiff, launchMargin, readLatencyRecords, readTurnTexts, REPOSITORY_ROOT, stubFolderDialog, type RunningMargin } from "./support";

const WARMUP_DIFF = join(REPOSITORY_ROOT, "tests/fixtures/warmup.diff");
const LONG_THREAD_SEED = join(REPOSITORY_ROOT, "tests/e2e/fixtures/long-thread.json");
const LARGE_DIFF_LINES = 5000;
const COMMAND_I_SENDS = 20;
const WHEEL_STEP_PX = 600;

let margin: RunningMargin | null = null;

test.afterEach(async () => {
  await margin?.app.close();
  margin = null;
});

/** Everything on the page except the message threads, as markup: it must not change when Command-I is pressed. */
async function pageOutsideThreads(page: Page): Promise<string> {
  return page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement; // a detached copy, so removing the threads leaves the live page alone
    copy.querySelectorAll(".thread").forEach((thread) => thread.remove());
    return copy.innerHTML;
  });
}

async function chooseDiffFolder(running: RunningMargin, folder: string): Promise<void> {
  await stubFolderDialog(running.app, folder);
  await running.page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(running.page.getByRole("button", { name: "Change folder" })).toBeVisible();
}

/**
 * Scrolls the pane by `distancePx` with the mouse wheel, down unless the pane is already at its end, and waits until the
 * page has delivered the scroll event, as a person's pause between scrolling and typing would.
 */
async function wheelOver(page: Page, selector: string, distancePx: number): Promise<void> {
  const pane = page.locator(selector);
  const box = await pane.boundingBox();
  if (box === null) throw new Error(`${selector} has no box on screen`);
  const { top, isAtEnd } = await pane.evaluate((element) => ({ top: element.scrollTop, isAtEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 1 }));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, isAtEnd ? -distancePx : distancePx);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).not.toBe(top);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("diff_scenario_from_the_film", async () => {
  margin = await launchMargin();
  const { page, scratchPath } = margin;
  const repository = await createRepositoryWithDiff(scratchPath, await readFile(WARMUP_DIFF, "utf8"));
  await chooseDiffFolder(margin, repository);
  await expect(page.locator(".diff-pane")).toContainText("get_lr");

  const main = page.getByRole("region", { name: "Chat", exact: true });
  await page.getByLabel("Message", { exact: true }).fill("hello");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(main).toContainText("Fake answer");
  await main.getByRole("button", { name: "Open side chat" }).click();
  const side = page.getByRole("region", { name: "Side chat" });
  await side.getByLabel("Side chat message").fill("what is a warmup?");
  await side.getByLabel("Side chat message").press("Enter");
  await expect(side).toContainText("Fake answer");

  await wheelOver(page, ".diff-pane .view", WHEEL_STEP_PX);
  const before = await pageOutsideThreads(page);
  await page.getByLabel("Message", { exact: true }).fill("does this look right?");
  await page.getByLabel("Message", { exact: true }).press("Meta+i");

  await expect(main).toContainText("get_lr()");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  const turns = await readTurnTexts(margin.codexLogPath);
  const contextTurn = turns.find((turn) => turn.text.includes("does this look right?"));
  expect(contextTurn?.text).toContain("--- train.py line 39");
  expect(contextTurn?.text).toContain("pane: diff");
  expect(turns.filter((turn) => turn.text.includes("MARGIN SCREEN CONTEXT"))).toHaveLength(1);
  expect(await pageOutsideThreads(page)).toBe(before);
});

test("capture_is_under_budget", async () => {
  margin = await launchMargin({ seed: LONG_THREAD_SEED });
  const { page, scratchPath, metricsPath } = margin;
  const repository = await createRepositoryWithLargeDiff(scratchPath, LARGE_DIFF_LINES);
  await chooseDiffFolder(margin, repository);
  await expect(page.locator(".diff-pane")).toContainText("big.py");
  await page.getByRole("button", { name: /Question 1:/ }).click();
  await expect(page.getByRole("region", { name: "Chat", exact: true })).toContainText("Answer 20.");

  for (let send = 0; send < COMMAND_I_SENDS; send++) {
    const useDiff = send % 2 === 1;
    await wheelOver(page, useDiff ? ".diff-pane .view" : ".chat-pane .view", WHEEL_STEP_PX);
    await page.getByLabel("Message", { exact: true }).fill(`question number ${send}`);
    await page.getByLabel("Message", { exact: true }).press("Meta+i");
    await expect.poll(async () => (await readLatencyRecords(metricsPath)).length, { timeout: 15_000 }).toBe(send + 1);
    await expect(page.getByRole("region", { name: "Chat", exact: true }).getByRole("button", { name: "Open side chat" })).toHaveCount(21 + send);
  }

  const records = await readLatencyRecords(metricsPath);
  expect(records).toHaveLength(COMMAND_I_SENDS);
  expect(records.map((record) => record.paneKind)).toEqual(Array.from({ length: COMMAND_I_SENDS }, (_, send) => (send % 2 === 1 ? "diff" : "chat")));
  for (const record of records) {
    expect(record.blockCount).toBeGreaterThan(0);
    expect(record.captureMs).toBeLessThan(CAPTURE_BUDGET_MS);
    expect(record.firstDeltaMs).not.toBeNull();
  }
});
