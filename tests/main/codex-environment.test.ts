// Invariant: the app-server child starts from an explicit allowlisted environment that never carries provider secrets.
import { expect, test } from "vitest";

import { buildCodexEnvironment } from "../../src/main/codex-environment";

const PARENT = {
  HOME: "/Users/example",
  USER: "example",
  LANG: "en_US.UTF-8",
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  ANTHROPIC_AUTH_TOKEN: "token",
  ANTHROPIC_PROFILE: "work",
  OPENAI_API_KEY: "sk-openai-secret",
  RANDOM_VARIABLE: "x",
};

test("the_login_shell_path_replaces_the_app_path", () => {
  expect(buildCodexEnvironment(PARENT, "/opt/homebrew/bin:/usr/bin")["PATH"]).toBe("/opt/homebrew/bin:/usr/bin");
});

test("only_allowlisted_variables_are_passed", () => {
  const environment = buildCodexEnvironment(PARENT, "/usr/bin");

  expect(environment).toEqual({ HOME: "/Users/example", USER: "example", LANG: "en_US.UTF-8", PATH: "/usr/bin" });
});

test("provider_secrets_are_never_passed_to_the_child", () => {
  const names = Object.keys(buildCodexEnvironment(PARENT, "/usr/bin"));

  for (const secret of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "OPENAI_API_KEY"]) {
    expect(names).not.toContain(secret);
  }
});

test("a_missing_home_is_an_error_naming_the_fix", () => {
  expect(() => buildCodexEnvironment({ PATH: "/usr/bin" }, "/usr/bin")).toThrow(/HOME is not set; launch Margin from Finder or a normal shell/);
});

test("the_output_order_is_sorted_by_name", () => {
  expect(Object.keys(buildCodexEnvironment({ LANG: "x", HOME: "/h", USER: "u" }, "/p"))).toEqual(["HOME", "LANG", "PATH", "USER"]);
});
