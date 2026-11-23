// Invariant: the generated Codex bindings are importable and describe the initialize request.
import { expectTypeOf, test } from "vitest";

import type { ClientRequest } from "../src/codex/generated/ClientRequest";

test("generated bindings export ClientRequest", () => {
  type InitializeRequest = Extract<ClientRequest, { method: "initialize" }>;

  expectTypeOf<InitializeRequest["method"]>().toEqualTypeOf<"initialize">();
  expectTypeOf<InitializeRequest["params"]["clientInfo"]["name"]>().toBeString();
});
