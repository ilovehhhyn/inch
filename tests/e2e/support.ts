// Starts the built Margin app against a scripted Codex and builds the repositories its diff pane reads.
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseLatencyRecord, type LatencyRecord } from "../../src/shared/latency-record";

const run = promisify(execFile);
const GIT_IDENTITY = ["-c", "user.name=Margin Test", "-c", "user.email=test@example.invalid"];

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
export const MAIN_ENTRY = join(REPOSITORY_ROOT, "out/main/main.js");
export const FAKE_CODEX_SCRIPT = join(REPOSITORY_ROOT, "tests/e2e/fake-codex.mjs");

export type LaunchOptions = Readonly<{
  /** Path of a seed file with threads the fake Codex already holds. */
  seed?: string;
  signedOut?: boolean;
  /** Extra environment for the Margin process, such as a fake Anthropic address. */
  env?: Readonly<Record<string, string>>;
  /** Extra Chromium switches. */
  switches?: ReadonlyArray<string>;
}>;

export type RunningMargin = Readonly<{
  app: ElectronApplication;
  page: Page;
  codexLogPath: string;
  metricsPath: string;
  userDataPath: string;
  scratchPath: string;
}>;

/** Writes a shell wrapper that runs the fake Codex with its log path baked in, because Margin starts Codex with fixed arguments and a minimal environment. */
async function writeCodexWrapper(directory: string, options: LaunchOptions, logPath: string): Promise<string> {
  const flags = [options.seed === undefined ? "" : `--seed "${options.seed}"`, options.signedOut === true ? "--signed-out" : ""].filter((flag) => flag !== "").join(" ");
  const wrapperPath = join(directory, "codex");
  await writeFile(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX_SCRIPT}" --log "${logPath}" ${flags} "$@"\n`, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

export async function launchMargin(options: LaunchOptions = {}): Promise<RunningMargin> {
  const scratchPath = await mkdtemp(join(tmpdir(), "margin-e2e-"));
  const userDataPath = join(scratchPath, "user-data");
  await mkdir(userDataPath);
  const codexLogPath = join(scratchPath, "codex-log.jsonl");
  await writeFile(codexLogPath, "", "utf8");
  const wrapper = await writeCodexWrapper(scratchPath, options, codexLogPath);
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataPath}`, ...(options.switches ?? [])],
    env: { ...process.env, MARGIN_CODEX_PATH: wrapper, ...options.env },
  });
  const page = await app.firstWindow();
  return { app, page, codexLogPath, metricsPath: join(userDataPath, "metrics.jsonl"), userDataPath, scratchPath };
}

export type CodexLogEntry = Readonly<{ method: string; params: unknown }>;

export async function readCodexLog(path: string): Promise<Array<CodexLogEntry>> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as CodexLogEntry); // lines were written by fake-codex.mjs
}

/** The text of every `turn/start` the fake Codex received, items joined as Codex stores them. */
export async function readTurnTexts(path: string): Promise<Array<Readonly<{ threadId: string; text: string }>>> {
  const log = await readCodexLog(path);
  return log
    .filter((entry) => entry.method === "turn/start")
    .map((entry) => {
      const params = entry.params as { threadId: string; input: Array<{ text: string }> }; // shape written by Margin's turn/start request
      return { threadId: params.threadId, text: params.input.map((item) => item.text).join("") };
    });
}

export async function readLatencyRecords(path: string): Promise<Array<LatencyRecord>> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => parseLatencyRecord(JSON.parse(line)));
}

async function git(directory: string, args: ReadonlyArray<string>): Promise<void> {
  await run("git", [...GIT_IDENTITY, ...args], { cwd: directory });
}

type DiffFile = { name: string; oldLines: Map<number, string>; isNew: boolean };

/** The old side of each file in a unified diff: its context and removed lines at their old line numbers. */
function oldSides(diffText: string): Array<DiffFile> {
  const files: Array<DiffFile> = [];
  let current: DiffFile | null = null;
  let oldNumber = 0;
  for (const line of diffText.split("\n")) {
    const header = /^diff --git a\/(.+) b\/.+$/.exec(line);
    if (header !== null) {
      current = { name: header[1] ?? "", oldLines: new Map(), isNew: false };
      files.push(current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldNumber = Number(hunk[1]);
      continue;
    }
    if (current === null || oldNumber === 0 || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) continue;
    if (line.startsWith("-") || line.startsWith(" ")) current.oldLines.set(oldNumber++, line.slice(1));
  }
  return files;
}

/** Creates a repository whose `git diff HEAD` equals `diffText`: filler lines pad each file between the diff's hunks. */
export async function createRepositoryWithDiff(directory: string, diffText: string): Promise<string> {
  const folder = join(directory, "repo");
  await mkdir(folder);
  await git(folder, ["init", "-q"]);
  for (const file of oldSides(diffText)) {
    const last = Math.max(...file.oldLines.keys());
    const lines = Array.from({ length: last }, (_, index) => file.oldLines.get(index + 1) ?? `# filler ${index + 1}`);
    await writeFile(join(folder, file.name), lines.join("\n") + "\n", "utf8");
  }
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "-q", "-m", "base"]);
  const patchPath = join(directory, "change.diff");
  await writeFile(patchPath, diffText, "utf8");
  await git(folder, ["apply", "--unidiff-zero", patchPath]);
  return folder;
}

/** Creates a repository whose diff deletes a file of `lineCount` lines, so the diff pane holds `lineCount` rows. */
export async function createRepositoryWithLargeDiff(directory: string, lineCount: number): Promise<string> {
  const folder = join(directory, "large-repo");
  await mkdir(folder);
  await git(folder, ["init", "-q"]);
  const body = Array.from({ length: lineCount }, (_, index) => `value_${index + 1} = ${index + 1}`).join("\n") + "\n";
  await writeFile(join(folder, "big.py"), body, "utf8");
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "-q", "-m", "base"]);
  await writeFile(join(folder, "big.py"), "", "utf8");
  return folder;
}

/** Makes the folder dialog answer with `folder`, because the real dialog is a native window the test cannot drive. */
export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}
