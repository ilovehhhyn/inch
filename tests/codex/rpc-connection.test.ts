// Invariant: RpcConnection matches responses to requests by id, frames lines safely and fails closed.
import { afterEach, expect, test, vi } from "vitest";

import type { ServerNotification } from "../../src/codex/generated/ServerNotification";
import { RpcConnection, RpcError } from "../../src/codex/rpc-connection";
import { FakeAppServer, RESPONSE_METHOD } from "../fakes/fake-app-server";

const REQUEST_TIMEOUT_MS = 30 * 1000;
const SMALL_LINE_LIMIT_CHARS = 64;
const ACCOUNT_RESULT = { account: null, requiresOpenaiAuth: false };
const MODELS_RESULT = { data: [], nextCursor: null };

function connect(fake: FakeAppServer, options: Readonly<{ requestTimeoutMs?: number; maxLineChars?: number }> = {}): RpcConnection {
  return new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, ...(options.maxLineChars === undefined ? {} : { maxLineChars: options.maxLineChars }) });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError; // narrowed by the assertion above
}

function requestIdOf(fake: FakeAppServer, method: string): number {
  const found = fake.received().find((message) => message.method === method);
  if (found?.id === null || found === undefined) throw new Error(`no request \`${method}\` with an id was received`);
  return found.id;
}

afterEach(() => {
  vi.useRealTimers();
});

test("request_resolves_with_the_result_that_matches_its_id", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  fake.ignore("model/list");
  const connection = connect(fake);

  const account = connection.request("account/read", {});
  const models = connection.request("model/list", {});
  await settle();
  fake.reply(requestIdOf(fake, "model/list"), MODELS_RESULT);
  fake.reply(requestIdOf(fake, "account/read"), ACCOUNT_RESULT);

  expect(await models).toEqual(MODELS_RESULT);
  expect(await account).toEqual(ACCOUNT_RESULT);
  expect(requestIdOf(fake, "account/read")).toBe(1);
  expect(requestIdOf(fake, "model/list")).toBe(2);
});

test("request_rejects_with_timeout_after_request_timeout_ms", async () => {
  vi.useFakeTimers();
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);

  const pending = rejection(connection.request("account/read", {}));
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  const error = await pending;

  expect(error.kind).toBe("timeout");
  expect(error.method).toBe("account/read");
  expect(error.message).toContain("account/read");
  expect(error.message).toContain("30000 ms");
});

test("request_does_not_time_out_before_request_timeout_ms", async () => {
  vi.useFakeTimers();
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  let settled = false;

  const pending = connection.request("account/read", {}).finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);

  expect(settled).toBe(false);
  fake.reply(1, ACCOUNT_RESULT);
  await expect(pending).resolves.toEqual(ACCOUNT_RESULT);
});

test("settled_requests_leave_no_timer_running", async () => {
  vi.useFakeTimers();
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);

  const pending = connection.request("account/read", {});
  expect(vi.getTimerCount()).toBe(1);
  fake.reply(1, ACCOUNT_RESULT);
  await pending;

  expect(vi.getTimerCount()).toBe(0);
});

test("late_response_after_a_timeout_is_ignored_and_the_connection_keeps_working", async () => {
  vi.useFakeTimers();
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const timedOut = rejection(connection.request("account/read", {}));
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  await timedOut;

  fake.reply(1, ACCOUNT_RESULT);
  const next = connection.request("account/read", {});
  await vi.advanceTimersByTimeAsync(0);
  fake.reply(2, ACCOUNT_RESULT);

  await expect(next).resolves.toEqual(ACCOUNT_RESULT);
});

test("server_error_response_rejects_with_kind_server_and_the_server_message", async () => {
  const fake = new FakeAppServer();
  fake.respondError("account/read", -32600, "not initialized");
  const connection = connect(fake);

  const error = await rejection(connection.request("account/read", {}));

  expect(error.kind).toBe("server");
  expect(error.method).toBe("account/read");
  expect(error.message).toContain("not initialized");
  expect(error.message).toContain("-32600");
});

test("malformed_line_rejects_pending_requests_and_closes", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const pending = rejection(connection.request("account/read", {}));
  await settle();

  fake.sendRaw("not json\n");
  const error = await pending;

  expect(error.kind).toBe("malformed");
  expect(error.message).toContain("not json");
  const afterwards = await rejection(connection.request("account/read", {}));
  expect(afterwards.kind).toBe("closed");
  expect(fake.received()).toHaveLength(1);
});

test("a_json_line_that_is_not_a_message_is_malformed", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const pending = rejection(connection.request("account/read", {}));
  await settle();

  fake.sendRaw('{"unexpected":true}\n');

  expect((await pending).kind).toBe("malformed");
});

test("a_line_longer_than_the_limit_is_malformed_before_it_is_buffered_whole", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake, { maxLineChars: SMALL_LINE_LIMIT_CHARS });
  const pending = rejection(connection.request("account/read", {}));
  await settle();

  fake.sendRaw("x".repeat(SMALL_LINE_LIMIT_CHARS + 1));
  const error = await pending;

  expect(error.kind).toBe("malformed");
  expect(error.message).toContain(String(SMALL_LINE_LIMIT_CHARS));
});

test("partial_lines_are_buffered_until_newline", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  let settled = false;
  const pending = connection.request("account/read", {}).finally(() => {
    settled = true;
  });
  await settle();
  const line = JSON.stringify({ id: 1, result: ACCOUNT_RESULT });

  fake.sendRaw(line.slice(0, 5));
  fake.sendRaw(line.slice(5, 20));
  await settle();
  expect(settled).toBe(false);
  fake.sendRaw(line.slice(20) + "\n");

  await expect(pending).resolves.toEqual(ACCOUNT_RESULT);
});

test("a_multibyte_character_split_across_chunks_is_decoded_intact", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const pending = connection.request("account/read", {});
  await settle();
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: { account: null, requiresOpenaiAuth: false, note: "é" } }) + "\n");
  const split = bytes.indexOf(0xc3) + 1;

  fake.input.write(bytes.subarray(0, split));
  fake.input.write(bytes.subarray(split));

  await expect(pending).resolves.toMatchObject({ note: "é" });
});

test("notifications_reach_handlers_until_unsubscribed", async () => {
  const fake = new FakeAppServer();
  const connection = connect(fake);
  const seen: Array<string> = [];
  const unsubscribe = connection.onNotification((notification) => seen.push(notification.method));
  const notification: ServerNotification = { method: "account/updated", params: { authMode: null, planType: null } };

  fake.emit(notification);
  await settle();
  unsubscribe();
  fake.emit(notification);
  await settle();

  expect(seen).toEqual(["account/updated"]);
});

test("server_request_handler_reply_is_written_with_the_same_id", async () => {
  const fake = new FakeAppServer();
  const connection = connect(fake);
  connection.onServerRequest(async (request) => ({ answeredMethod: request.method }));

  fake.sendRequest({ method: "currentTime/read", id: 77, params: { threadId: "t1" } });
  await settle();

  expect(fake.received()).toEqual([{ id: 77, method: RESPONSE_METHOD, params: { answeredMethod: "currentTime/read" } }]);
});

test("server_request_without_a_handler_gets_a_method_not_found_error", async () => {
  const fake = new FakeAppServer();
  connect(fake);

  fake.sendRequest({ method: "currentTime/read", id: 5, params: { threadId: "t1" } });
  await settle();

  const [reply] = fake.received();
  expect(reply?.id).toBe(5);
  expect(JSON.stringify(reply?.params)).toContain("-32601");
});

test("server_request_handler_failure_is_reported_to_the_server_as_an_error", async () => {
  const fake = new FakeAppServer();
  const connection = connect(fake);
  connection.onServerRequest(async () => {
    throw new Error("boom");
  });

  fake.sendRequest({ method: "currentTime/read", id: 6, params: { threadId: "t1" } });
  await settle();

  const [reply] = fake.received();
  expect(reply?.id).toBe(6);
  expect(JSON.stringify(reply?.params)).toContain("boom");
});

test("notify_writes_the_initialized_notification_without_an_id", async () => {
  const fake = new FakeAppServer();
  fake.ignore("initialized");
  const connection = connect(fake);

  connection.notify("initialized");
  await settle();

  expect(fake.received()).toEqual([{ id: null, method: "initialized", params: undefined }]);
});

test("process_exit_rejects_pending_requests_with_closed", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const pending = rejection(connection.request("account/read", {}));
  await settle();

  fake.crash();
  const error = await pending;

  expect(error.kind).toBe("closed");
  expect(error.method).toBe("account/read");
});

test("close_rejects_pending_requests_and_refuses_new_ones_without_writing", async () => {
  const fake = new FakeAppServer();
  fake.ignore("account/read");
  const connection = connect(fake);
  const pending = rejection(connection.request("account/read", {}));
  await settle();

  connection.close();

  expect((await pending).kind).toBe("closed");
  expect((await rejection(connection.request("account/read", {}))).kind).toBe("closed");
  expect(fake.received()).toHaveLength(1);
});
