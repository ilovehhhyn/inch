// Invariant: a session is returned only after initialize succeeds; any earlier failure stops the child and names the cause.
import { expect, test } from "vitest";

import { startCodexSession } from "../../src/main/codex-session";
import { StartupError } from "../../src/shared/startup-error";
import { FakeAppServer } from "../fakes/fake-app-server";

const INIT_RESULT = { userAgent: "codex/0.146.0", codexHome: "/Users/example/.codex", platformFamily: "unix", platformOs: "macos" };

function options(fake: FakeAppServer, requestTimeoutMs = 30_000) {
  return { codexPath: "/opt/homebrew/bin/codex", env: { HOME: "/Users/example" }, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: "/Users/example/empty", spawn: fake.spawn, requestTimeoutMs };
}

test("a_session_is_returned_after_initialize_and_initialized", async () => {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });

  const session = await startCodexSession(options(fake));

  expect(fake.received().map((message) => message.method)).toEqual(["initialize", "initialized", "config/read"]);
  expect(session.client).toBeDefined();
});

test("a_child_that_exits_during_initialize_is_codex_crashed_with_its_stderr", async () => {
  const fake = new FakeAppServer();
  fake.ignore("initialize");
  const starting = startCodexSession(options(fake)).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.writeStderr("Error: failed to load config.toml\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  fake.crash();
  const error = await starting;

  expect(error).toBeInstanceOf(StartupError);
  const info = (error as StartupError).info;
  expect(info.kind).toBe("codex-crashed");
  expect(info.message).toContain("failed to load config.toml");
  expect(info.fix).toBe("Restart Margin");
});

test("an_initialize_error_response_stops_the_child_and_is_codex_crashed", async () => {
  const fake = new FakeAppServer();
  fake.respondError("initialize", -32600, "bad request");

  const error = await startCodexSession(options(fake)).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(StartupError);
  expect((error as StartupError).info.message).toContain("bad request");
  expect(fake.child.signals).toEqual(["SIGTERM"]);
});

test("a_started_session_declines_an_approval_request_on_the_wire_and_logs_it", async () => {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });
  const logLines: Array<string> = [];
  await startCodexSession({ ...options(fake), log: (line) => void logLines.push(line) });

  fake.sendRequest({ method: "item/commandExecution/requestApproval", id: 41, params: { threadId: "t1", turnId: "u1", itemId: "i1" } } as never); // the fixture sets only the fields the answer reads
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const replies = fake.received().filter((message) => message.id === 41);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.params).toEqual({ decision: "decline" });
  expect(logLines).toContain("declined item/commandExecution/requestApproval thread=t1");
});
