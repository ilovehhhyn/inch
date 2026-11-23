// Invariant: Margin finds codex through the login-shell PATH, runs `codex --version` once and fails closed with a StartupError.
import { expect, test } from "vitest";

import { INSTALL_COMMAND } from "../../src/codex/codex-version";
import { locateCodex, type StartupServices } from "../../src/main/codex-locator";
import { StartupError } from "../../src/shared/startup-error";

type FakeOptions = Readonly<{
  loginShellPath?: string | Error;
  executables?: ReadonlyArray<string>;
  versionOutput?: string | Error;
}>;

function fakeServices(options: FakeOptions): StartupServices & { readonly versionRuns: Array<string> } {
  const versionRuns: Array<string> = [];
  return {
    versionRuns,
    async readLoginShellPath() {
      const path = options.loginShellPath ?? "/usr/bin";
      if (path instanceof Error) throw path;
      return path;
    },
    async isExecutable(candidate) {
      return (options.executables ?? []).includes(candidate);
    },
    async runCodexVersion(codexPath) {
      versionRuns.push(codexPath);
      const output = options.versionOutput ?? "codex-cli 0.146.0\n";
      if (output instanceof Error) throw output;
      return output;
    },
  };
}

async function startupErrorFrom(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError; // narrowed by the assertion above
}

test("first_codex_in_login_shell_path_order_is_used", async () => {
  const services = fakeServices({ loginShellPath: "/opt/homebrew/bin:/usr/local/bin", executables: ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"] });

  const located = await locateCodex(services);

  expect(located).toEqual({ codexPath: "/opt/homebrew/bin/codex", version: "0.146.0", loginShellPath: "/opt/homebrew/bin:/usr/local/bin" });
  expect(services.versionRuns).toEqual(["/opt/homebrew/bin/codex"]);
});

test("empty_path_entries_are_skipped_not_read_as_the_current_directory", async () => {
  const services = fakeServices({ loginShellPath: ":/usr/bin::", executables: ["codex"] });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.info.kind).toBe("codex-missing");
  expect(services.versionRuns).toEqual([]);
});

test("codex_absent_from_the_path_is_codex_missing_and_runs_nothing", async () => {
  const services = fakeServices({ loginShellPath: "/usr/bin:/bin", executables: [] });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.message).toBe(`codex was not found on PATH; install it with \`${INSTALL_COMMAND}\``);
  expect(services.versionRuns).toEqual([]);
});

test("unreadable_login_shell_path_is_an_error_not_a_fallback_to_the_app_path", async () => {
  const services = fakeServices({ loginShellPath: new Error("zsh exited with code 1"), executables: ["/usr/bin/codex"] });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.info.kind).toBe("codex-missing");
  expect(error.message).toContain("zsh exited with code 1");
  expect(error.message).toContain("login shell");
  expect(services.versionRuns).toEqual([]);
});

test("a_version_command_failure_is_codex_version_with_the_cause", async () => {
  const services = fakeServices({ loginShellPath: "/usr/bin", executables: ["/usr/bin/codex"], versionOutput: new Error("timed out after 5000 ms") });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.info.kind).toBe("codex-version");
  expect(error.message).toContain("/usr/bin/codex --version");
  expect(error.message).toContain("timed out after 5000 ms");
  expect(error.info.fix).toBe(INSTALL_COMMAND);
});

test("unrecognised_version_output_is_codex_version", async () => {
  const services = fakeServices({ loginShellPath: "/usr/bin", executables: ["/usr/bin/codex"], versionOutput: "hello\n" });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.info.kind).toBe("codex-version");
  expect(error.message).toContain("hello");
});

test("an_unsupported_version_is_rejected_after_it_is_found", async () => {
  const services = fakeServices({ loginShellPath: "/usr/bin", executables: ["/usr/bin/codex"], versionOutput: "codex-cli 0.150.1\n" });

  const error = await startupErrorFrom(locateCodex(services));

  expect(error.info.kind).toBe("codex-version");
  expect(error.message).toContain("0.150.1");
});
