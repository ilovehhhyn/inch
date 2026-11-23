// Runs the user's `ant` CLI for Margin's own `margin` profile, with an argument array, an explicit environment and a time limit per call.
import { execFile } from "node:child_process";

/** The one profile Margin uses; it never reads, switches or deletes another `ant` profile or Claude Code's login. */
export type AntProfile = "margin";

export const ANT_INSTALL_MESSAGE = "ant was not found on PATH; install it with `brew install anthropics/tap/ant` as described in Anthropic's CLI docs, or use an API key instead";

/** `ant auth login` waits for the person to finish signing in in the browser. */
export const ANT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Every other call returns at once; ten seconds means `ant` is hung. */
export const ANT_QUICK_TIMEOUT_MS = 10 * 1000;

const STDERR_SHOWN_CHARS = 500;
/** Only these variables reach `ant`; every ANTHROPIC_ variable is left out, because a stale key or token would override the profile. */
const ALLOWED_VARIABLES: ReadonlyArray<string> = ["HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LOGNAME", "NO_PROXY", "SHELL", "TMPDIR", "USER"];

export type AntCliErrorKind = "not-installed" | "not-signed-in" | "timeout" | "failed";

export class AntCliError extends Error {
  readonly kind: AntCliErrorKind;

  constructor(kind: AntCliErrorKind, message: string) {
    super(message);
    this.name = "AntCliError";
    this.kind = kind;
  }
}

export type AntExecOptions = Readonly<{ environment: Readonly<Record<string, string>>; timeoutMs: number }>;

/** Runs `file` with `args`; rejects with the child's `code`, `killed`, `stdout` and `stderr` when it fails, as Node's `execFile` does. */
export type AntExec = (file: string, args: ReadonlyArray<string>, options: AntExecOptions) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type AntCli = {
  version(): Promise<string>;
  login(profile: AntProfile): Promise<void>;
  accessToken(profile: AntProfile): Promise<string>;
  logout(profile: AntProfile): Promise<void>;
};

export const nodeAntExec: AntExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env: { ...options.environment }, timeout: options.timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve({ stdout, stderr });
      else reject(Object.assign(error, { stdout, stderr }));
    });
  });

/** Builds the environment of every `ant` call from an allowlist plus the login-shell PATH. */
export function buildAntEnvironment(parent: Readonly<Record<string, string | undefined>>, loginShellPath: string): Readonly<Record<string, string>> {
  if (parent["HOME"] === undefined) throw new Error("HOME is not set; launch Margin from Finder or a normal shell");
  const environment: Record<string, string> = { PATH: loginShellPath };
  for (const name of ALLOWED_VARIABLES) {
    const value = parent[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}

type ExecFailure = Readonly<{ code?: string | number; killed?: boolean; stderr?: string }>;

/** Names a failed call by what went wrong; stdout is never quoted, because for `print-credentials` it holds the token. */
function toAntError(failure: ExecFailure, command: string, timeoutMs: number): AntCliError {
  if (failure.code === "ENOENT") return new AntCliError("not-installed", ANT_INSTALL_MESSAGE);
  if (failure.killed === true) return new AntCliError("timeout", `\`${command}\` did not finish within ${timeoutMs / 1000} s; run it in a terminal to see what it is waiting for`);
  const stderr = (failure.stderr ?? "").trim().slice(-STDERR_SHOWN_CHARS);
  return new AntCliError("failed", `\`${command}\` failed${stderr === "" ? "" : `: ${stderr}`}`);
}

export type AntCliOptions = Readonly<{ exec: AntExec; environment: Readonly<Record<string, string>> }>;

export function createAntCli(options: AntCliOptions): AntCli {
  async function run(args: ReadonlyArray<string>, timeoutMs: number): Promise<string> {
    const command = `ant ${args.filter((argument) => !argument.startsWith("--")).slice(0, 2).join(" ")}`.trim();
    try {
      return (await options.exec("ant", args, { environment: options.environment, timeoutMs })).stdout;
    } catch (error) {
      throw toAntError(error as ExecFailure, command, timeoutMs); // execFile rejects with the child's code, killed and stderr
    }
  }
  return {
    async version() {
      return (await run(["--version"], ANT_QUICK_TIMEOUT_MS)).trim();
    },
    async login(profile) {
      await run(["auth", "login", "--profile", profile], ANT_LOGIN_TIMEOUT_MS);
    },
    /**
     * A non-zero exit means the profile has no usable login: `ant` is not installed here, so what it exits with for a
     * missing or expired profile was not observed, and any other reading would show an error to every person who has not
     * signed in. A missing `ant` and a timeout keep their own kinds.
     */
    async accessToken(profile) {
      const output = await run(["auth", "print-credentials", "--access-token", "--profile", profile], ANT_QUICK_TIMEOUT_MS).catch((error: unknown) => {
        if (error instanceof AntCliError && error.kind === "failed") throw new AntCliError("not-signed-in", `ant has no usable login for the ${profile} profile: ${error.message}`);
        throw error;
      });
      const token = output.trim();
      if (token === "") throw new AntCliError("not-signed-in", "`ant auth print-credentials --access-token` printed no token; sign in again");
      return token;
    },
    async logout(profile) {
      await run(["auth", "logout", "--profile", profile], ANT_QUICK_TIMEOUT_MS);
    },
  };
}
