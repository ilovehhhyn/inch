// Invariant: a Claude chat sends the text of the pane scrolled last in the same user message as the question, changes nothing on screen, and an API key is checked before it is saved.
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { startFakeAnthropicServer, type FakeAnthropicServer } from "./fake-anthropic-server";
import { createRepositoryWithDiff, launchMargin, REPOSITORY_ROOT, stubFolderDialog, type RunningMargin } from "./support";

const WARMUP_DIFF = join(REPOSITORY_ROOT, "tests/fixtures/warmup.diff");
const API_KEY = "sk-ant-test-123";
const WHEEL_STEP_PX = 600;
/** Chromium's mock keychain lets safeStorage work in a test run without opening the real macOS keychain. */
const MOCK_KEYCHAIN_SWITCH = "--use-mock-keychain";

let margin: RunningMargin | null = null;
let anthropic: FakeAnthropicServer | null = null;

test.afterEach(async () => {
  await margin?.app.close();
  await anthropic?.close();
  margin = null;
  anthropic = null;
});

async function pageOutsideThreads(page: Page): Promise<string> {
  return page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement; // a detached copy, so removing the threads leaves the live page alone
    copy.querySelectorAll(".thread").forEach((thread) => thread.remove());
    return copy.innerHTML;
  });
}

async function wheelOverDiff(page: Page): Promise<void> {
  const pane = page.locator(".diff-pane .view");
  const box = await pane.boundingBox();
  if (box === null) throw new Error("the diff pane has no box on screen");
  const top = await pane.evaluate((element) => element.scrollTop);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, WHEEL_STEP_PX);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).not.toBe(top);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function startSignedOut(): Promise<Readonly<{ running: RunningMargin; server: FakeAnthropicServer }>> {
  const server = await startFakeAnthropicServer();
  anthropic = server;
  const running = await launchMargin({ signedOut: true, env: { MARGIN_ANTHROPIC_BASE_URL: server.url }, switches: [MOCK_KEYCHAIN_SWITCH] });
  margin = running;
  return { running, server };
}

test("a_rejected_api_key_is_not_saved_and_an_accepted_one_opens_the_app", async () => {
  const { running, server } = await startSignedOut();
  const { page } = running;
  await page.getByRole("button", { name: "Use an Anthropic API key" }).click();
  server.rejectNextKey();
  await page.getByLabel("Anthropic API key").fill("sk-ant-bad");
  await page.getByRole("button", { name: "Save Anthropic API key" }).click();

  await expect(page.getByText(/Anthropic rejected this API key/)).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);

  await page.getByLabel("Anthropic API key").fill(API_KEY);
  await page.getByRole("button", { name: "Save Anthropic API key" }).click();

  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  expect(server.modelRequests.map((request) => request.authorization)).toEqual(["Bearer sk-ant-bad", `Bearer ${API_KEY}`]);
  expect(await page.evaluate(() => document.body.textContent)).not.toContain(API_KEY);
});

test("claude_diff_scenario_from_the_film", async () => {
  const { running, server } = await startSignedOut();
  const { page, scratchPath } = running;
  await page.getByRole("button", { name: "Use an Anthropic API key" }).click();
  await page.getByLabel("Anthropic API key").fill(API_KEY);
  await page.getByRole("button", { name: "Save Anthropic API key" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const repository = await createRepositoryWithDiff(scratchPath, await readFile(WARMUP_DIFF, "utf8"));
  await stubFolderDialog(running.app, repository);
  await page.getByRole("button", { name: "Choose a folder" }).click();
  await expect(page.locator(".diff-pane")).toContainText("get_lr");

  const main = page.getByRole("region", { name: "Chat", exact: true });
  await page.getByLabel("Message", { exact: true }).fill("hello");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(main).toContainText("Fake Claude answer");
  await main.getByRole("button", { name: "Open side chat" }).click();
  const side = page.getByRole("region", { name: "Side chat" });
  await side.getByLabel("Side chat message").fill("what is a warmup?");
  await side.getByLabel("Side chat message").press("Enter");
  await expect(side).toContainText("Fake Claude answer");
  await wheelOverDiff(page);
  const before = await pageOutsideThreads(page);
  await page.getByLabel("Message", { exact: true }).fill("does this look right?");
  await page.getByLabel("Message", { exact: true }).press("Meta+i");

  await expect(main).toContainText("get_lr()");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  const contextRequest = server.messagesRequests.find((request) => JSON.stringify(request.body.messages.at(-1)).includes("does this look right?"));
  const lastMessage = contextRequest?.body.messages.at(-1);
  expect(lastMessage?.role).toBe("user");
  expect(Array.isArray(lastMessage?.content) ? lastMessage.content.map((block) => block.type) : []).toEqual(["text", "text"]);
  const [contextBlock, questionBlock] = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
  expect(contextBlock?.text).toContain("--- train.py line 39");
  expect(contextBlock?.text).toContain("pane: diff");
  expect(questionBlock?.text).toBe("does this look right?");
  expect(contextRequest?.body["model"]).toBe("claude-opus-5-5");
  expect(contextRequest?.body["output_config"]).toEqual({ effort: "low" });
  expect(contextRequest?.beta).toContain("server-side-fallback-2026-07-01");
  expect(server.messagesRequests.filter((request) => JSON.stringify(request.body.messages).includes("MARGIN SCREEN CONTEXT"))).toHaveLength(1);
  expect(await pageOutsideThreads(page)).toBe(before);
});

test("a_reloaded_claude_chat_is_read_from_its_file_without_its_context_block", async () => {
  const { running, server } = await startSignedOut();
  const { page } = running;
  await page.getByRole("button", { name: "Use an Anthropic API key" }).click();
  await page.getByLabel("Anthropic API key").fill(API_KEY);
  await page.getByRole("button", { name: "Save Anthropic API key" }).click();
  const main = page.getByRole("region", { name: "Chat", exact: true });
  await page.getByLabel("Message", { exact: true }).fill("first question");
  await page.getByLabel("Message", { exact: true }).press("Meta+i");
  await expect(main).toContainText("Fake Claude answer");
  expect(server.messagesRequests).toHaveLength(1);

  await page.reload();
  await page.getByRole("button", { name: "first question" }).click();

  await expect(main).toContainText("Fake Claude answer");
  await expect(main).not.toContainText("MARGIN SCREEN CONTEXT");
});
