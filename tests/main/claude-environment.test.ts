// Invariant: Margin takes no Anthropic setting from the environment, except a test-only loopback address that it validates once.
import { expect, test } from "vitest";

import { readClaudeBaseUrl, scrubAnthropicVariables } from "../../src/main/claude-environment";

test("every_anthropic_variable_is_removed_and_others_are_kept", () => {
  const environment: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "stale", ANTHROPIC_AUTH_TOKEN: "stale", ANTHROPIC_PROFILE: "p", ANTHROPIC_CUSTOM_HEADERS: "x: y", ANTHROPIC_BASE_URL: "http://elsewhere", HOME: "/Users/example", MARGIN_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

  const removed = scrubAnthropicVariables(environment);

  expect(environment).toEqual({ HOME: "/Users/example", MARGIN_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  expect(removed).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_PROFILE"]);
});

test("the_removed_names_never_include_values", () => {
  const environment: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-secret" };

  expect(JSON.stringify(scrubAnthropicVariables(environment))).not.toContain("sk-ant-secret");
});

test.each([["http://127.0.0.1:8123"], ["http://localhost:8123"]])("a loopback address %s is accepted", (address) => {
  expect(readClaudeBaseUrl({ MARGIN_ANTHROPIC_BASE_URL: address })).toBe(address);
});

test("an_unset_variable_means_the_real_service", () => {
  expect(readClaudeBaseUrl({})).toBeUndefined();
});

test.each([[""], ["https://api.anthropic.com"], ["http://example.com:80"], ["http://127.0.0.1.evil.example:80"], ["file:///etc/passwd"], ["not a url"], ["http://127.0.0.1"]])("the address `%s` is rejected with the fix", (address) => {
  expect(() => readClaudeBaseUrl({ MARGIN_ANTHROPIC_BASE_URL: address })).toThrow(`MARGIN_ANTHROPIC_BASE_URL must be http://127.0.0.1:<port> or http://localhost:<port>, got \`${address}\`; it exists for tests, so unset it`);
});
