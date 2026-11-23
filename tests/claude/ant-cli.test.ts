// Invariant: Margin runs `ant` only for its own `margin` profile, with an argument array, no ANTHROPIC credential in the environment and a time limit.
import { expect, test } from "vitest";

import { AntCliError, ANT_INSTALL_MESSAGE, buildAntEnvironment, createAntCli, type AntExec, type AntExecOptions } from "../../src/claude/ant-cli";

type Call = Readonly<{ file: string; args: ReadonlyArray<string>; options: AntExecOptions }>;

function recordingExec(result: Readonly<{ stdout: string; stderr?: string }> | Error): Readonly<{ exec: AntExec; calls: Array<Call> }> {
  const calls: Array<Call> = [];
  const exec: AntExec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

function failure(fields: Readonly<{ code?: string | number; killed?: boolean; stdout?: string; stderr?: string }>): Error {
  return Object.assign(new Error("Command failed"), fields);
}

const ENVIRONMENT = { HOME: "/Users/example", PATH: "/opt/homebrew/bin" };

test("each_call_uses_an_argument_array_for_the_margin_profile_only", async () => {
  const { exec, calls } = recordingExec({ stdout: "ant 2.9.0\n" });
  const ant = createAntCli({ exec, environment: ENVIRONMENT });

  await ant.version();
  await ant.login("margin");
  await ant.logout("margin");

  expect(calls.map((call) => [call.file, call.args])).toEqual([
    ["ant", ["--version"]],
    ["ant", ["auth", "login", "--profile", "margin"]],
    ["ant", ["auth", "logout", "--profile", "margin"]],
  ]);
});

test("the_access_token_is_read_with_the_access_token_flag_and_trimmed", async () => {
  const { exec, calls } = recordingExec({ stdout: "  sk-ant-oat-abc\n" });

  const token = await createAntCli({ exec, environment: ENVIRONMENT }).accessToken("margin");

  expect(token).toBe("sk-ant-oat-abc");
  expect(calls[0]?.args).toEqual(["auth", "print-credentials", "--access-token", "--profile", "margin"]);
});

test("login_may_take_five_minutes_and_every_other_call_ten_seconds", async () => {
  const { exec, calls } = recordingExec({ stdout: "ok\n" });
  const ant = createAntCli({ exec, environment: ENVIRONMENT });

  await ant.version();
  await ant.login("margin");
  await ant.accessToken("margin");
  await ant.logout("margin");

  expect(calls.map((call) => call.options.timeoutMs)).toEqual([10_000, 5 * 60 * 1000, 10_000, 10_000]);
});

test("every_call_gets_the_explicit_environment_and_nothing_from_the_parent", async () => {
  const { exec, calls } = recordingExec({ stdout: "ok\n" });

  await createAntCli({ exec, environment: ENVIRONMENT }).version();

  expect(calls[0]?.options.environment).toEqual(ENVIRONMENT);
});

test("environment_credentials_are_ignored_by_the_environment_passed_to_ant", () => {
  const parent = { HOME: "/Users/example", USER: "example", ANTHROPIC_API_KEY: "stale", ANTHROPIC_AUTH_TOKEN: "stale", ANTHROPIC_PROFILE: "other", ANTHROPIC_BASE_URL: "http://elsewhere.example", UNRELATED: "x" };

  const environment = buildAntEnvironment(parent, "/opt/homebrew/bin:/usr/bin");

  expect(environment).toEqual({ HOME: "/Users/example", PATH: "/opt/homebrew/bin:/usr/bin", USER: "example" });
  expect(Object.keys(environment).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
});

test("a_missing_home_directory_is_an_error", () => {
  expect(() => buildAntEnvironment({}, "/usr/bin")).toThrow("HOME is not set; launch Margin from Finder or a normal shell");
});

test("missing_ant_names_the_install_step", async () => {
  const { exec } = recordingExec(failure({ code: "ENOENT" }));

  const error = await createAntCli({ exec, environment: ENVIRONMENT }).version().then(() => null, (caught: unknown) => caught);

  expect(error).toBeInstanceOf(AntCliError);
  expect((error as AntCliError).kind).toBe("not-installed");
  expect((error as AntCliError).message).toBe(ANT_INSTALL_MESSAGE);
  expect(ANT_INSTALL_MESSAGE).toBe("ant was not found on PATH; install it with `brew install anthropics/tap/ant` as described in Anthropic's CLI docs, or use an API key instead");
});

test("a_call_that_runs_out_of_time_is_a_timeout_that_names_the_limit", async () => {
  const { exec } = recordingExec(failure({ killed: true }));

  const error = await createAntCli({ exec, environment: ENVIRONMENT }).accessToken("margin").then(() => null, (caught: unknown) => caught);

  expect((error as AntCliError).kind).toBe("timeout");
  expect((error as AntCliError).message).toBe("`ant auth print-credentials` did not finish within 10 s; run it in a terminal to see what it is waiting for");
});

test("a_failed_call_reports_stderr_and_never_what_it_printed_on_stdout", async () => {
  const { exec } = recordingExec(failure({ code: 1, stdout: "sk-ant-oat-secret", stderr: "cannot remove the profile\n" }));

  const error = await createAntCli({ exec, environment: ENVIRONMENT }).logout("margin").then(() => null, (caught: unknown) => caught);

  expect((error as AntCliError).kind).toBe("failed");
  expect((error as AntCliError).message).toBe("`ant auth logout` failed: cannot remove the profile");
  expect((error as AntCliError).message).not.toContain("sk-ant-oat-secret");
});

test("a_non_zero_exit_of_print_credentials_means_the_profile_has_no_usable_login", async () => {
  const { exec } = recordingExec(failure({ code: 1, stdout: "sk-ant-oat-secret", stderr: "no credentials for profile margin\n" }));

  const error = await createAntCli({ exec, environment: ENVIRONMENT }).accessToken("margin").then(() => null, (caught: unknown) => caught);

  expect((error as AntCliError).kind).toBe("not-signed-in");
  expect((error as AntCliError).message).toContain("no credentials for profile margin");
  expect((error as AntCliError).message).not.toContain("sk-ant-oat-secret");
});

test("an_empty_token_is_an_error_not_an_empty_credential", async () => {
  const { exec } = recordingExec({ stdout: "\n" });

  await expect(createAntCli({ exec, environment: ENVIRONMENT }).accessToken("margin")).rejects.toThrow("`ant auth print-credentials --access-token` printed no token");
});
