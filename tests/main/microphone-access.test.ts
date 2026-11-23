// Invariant: Margin skips the macOS microphone prompt only when a test sets the variable to exactly 1, and any other value is an error that names the fix.
import { expect, test } from "vitest";

import { readAssumedMicrophoneAccess } from "../../src/main/microphone-access";

test("unset_means_margin_asks_macos", () => {
  expect(readAssumedMicrophoneAccess({})).toBe(false);
});

test("exactly_one_assumes_access", () => {
  expect(readAssumedMicrophoneAccess({ MARGIN_ASSUME_MICROPHONE_ACCESS: "1" })).toBe(true);
});

test.each(["", "0", "true", "yes"])("the_value_%j_is_rejected_naming_the_fix", (value) => {
  expect(() => readAssumedMicrophoneAccess({ MARGIN_ASSUME_MICROPHONE_ACCESS: value })).toThrow("MARGIN_ASSUME_MICROPHONE_ACCESS must be 1 or unset");
});
