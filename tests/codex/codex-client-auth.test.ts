// Invariant: CodexClient signs in only through the app-server, never leaks a key, and reports account changes without email.
import { expect, test } from "vitest";

import { CodexClient, summarizeAccount, toAccountEvent } from "../../src/codex/codex-client";
import type { AccountLoginCompletedNotification } from "../../src/codex/generated/v2/AccountLoginCompletedNotification";
import { RpcConnection } from "../../src/codex/rpc-connection";
import { FakeAppServer } from "../fakes/fake-app-server";

const INIT_RESULT = { userAgent: "codex/0.146.0", codexHome: "/Users/example/.codex", platformFamily: "unix", platformOs: "macos" };
const AUTH_URL = "https://auth.openai.com/oauth/authorize?state=abc";

function setup() {
  const fake = new FakeAppServer();
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const opened: Array<string> = [];
  const logLines: Array<string> = [];
  const client = new CodexClient({
    connection,
    appVersion: "1.2.3",
    openExternal: async (url) => void opened.push(url),
    log: (line) => void logLines.push(line),
    emptyWorkspacePath: "/Users/example/empty",
  });
  return { fake, client, opened, logLines };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("initialize_sends_initialized_after_the_response", async () => {
  const { fake, client } = setup();
  fake.ignore("initialize");
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });

  const pending = client.initialize();
  await settle();
  expect(fake.received().map((message) => message.method)).toEqual(["initialize"]);
  fake.reply(1, INIT_RESULT);
  await pending;

  expect(fake.received().map((message) => message.method)).toEqual(["initialize", "initialized", "config/read"]);
  expect(fake.received()[0]?.params).toEqual({
    clientInfo: { name: "margin", title: "Margin", version: "1.2.3" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
});

test("a_failed_initialize_does_not_send_initialized", async () => {
  const { fake, client } = setup();
  fake.respondError("initialize", -32600, "already initialized");

  await expect(client.initialize()).rejects.toThrow(/already initialized/);

  expect(fake.received().map((message) => message.method)).toEqual(["initialize"]);
});

test("existing_chatgpt_login_is_reported_without_a_login_request", async () => {
  const { fake, client } = setup();
  fake.respond("account/read", { account: { type: "chatgpt", email: "helen@example.com", planType: "plus" }, requiresOpenaiAuth: true });

  const summary = summarizeAccount(await client.readAccount());

  expect(summary).toEqual({ signedIn: true, accountType: "chatgpt", planType: "plus" });
  expect(fake.received().map((message) => message.method)).toEqual(["account/read"]);
});

test("the_account_summary_never_contains_the_email", () => {
  const summary = summarizeAccount({ account: { type: "chatgpt", email: "helen@example.com", planType: "plus" }, requiresOpenaiAuth: true });

  expect(JSON.stringify(summary)).not.toContain("helen@example.com");
});

test("no_account_is_summarized_as_signed_out", () => {
  expect(summarizeAccount({ account: null, requiresOpenaiAuth: true })).toEqual({ signedIn: false });
});

test("an_api_key_account_is_summarized_without_a_plan", () => {
  expect(summarizeAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toEqual({ signedIn: true, accountType: "apiKey", planType: null });
});

test("an_unsupported_account_type_is_an_error_naming_the_fix", () => {
  expect(() => summarizeAccount({ account: { type: "amazonBedrock", usesCodexManagedCredentials: true }, requiresOpenaiAuth: false })).toThrow(/unsupported account type `amazonBedrock`; sign out of Codex and sign in with ChatGPT or an OpenAI API key/);
});

test("chatgpt_login_opens_auth_url_in_the_browser", async () => {
  const { fake, client, opened } = setup();
  fake.respond("account/login/start", { type: "chatgpt", loginId: "login-1", authUrl: AUTH_URL });

  const started = await client.startLogin("chatgpt");

  expect(fake.received()[0]?.params).toEqual({ type: "chatgpt" });
  expect(opened).toEqual([AUTH_URL]);
  expect(started).toEqual({ kind: "chatgpt", loginId: "login-1" });
});

test("an_auth_url_that_is_not_https_is_refused_and_not_opened", async () => {
  const { fake, client, opened } = setup();
  fake.respond("account/login/start", { type: "chatgpt", loginId: "login-1", authUrl: "file:///etc/passwd" });

  await expect(client.startLogin("chatgpt")).rejects.toThrow(/auth url must use https/);

  expect(opened).toEqual([]);
});

test("device_code_login_returns_the_code_and_url_without_opening_a_browser", async () => {
  const { fake, client, opened } = setup();
  fake.respond("account/login/start", { type: "chatgptDeviceCode", loginId: "login-2", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });

  const started = await client.startLogin("chatgptDeviceCode");

  expect(fake.received()[0]?.params).toEqual({ type: "chatgptDeviceCode" });
  expect(started).toEqual({ kind: "chatgptDeviceCode", loginId: "login-2", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  expect(opened).toEqual([]);
});

test("a_login_response_of_another_type_is_an_error_not_a_guess", async () => {
  const { fake, client } = setup();
  fake.respond("account/login/start", { type: "apiKey" });

  await expect(client.startLogin("chatgpt")).rejects.toThrow(/asked for a `chatgpt` login but the app-server answered `apiKey`/);
});

test("login_completion_notifications_reach_the_handler_until_unsubscribed", async () => {
  const { fake, client } = setup();
  const seen: Array<AccountLoginCompletedNotification> = [];
  const unsubscribe = client.onLoginCompleted((event) => seen.push(event));

  fake.emit({ method: "account/login/completed", params: { loginId: "login-1", success: false, error: "denied" } });
  await settle();
  unsubscribe();
  fake.emit({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
  await settle();

  expect(seen).toEqual([{ loginId: "login-1", success: false, error: "denied" }]);
});

test("account_updated_with_no_auth_mode_is_a_signed_out_event", () => {
  expect(toAccountEvent({ method: "account/updated", params: { authMode: null, planType: null } })).toEqual({ type: "account", summary: { signedIn: false } });
});

test("account_updated_with_chatgpt_is_a_signed_in_event_with_the_plan", () => {
  expect(toAccountEvent({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } })).toEqual({ type: "account", summary: { signedIn: true, accountType: "chatgpt", planType: "plus" } });
});

test("other_notifications_are_not_account_events", () => {
  expect(toAccountEvent({ method: "account/login/completed", params: { loginId: null, success: true, error: null } })).toBeNull();
});

test("api_key_is_never_logged", async () => {
  const { fake, client, logLines } = setup();
  fake.respond("account/login/start", { type: "apiKey" });

  await client.startApiKeyLogin("sk-test-123");

  expect(fake.received()[0]?.params).toEqual({ type: "apiKey", apiKey: "sk-test-123" });
  expect(logLines.length).toBeGreaterThan(0);
  expect(logLines.join("\n")).not.toContain("sk-test-123");
});

test("api_key_is_not_in_the_error_when_the_server_echoes_it", async () => {
  const { fake, client, logLines } = setup();
  fake.respondError("account/login/start", -32600, "invalid api key sk-test-123");

  const error = await client.startApiKeyLogin("sk-test-123").then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );

  expect(error?.message).toContain("invalid api key");
  expect(error?.message).not.toContain("sk-test-123");
  expect(logLines.join("\n")).not.toContain("sk-test-123");
});

test("an_empty_api_key_is_rejected_before_any_request", async () => {
  const { fake, client } = setup();

  await expect(client.startApiKeyLogin("   ")).rejects.toThrow(/api key must not be empty/);

  expect(fake.received()).toEqual([]);
});

test("cancel_login_and_logout_send_their_requests", async () => {
  const { fake, client } = setup();
  fake.respond("account/login/cancel", { status: "canceled" });
  fake.respond("account/logout", {});

  await client.cancelLogin("login-1");
  await client.logout();

  expect(fake.received().map((message) => [message.method, message.params])).toEqual([
    ["account/login/cancel", { loginId: "login-1" }],
    ["account/logout", undefined],
  ]);
});

test("an_account_mode_margin_cannot_show_becomes_a_fault_not_an_uncaught_exception", async () => {
  const { fake, client } = setup();
  const faults: Array<unknown> = [];
  const events: Array<unknown> = [];
  client.onFault((info) => void faults.push(info));
  client.onAccountEvent((event) => void events.push(event));

  fake.emit({ method: "account/updated", params: { authMode: "chatgptAuthTokens", planType: null } });
  await settle();

  expect(events).toEqual([]);
  expect(faults).toEqual([
    { kind: "codex-protocol", message: "unsupported account type `chatgptAuthTokens`; sign out of Codex and sign in with ChatGPT or an OpenAI API key", fix: "sign out of Codex and sign in with ChatGPT or an OpenAI API key" },
  ]);
});

test("a_turn_completed_notification_with_an_unknown_status_fails_that_turn_instead_of_crashing_the_process", async () => {
  const { fake, client } = setup();
  const events: Array<unknown> = [];
  client.onProviderEvent((event) => void events.push(event));

  fake.emit({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "u1", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } },
  });
  await settle();

  expect(events).toEqual([
    { type: "completed", threadId: "t1", turnId: "u1", status: "failed", error: "turn/completed arrived with status `inProgress`; the app-server protocol changed, regenerate the bindings" },
  ]);
});
