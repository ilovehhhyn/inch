// Finds the user's codex executable through the login-shell PATH and checks its version before anything starts it.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { codexMissingError, INSTALL_COMMAND, parseCodexVersion, requireSupportedCodex } from "../codex/codex-version";
import { StartupError } from "../shared/startup-error";

/** `codex --version` prints one line and returns at once; 5 s means the install is broken or hung. */
export const VERSION_TIMEOUT_MS = 5 * 1000;

/** Apps started from Finder get a minimal PATH, so the user's own PATH is read from a login shell. */
const LOGIN_SHELL = "/bin/zsh";
const LOGIN_SHELL_TIMEOUT_MS = 5 * 1000;

export type StartupServices = Readonly<{
  readLoginShellPath(): Promise<string>;
  isExecutable(path: string): Promise<boolean>;
  runCodexVersion(codexPath: string): Promise<string>;
}>;

export type LocatedCodex = Readonly<{ codexPath: string; version: string; loginShellPath: string }>;

function run(file: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error.killed ? new Error(`timed out after ${timeoutMs} ms`) : error);
    });
  });
}

export const nodeStartupServices: StartupServices = {
  readLoginShellPath: () => run(LOGIN_SHELL, ["-lc", 'printf %s "$PATH"'], LOGIN_SHELL_TIMEOUT_MS),
  isExecutable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false; // not executable or absent: both mean "not this candidate"
    }
  },
  runCodexVersion: (codexPath) => run(codexPath, ["--version"], VERSION_TIMEOUT_MS),
};

function missing(reason: string): StartupError {
  return new StartupError({ kind: "codex-missing", message: `codex was not found on PATH (${reason}); install it with \`${INSTALL_COMMAND}\``, fix: INSTALL_COMMAND });
}

async function findOnPath(pathValue: string, services: StartupServices): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "codex");
    if (await services.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function checkVersion(codexPath: string, services: StartupServices): Promise<string> {
  let output: string;
  try {
    output = await services.runCodexVersion(codexPath);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new StartupError({ kind: "codex-version", message: `${codexPath} --version failed: ${cause}; reinstall it with \`${INSTALL_COMMAND}\``, fix: INSTALL_COMMAND });
  }
  let version: string;
  try {
    version = parseCodexVersion(output);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new StartupError({ kind: "codex-version", message: `${codexPath} --version ${cause}; reinstall it with \`${INSTALL_COMMAND}\``, fix: INSTALL_COMMAND });
  }
  requireSupportedCodex(version);
  return version;
}

async function readPath(services: StartupServices): Promise<string> {
  try {
    return await services.readLoginShellPath();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw missing(`could not read PATH from a login shell: ${cause}`);
  }
}

async function requireOverride(override: string, services: StartupServices): Promise<void> {
  if (!isAbsolute(override)) throw new StartupError({ kind: "codex-missing", message: `MARGIN_CODEX_PATH must be an absolute path, got \`${override}\`; unset it or give the full path`, fix: "unset MARGIN_CODEX_PATH" });
  if (!(await services.isExecutable(override))) throw new StartupError({ kind: "codex-missing", message: `MARGIN_CODEX_PATH is \`${override}\`, which is not an executable file; fix the path or unset it`, fix: "unset MARGIN_CODEX_PATH" });
}

/**
 * Returns the codex to run after checking its version; throws a StartupError otherwise. The first `codex` on the
 * login-shell PATH is used, or `codexPathOverride` (the value of MARGIN_CODEX_PATH, which the end-to-end tests use to
 * start a scripted stand-in); an override that cannot run is an error, never a reason to search the PATH.
 */
export async function locateCodex(services: StartupServices = nodeStartupServices, codexPathOverride?: string): Promise<LocatedCodex> {
  if (codexPathOverride !== undefined) await requireOverride(codexPathOverride, services);
  const pathValue = await readPath(services);
  const codexPath = codexPathOverride ?? (await findOnPath(pathValue, services));
  if (codexPath === undefined) throw codexMissingError();
  return { codexPath, version: await checkVersion(codexPath, services), loginShellPath: pathValue };
}
