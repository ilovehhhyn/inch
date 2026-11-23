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

/** Config keys that name a content filter: `filter.<driver>.clean`, `.process`, `.smudge` or `.required`; the driver name may contain dots. */
const FILTER_KEY = /^filter\.(.+)\.(clean|process|smudge|required)$/;

/** Git exits with 1 when `config --get-regexp` matches nothing. */
const GIT_CONFIG_NO_MATCH = 1;

type GitRunner = (args: ReadonlyArray<string>) => Promise<string>;

/** The driver names in the repository, user and system configuration; reading them runs no filter. */
export function filterDriverNames(configKeys: string): Array<string> {
  const names = new Set<string>();
  for (const key of configKeys.split("\n")) {
    const match = FILTER_KEY.exec(key.trim());
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}

type ConfigPair = Readonly<{ key: string; value: string }>;

/** Settings that blank every command of every configured filter driver and drop `required`, so that no driver runs and none fails the diff. */
function disableFilters(names: ReadonlyArray<string>): Array<ConfigPair> {
  return names.flatMap((name) => [...["clean", "process", "smudge"].map((variable) => ({ key: `filter.${name}.${variable}`, value: "" })), { key: `filter.${name}.required`, value: "false" }]);
}

/**
 * Config overrides travel as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` (git 2.31 or later), because
 * `-c name=value` splits at the first `=` and a driver name may contain one.
 */
function withConfig(env: Readonly<Record<string, string>>, pairs: ReadonlyArray<ConfigPair>): Record<string, string> {
  const configured: Record<string, string> = { ...env, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((pair, index) => {
    configured[`GIT_CONFIG_KEY_${index}`] = pair.key;
    configured[`GIT_CONFIG_VALUE_${index}`] = pair.value;
  });
  return configured;
}

async function configuredFilterNames(git: GitRunner): Promise<Array<string>> {
  try {
    return filterDriverNames(await git(["config", "--name-only", "--get-regexp", "^filter\\."]));
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as Record<string, unknown>)["code"] === GIT_CONFIG_NO_MATCH) return [];
    throw error;
  }
}

/** The empty tree of the repository's own hash format; an unborn HEAD is diffed against it. */
async function emptyTree(git: GitRunner): Promise<string> {
  return (await git(["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/** Git exits with 1 when `rev-parse --verify --quiet` finds no such commit; any other failure is a real error. */
const GIT_NO_SUCH_COMMIT = 1;

async function hasCommits(git: GitRunner): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as Record<string, unknown>)["code"] === GIT_NO_SUCH_COMMIT) return false;
    throw error;
  }
}

/**
 * "HEAD" is `git diff HEAD`: staged and unstaged changes together, or against the empty tree before the first commit.
 * "staged" is `git diff --staged`. `core.fsmonitor=false`, `--no-ext-diff`, `--no-textconv` and a blanked command for
 * every configured filter driver stop a repository's own configuration from starting programs (spec rule 9); `git diff`
 * runs `filter.<driver>.clean` on work-tree files whose stat data changed, so the filters need their own override. The
 * explicit prefixes and `core.quotePath=false` keep the header form the parser reads whatever `diff.noprefix` or
 * `diff.mnemonicPrefix` the user set.
 */
function gitArguments(folder: string, base: DiffBase, revision: string): Array<string> {
  const args = ["-C", folder, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-U3"];
  return [...args, base === "staged" ? "--staged" : revision];
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
  const baseConfig: ReadonlyArray<ConfigPair> = [{ key: "core.fsmonitor", value: "false" }, { key: "core.quotePath", value: "false" }];
  const optionsWith = (pairs: ReadonlyArray<ConfigPair>): ExecOptions => ({ timeout: DIFF_TIMEOUT_MS, maxBuffer: DIFF_READ_LIMIT_BYTES, env: withConfig(env, pairs), encoding: "utf8" });
  const git: GitRunner = async (args) => (await exec("git", ["-C", folder, ...args], optionsWith(baseConfig))).stdout;
  try {
    const filterNames = await configuredFilterNames(git);
    const revision = base === "HEAD" && !(await hasCommits(git)) ? await emptyTree(git) : "HEAD";
    const { stdout } = await exec("git", gitArguments(folder, base, revision), optionsWith([...baseConfig, ...disableFilters(filterNames)]));
    return stdout;
  } catch (error) {
    throw failure(folder, error);
  }
}
