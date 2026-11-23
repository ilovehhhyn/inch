// Invariant: git runs with a fixed argument list and environment and a bounded wait, and every failure names the folder.
import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { parseUnifiedDiff } from "../../src/renderer/diff/parse-unified-diff";
import { DIFF_READ_LIMIT_BYTES, DIFF_TIMEOUT_MS, runGitDiff, type ExecFile } from "../../src/main/git-diff";

const run = promisify(nodeExecFile);
const FOLDER = "/Users/example/code/repo";

type Call = Readonly<{ file: string; args: ReadonlyArray<string>; options: Parameters<ExecFile>[2] }>;

function recording(result: Readonly<{ stdout: string; stderr: string }>): { exec: ExecFile; calls: Array<Call> } {
  const calls: Array<Call> = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return result;
    },
  };
}

test("head_runs_git_diff_against_head_with_fixed_arguments_and_an_explicit_environment", async () => {
  const { exec, calls } = recording({ stdout: "diff text", stderr: "" });

  const text = await runGitDiff({ folder: FOLDER, base: "HEAD", exec });

  expect(text).toBe("diff text");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe("git");
  expect(calls[0]?.args).toEqual(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-C", FOLDER, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-U3", "HEAD"]);
  expect(calls[0]?.options.timeout).toBe(DIFF_TIMEOUT_MS);
  expect(calls[0]?.options.maxBuffer).toBe(DIFF_READ_LIMIT_BYTES);
  expect(Object.keys(calls[0]?.options.env ?? {}).sort()).toEqual(["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "HOME", "LC_ALL", "PATH"]);
  expect(calls[0]?.options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
});

test("staged_adds_the_staged_flag_and_nothing_else", async () => {
  const { exec, calls } = recording({ stdout: "", stderr: "" });

  await runGitDiff({ folder: FOLDER, base: "staged", exec });

  expect(calls[0]?.args.slice(-2)).toEqual(["-U3", "--staged"]);
  expect(calls[0]?.args).not.toContain("HEAD");
});

test("git_failure_message_names_the_folder", async () => {
  const exec: ExecFile = async () => {
    throw Object.assign(new Error("Command failed"), { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" });
  };

  await expect(runGitDiff({ folder: FOLDER, base: "HEAD", exec })).rejects.toThrow(`git diff failed in ${FOLDER}: fatal: not a git repository (or any of the parent directories): .git`);
});

test("a_timeout_names_the_folder_and_the_limit", async () => {
  const exec: ExecFile = async () => {
    throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", stderr: "" });
  };

  await expect(runGitDiff({ folder: FOLDER, base: "HEAD", exec })).rejects.toThrow(`git diff in ${FOLDER} took longer than ${DIFF_TIMEOUT_MS / 1000} s; narrow the diff or check the repository`);
});

test("output_over_the_read_limit_names_the_folder_and_the_limit", async () => {
  const exec: ExecFile = async () => {
    throw Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: "" });
  };

  await expect(runGitDiff({ folder: FOLDER, base: "HEAD", exec })).rejects.toThrow(new RegExp(`git diff in ${FOLDER} printed more than 64 MiB`));
});

test("a_relative_folder_is_rejected_before_git_runs", async () => {
  const { exec, calls } = recording({ stdout: "", stderr: "" });

  await expect(runGitDiff({ folder: "repo", base: "HEAD", exec })).rejects.toThrow(/folder must be an absolute path, got `repo`/);

  expect(calls).toEqual([]);
});

test("a_staged_change_and_an_unstaged_change_both_appear_against_head", async () => {
  const folder = await mkdtemp(join(tmpdir(), "margin-git-"));
  const git = (...args: Array<string>) => run("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  await git("init", "-q");
  await writeFile(join(folder, "a.txt"), "one\n");
  await writeFile(join(folder, "b.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  await writeFile(join(folder, "a.txt"), "staged\n");
  await git("add", "a.txt");
  await writeFile(join(folder, "b.txt"), "unstaged\n");

  const text = await runGitDiff({ folder, base: "HEAD" });

  expect(text).toContain("+staged");
  expect(text).toContain("+unstaged");
});

test("user_git_settings_for_prefixes_and_quoting_do_not_change_the_header_form", async () => {
  const folder = await mkdtemp(join(tmpdir(), "margin-git-"));
  const git = (...args: Array<string>) => run("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  await git("init", "-q");
  await git("config", "diff.noprefix", "true");
  await git("config", "core.quotePath", "true");
  await writeFile(join(folder, "café.py"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  await writeFile(join(folder, "café.py"), "two\n");

  const text = await runGitDiff({ folder, base: "HEAD" });

  expect(text).toContain("diff --git a/café.py b/café.py");
  expect(parseUnifiedDiff(text).find((row) => row.kind === "add")?.file).toBe("café.py");
});

test("a_real_repository_gives_a_diff_with_the_changed_line", async () => {
  const folder = await mkdtemp(join(tmpdir(), "margin-git-"));
  const git = (...args: Array<string>) => run("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  await git("init", "-q");
  await writeFile(join(folder, "a.txt"), "one\ntwo\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first");
  await writeFile(join(folder, "a.txt"), "one\nTWO\n");

  const text = await runGitDiff({ folder, base: "HEAD" });

  expect(text).toContain("diff --git a/a.txt b/a.txt");
  expect(text).toContain("+TWO");
});
