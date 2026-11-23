// Invariant: only the exact pinned Codex version is accepted, and every refusal names the fix.
import { expect, test } from "vitest";

import { INSTALL_COMMAND, parseCodexVersion, requireSupportedCodex, SUPPORTED_CODEX_VERSION } from "../../src/codex/codex-version";
import { StartupError } from "../../src/shared/startup-error";

function thrownBy(run: () => void): StartupError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    return error as StartupError; // narrowed by the assertion above
  }
  throw new Error("expected the call to throw a StartupError");
}

test("parses_cli_version_line", () => {
  expect(parseCodexVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
});

test("parse_rejects_output_that_is_not_a_codex_version_line", () => {
  for (const output of ["", "0.146.0", "codex 0.146.0", "codex-cli", "codex-cli 0.146", "command not found: codex\n"]) {
    expect(() => parseCodexVersion(output), `output ${JSON.stringify(output)}`).toThrow(/not a codex version line/);
  }
});

test("supported_version_is_pinned_to_0_146_0", () => {
  expect(SUPPORTED_CODEX_VERSION).toBe("0.146.0");
  expect(INSTALL_COMMAND).toBe("npm install -g @openai/codex@0.146.0");
});

test("exact_supported_version_is_accepted", () => {
  expect(() => requireSupportedCodex("0.146.0")).not.toThrow();
});

test("missing_codex_names_the_install_command", () => {
  const error = thrownBy(() => requireSupportedCodex(undefined));

  expect(error.message).toBe("codex was not found on PATH; install it with `npm install -g @openai/codex@0.146.0`");
  expect(error.info).toEqual({ kind: "codex-missing", message: error.message, fix: INSTALL_COMMAND });
});

test("other_version_is_rejected_with_both_versions", () => {
  const error = thrownBy(() => requireSupportedCodex("0.150.1"));

  expect(error.message).toContain("0.150.1");
  expect(error.message).toContain("0.146.0");
  expect(error.info.kind).toBe("codex-version");
  expect(error.info.fix).toBe(INSTALL_COMMAND);
});

test("a_prerelease_of_the_supported_version_is_rejected", () => {
  expect(thrownBy(() => requireSupportedCodex(parseCodexVersion("codex-cli 0.146.0-alpha.1"))).info.kind).toBe("codex-version");
});
