// Invariant: values that arrive over IPC are parsed into the closed login kinds or rejected with the allowed list.
import { expect, test } from "vitest";

import { parseLoginKind } from "../../src/shared/auth";

test("known_login_kinds_are_accepted", () => {
  expect(parseLoginKind("chatgpt")).toBe("chatgpt");
  expect(parseLoginKind("chatgptDeviceCode")).toBe("chatgptDeviceCode");
});

test("anything_else_is_rejected_listing_the_allowed_kinds", () => {
  for (const value of ["apiKey", "", undefined, 3, null, { type: "chatgpt" }]) {
    expect(() => parseLoginKind(value), `value ${JSON.stringify(value)}`).toThrow(/login kind must be `chatgpt` or `chatgptDeviceCode`/);
  }
});
