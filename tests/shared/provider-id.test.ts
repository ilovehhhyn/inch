// Invariant: only `codex` and `claude` are provider ids, and any other value from the window is rejected with the accepted ones named.
import { expect, test } from "vitest";

import { parseProviderId, PROVIDER_IDS } from "../../src/shared/provider-id";

test("the_two_providers_parse_to_themselves", () => {
  expect(parseProviderId("codex")).toBe("codex");
  expect(parseProviderId("claude")).toBe("claude");
  expect(PROVIDER_IDS).toEqual(["codex", "claude"]);
});

test("ipc_rejects_an_unknown_provider_id", () => {
  expect(() => parseProviderId("gemini")).toThrow("unknown provider `gemini`; expected codex or claude");
});

test.each([[undefined, "undefined"], [null, "null"], [5, "5"], ["", '""'], ["Codex", '"Codex"']])("a value that is not a provider id (%s) is rejected", (value, shown) => {
  expect(() => parseProviderId(value)).toThrow(`unknown provider \`${shown.replaceAll('"', "")}\`; expected codex or claude`);
});
