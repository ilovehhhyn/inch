// Invariant: the Claude latency probe refuses to start without an explicit dollar cap, before it reads a key or sends any request.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const PROBE = join(import.meta.dirname, "../../spikes/probe-claude.mjs");

/** Runs the probe with an empty environment plus `env`, so nothing from the developer's shell can supply a cap or a key. */
async function runProbe(env: Readonly<Record<string, string>>): Promise<Readonly<{ code: number; stderr: string; stdout: string }>> {
  try {
    const { stdout, stderr } = await run(process.execPath, [PROBE], { env: { PATH: "/usr/bin:/bin", ...env } });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failure = error as { code: number; stderr: string; stdout: string }; // execFile rejects with the child's exit code and output
    return { code: failure.code, stderr: failure.stderr, stdout: failure.stdout };
  }
}

test.each([
  ["no cap variable", {}, "MARGIN_SPIKE_USD_CAP is not set; set it to the dollar cap Helen approved, for example MARGIN_SPIKE_USD_CAP=1"],
  ["an empty cap", { MARGIN_SPIKE_USD_CAP: "" }, "MARGIN_SPIKE_USD_CAP is not set"],
  ["a cap that is not a number", { MARGIN_SPIKE_USD_CAP: "a dollar" }, "MARGIN_SPIKE_USD_CAP must be a positive number of dollars, got `a dollar`"],
  ["a cap of zero", { MARGIN_SPIKE_USD_CAP: "0" }, "must be a positive number of dollars, got `0`"],
  ["a negative cap", { MARGIN_SPIKE_USD_CAP: "-2" }, "must be a positive number of dollars, got `-2`"],
])("%s stops the probe with a message naming the fix and sends nothing", async (_name, env, fragment) => {
  const result = await runProbe(env);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(fragment);
  expect(result.stdout).toBe("");
});
