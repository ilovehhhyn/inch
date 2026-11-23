// Invariant: the packaging configuration builds an unsigned, non-notarized arm64 disk image and the release job publishes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The settings of a YAML file: its lines without comment lines. */
function settings(path: string): string {
  return read(path).split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

test("the builder config skips signing and names no notarization", () => {
  const config = settings("electron-builder.yml");

  expect(config).toMatch(/^\s+identity: null$/m);
  expect(config).not.toMatch(/notariz/i);
});

test("the builder config builds one arm64 dmg target", () => {
  const config = settings("electron-builder.yml");

  expect(config).toMatch(/target: dmg\n\s+arch: arm64/);
  expect(config.match(/target: /g)).toHaveLength(1);
});

test("the ci package job runs on version tags only and uploads without publishing", () => {
  const workflow = read(".github/workflows/ci.yml");
  const job = workflow.slice(workflow.indexOf("  package:"));

  expect(job).toContain("if: startsWith(github.ref, 'refs/tags/v')");
  expect(job).toContain("--mac dmg --arm64");
  expect(job).not.toMatch(/--publish\s+always|gh release|CSC_LINK|APPLE_ID/);
});

test("every action in the workflow is pinned by a forty-character sha", () => {
  const uses = read(".github/workflows/ci.yml").split("\n").filter((line) => line.includes("uses:"));

  expect(uses.length).toBeGreaterThan(0);
  for (const line of uses) expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/);
});
