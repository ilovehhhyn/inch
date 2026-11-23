// Invariant: startCodexProcess runs `codex app-server` with an explicit environment, bounds stderr and stops cleanly.
import { afterEach, expect, test, vi } from "vitest";

import { startCodexProcess, STDERR_TAIL_BYTES, STOP_TIMEOUT_MS } from "../../src/codex/codex-process";
import { RpcError } from "../../src/codex/rpc-connection";
import { FakeAppServer } from "../fakes/fake-app-server";

const CODEX_PATH = "/opt/homebrew/bin/codex";
const ENVIRONMENT = { PATH: "/usr/bin", HOME: "/Users/example" };

function start(fake: FakeAppServer) {
  return startCodexProcess({ codexPath: CODEX_PATH, env: ENVIRONMENT, spawn: fake.spawn });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

test("process_starts_app_server_with_the_given_path_arguments_and_exact_environment", () => {
  const fake = new FakeAppServer();

  start(fake);

  expect(fake.spawnCalls).toEqual([{ command: CODEX_PATH, args: ["app-server"], env: ENVIRONMENT }]);
});

test("process_exit_resolves_exited_with_code_signal_and_stderr_tail", async () => {
  const fake = new FakeAppServer();
  const codex = start(fake);
  fake.writeStderr("fatal: bad config\n");
  await settle();

  fake.crash();
  const info = await codex.exited;

  expect(info).toEqual({ code: 1, signal: null, stderrTail: "fatal: bad config\n", spawnError: null });
});

test("process_exit_rejects_pending_requests_with_closed_naming_the_exit_code", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const codex = start(fake);
  const pending = codex.connection.request("account/read", {}).catch((error: unknown) => error);
  await settle();

  fake.crash();
  const error = await pending;

  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).kind).toBe("closed");
  expect((error as RpcError).message).toContain("exit code 1");
});

test("stderr_tail_keeps_only_the_last_64_kib", async () => {
  const fake = new FakeAppServer();
  const codex = start(fake);

  fake.writeStderr("a".repeat(STDERR_TAIL_BYTES));
  fake.writeStderr("b".repeat(10));
  await settle();
  fake.crash();
  const { stderrTail } = await codex.exited;

  expect(STDERR_TAIL_BYTES).toBe(64 * 1024);
  expect(stderrTail.length).toBe(STDERR_TAIL_BYTES);
  expect(stderrTail.endsWith("a".repeat(5) + "b".repeat(10))).toBe(true);
  expect(stderrTail.startsWith("a")).toBe(true);
});

test("spawn_error_resolves_exited_with_the_message_and_closes_the_connection", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const codex = start(fake);
  const pending = codex.connection.request("account/read", {}).catch((error: unknown) => error);
  await settle();

  fake.child.emit("error", new Error("spawn codex ENOENT"));
  const info = await codex.exited;

  expect(info).toEqual({ code: null, signal: null, stderrTail: "", spawnError: "spawn codex ENOENT" });
  expect(((await pending) as RpcError).kind).toBe("closed");
});

test("stop_sends_sigterm_waits_for_exit_and_closes_the_connection", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const codex = start(fake);
  const pending = codex.connection.request("account/read", {}).catch((error: unknown) => error);
  await settle();

  await codex.stop();

  expect(fake.child.signals).toEqual(["SIGTERM"]);
  expect(((await pending) as RpcError).kind).toBe("closed");
  expect(await codex.exited).toMatchObject({ signal: "SIGTERM" });
});

test("stop_escalates_to_sigkill_when_the_process_ignores_sigterm", async () => {
  vi.useFakeTimers();
  const fake = new FakeAppServer();
  fake.child.ignoresTerminate = true;
  const codex = start(fake);

  const stopping = codex.stop();
  await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 1);
  expect(fake.child.signals).toEqual(["SIGTERM"]);
  await vi.advanceTimersByTimeAsync(1);
  await stopping;

  expect(fake.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("stop_after_the_process_exited_sends_no_signal", async () => {
  const fake = new FakeAppServer();
  const codex = start(fake);
  fake.crash();
  await codex.exited;

  await codex.stop();

  expect(fake.child.signals).toEqual([]);
});
