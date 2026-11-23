// Configures the end-to-end tests: one worker, because each test starts the whole Margin window and a scripted Codex.
import { defineConfig } from "@playwright/test";

/** A test starts Electron, builds a repository and sends up to 20 messages; two minutes bounds a hang without cutting a slow machine. */
const TEST_TIMEOUT_MS = 120 * 1000;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: TEST_TIMEOUT_MS,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
});
