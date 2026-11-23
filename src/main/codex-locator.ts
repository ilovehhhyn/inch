// Finds the user's codex executable through the login-shell PATH and checks its version before anything starts it.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

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

export type LocatedCodex = Readonly<{ codexPath: string; version: string }>;

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

/** Returns the first `codex` on the login-shell PATH after checking its version; throws a StartupError otherwise. */
export async function locateCodex(services: StartupServices = nodeStartupServices): Promise<LocatedCodex> {
  let pathValue: string;
  try {
    pathValue = await services.readLoginShellPath();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw missing(`could not read PATH from a login shell: ${cause}`);
  }
  const codexPath = await findOnPath(pathValue, services);
  if (codexPath === undefined) throw codexMissingError();
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
  return { codexPath, version };
}
