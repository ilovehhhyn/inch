// Runs `git diff` for a folder the user chose, with fixed arguments, an explicit environment and bounded time and output.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

export const DIFF_TIMEOUT_MS = 10 * 1000;

/** The most output git may print before the read stops; far above the pane's own limit so the pane can report the real size. */
export const DIFF_READ_LIMIT_BYTES = 64 * 1024 * 1024;

/** Where macOS and Homebrew put git; the app's own PATH under Electron is shorter than a shell's. */
const GIT_SEARCH_PATH = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";

export type ExecOptions = Readonly<{ timeout: number; maxBuffer: number; env: Readonly<Record<string, string>>; encoding: "utf8" }>;
export type ExecFile = (file: string, args: ReadonlyArray<string>, options: ExecOptions) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const nodeExecFile: ExecFile = (file, args, options) => promisify(execFile)(file, [...args], { ...options, env: { ...options.env } });

export type DiffBase = "HEAD" | "staged";

export type GitDiffOptions = Readonly<{ folder: string; base: DiffBase; exec?: ExecFile }>;

/**
 * "HEAD" is the working tree against the index, as plain `git diff`; "staged" adds `--staged`. `core.fsmonitor=false`
 * and `--no-textconv` stop a repository's own configuration from starting programs (spec rule 9).
 */
function gitArguments(folder: string, base: DiffBase): Array<string> {
  const args = ["-c", "core.fsmonitor=false", "-C", folder, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"];
  return base === "staged" ? [...args, "--staged"] : args;
}

function failure(folder: string, error: unknown): Error {
  const details = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}; // a failed child process carries `killed`, `code` and `stderr`
  if (details["code"] === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error(`git diff in ${folder} printed more than ${DIFF_READ_LIMIT_BYTES / (1024 * 1024)} MiB; narrow the diff to fewer files`);
  if (details["killed"] === true) return new Error(`git diff in ${folder} took longer than ${DIFF_TIMEOUT_MS / 1000} s; narrow the diff or check the repository`);
  const stderr = typeof details["stderr"] === "string" ? details["stderr"].trim() : "";
  const reason = stderr === "" ? (error instanceof Error ? error.message : String(error)) : stderr;
  return new Error(`git diff failed in ${folder}: ${reason}`, { cause: error });
}

export async function runGitDiff(options: GitDiffOptions): Promise<string> {
  const { folder, base, exec = nodeExecFile } = options;
  if (!isAbsolute(folder)) throw new Error(`folder must be an absolute path, got \`${folder}\`; choose the folder with the folder dialog`);
  const env = { PATH: GIT_SEARCH_PATH, HOME: homedir(), LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  try {
    const { stdout } = await exec("git", gitArguments(folder, base), { timeout: DIFF_TIMEOUT_MS, maxBuffer: DIFF_READ_LIMIT_BYTES, env, encoding: "utf8" });
    return stdout;
  } catch (error) {
    throw failure(folder, error);
  }
}
