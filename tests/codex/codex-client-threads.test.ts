// Invariant: threads are always read-only with no approvals, turns carry context as a separate item, crashes resume threads.
import { expect, test } from "vitest";

import { CodexClient, createThreadDefaults, MARGIN_INSTRUCTIONS, SHELL_TOOL_DISABLE, toProviderEvent } from "../../src/codex/codex-client";
import { CodexSupervisor, CRASH_MESSAGE, MAX_RESTARTS_PER_WINDOW } from "../../src/codex/codex-supervisor";
import type { ServerNotification } from "../../src/codex/generated/ServerNotification";
import { RpcConnection } from "../../src/codex/rpc-connection";
import { startCodexSession } from "../../src/main/codex-session";
import { asThreadId, asTurnId, type ProviderEvent } from "../../src/shared/provider-events";
import { FakeAppServer } from "../fakes/fake-app-server";

const EMPTY_WORKSPACE = "/Users/example/Library/Application Support/Margin/empty-workspace";
const INIT_RESULT = { userAgent: "codex/0.146.0", codexHome: "/Users/example/.codex", platformFamily: "unix", platformOs: "macos" };
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const USER_CONFIG = { config: { mcp_servers: { rea: { command: "rea" }, node_repl: { command: "node_repl" } } } };
const DEFAULTS = {
  cwd: EMPTY_WORKSPACE,
  sandbox: "read-only",
  approvalPolicy: "never",
  developerInstructions: MARGIN_INSTRUCTIONS,
  config: { ...SHELL_TOOL_DISABLE, mcp_servers: { node_repl: { enabled: false }, rea: { enabled: false } } },
  serviceName: "margin",
};

/** A client that finished initialize (which reads the user's MCP servers); `sent(fake)` lists only later messages. */
async function setup() {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", USER_CONFIG);
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const client = new CodexClient({ connection, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });
  await client.initialize();
  const skip = fake.received().length;
  return { fake, client, sent: () => fake.received().slice(skip) };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await settle();
  expect(condition()).toBe(true);
}

function completed(status: "completed" | "interrupted" | "failed" | "inProgress", error: string | null = null): ServerNotification {
  return {
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, items: [], itemsView: "notLoaded", status, error: error === null ? null : { message: error, codexErrorInfo: null, additionalDetails: null }, startedAt: null, completedAt: null, durationMs: null } },
  };
}

test("the_margin_instructions_are_the_agreed_text", () => {
  expect(MARGIN_INSTRUCTIONS).toBe(
    "You are a reading companion inside a chat app. Some user messages begin with a block marked MARGIN SCREEN CONTEXT. That block is the text the user was looking at when they asked. When it is present, the question refers to it: start your answer by naming what you read (the message, section, file and line), then answer. Quote file names, function names and line numbers exactly as they appear in the block. Never run commands or edit files.",
  );
});

test("thread_start_sends_read_only_never_and_empty_cwd", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/start", { thread: { id: THREAD_ID } });

  const threadId = await client.startThread({ model: "gpt-5.6-sol" });

  expect(threadId).toBe(THREAD_ID);
  expect(sent()[0]).toMatchObject({ method: "thread/start", params: { model: "gpt-5.6-sol", ...DEFAULTS } });
  expect(sent()[0]?.params).toEqual({ model: "gpt-5.6-sol", ...DEFAULTS });
});

test("shell_and_extra_tools_are_switched_off_in_the_thread_config", () => {
  expect(SHELL_TOOL_DISABLE).toEqual({ features: { shell_tool: false, apps: false, plugins: false } });
});

test("every_user_mcp_server_is_disabled_in_the_thread_config_and_the_config_is_read_once", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/start", { thread: { id: THREAD_ID } });

  await client.startThread({ model: "gpt-5.6-sol" });
  await client.startThread({ model: "gpt-5.6-sol" });

  const configReads = fake.received().filter((message) => message.method === "config/read");
  expect(configReads).toHaveLength(1);
  expect(sent()[0]?.params).toMatchObject({ config: { mcp_servers: { node_repl: { enabled: false }, rea: { enabled: false } } } });
});

test("a_thread_cannot_start_before_initialize_has_read_the_mcp_servers", async () => {
  const fake = new FakeAppServer();
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const client = new CodexClient({ connection, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });

  await expect(client.startThread({ model: "gpt-5.6-sol" })).rejects.toThrow(/call initialize\(\) before starting a thread so every MCP server can be disabled/);

  expect(fake.received()).toEqual([]);
});

test("initialize_fails_when_an_mcp_server_cannot_be_disabled", async () => {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", { config: { mcp_servers: { "my server": {} } } });
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const client = new CodexClient({ connection, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });

  await expect(client.initialize()).rejects.toThrow(/mcp server name `my server` cannot be disabled/);
});

test("the_default_model_is_the_one_model_list_marks_default", async () => {
  const { fake, client } = await setup();
  fake.respond("model/list", { data: [{ id: "gpt-5.6-terra", isDefault: false }, { id: "gpt-5.6-sol", isDefault: true }], nextCursor: null });

  expect(await client.defaultModelId()).toBe("gpt-5.6-sol");
});

test("no_default_model_is_a_hard_error_naming_the_fix", async () => {
  const { fake, client } = await setup();
  fake.respond("model/list", { data: [{ id: "gpt-5.6-terra", isDefault: false }], nextCursor: null });

  await expect(client.defaultModelId()).rejects.toThrow(/model\/list marks no default model; choose a model explicitly or sign in to an account that has one/);
});

test("a_relative_empty_workspace_path_is_rejected_when_the_defaults_are_built", () => {
  expect(() => createThreadDefaults("relative/dir")).toThrow(/empty workspace path must be absolute, got `relative\/dir`/);
});

test("a_blank_model_is_rejected_before_any_request", async () => {
  const { client, sent } = await setup();

  await expect(client.startThread({ model: " " })).rejects.toThrow(/model must not be empty/);

  expect(sent()).toEqual([]);
});

test("resume_sends_an_explicit_model_and_the_same_read_only_defaults", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/resume", { thread: { id: THREAD_ID } });

  await client.resumeThread(asThreadId(THREAD_ID), "gpt-5.6-sol");

  expect(sent()[0]?.params).toEqual({ threadId: THREAD_ID, model: "gpt-5.6-sol", ...DEFAULTS });
});

test("resume_without_a_model_is_refused_before_any_request", async () => {
  const { client, sent } = await setup();

  await expect(client.resumeThread(asThreadId(THREAD_ID), " ")).rejects.toThrow(/model must not be empty/);

  expect(sent()).toEqual([]);
});

test("the_model_of_a_started_forked_or_resumed_thread_is_remembered_and_an_unknown_thread_is_an_error", async () => {
  const { fake, client } = await setup();
  fake.respond("thread/start", { thread: { id: "a" } });
  fake.respond("thread/fork", { thread: { id: "b" } });
  fake.respond("thread/resume", { thread: { id: "c" } });

  const started = await client.startThread({ model: "m-start" });
  const forked = await client.forkThread(started, null, "m-fork");
  await client.resumeThread(asThreadId("c"), "m-resume");

  expect([client.modelOf(started), client.modelOf(forked), client.modelOf(asThreadId("c"))]).toEqual(["m-start", "m-fork", "m-resume"]);
  expect(() => client.modelOf(asThreadId("zzz"))).toThrow(/no model is recorded for thread zzz/);
});

test("fork_sends_the_parent_the_last_turn_an_explicit_model_and_the_read_only_defaults", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/fork", { thread: { id: "thread-2" } });

  const forked = await client.forkThread(asThreadId(THREAD_ID), asTurnId(TURN_ID), "gpt-5.6-sol");
  const forkedWhole = await client.forkThread(asThreadId(THREAD_ID), null, "gpt-5.6-sol");

  expect(forked).toBe("thread-2");
  expect(forkedWhole).toBe("thread-2");
  expect(sent()[0]?.params).toEqual({ threadId: THREAD_ID, lastTurnId: TURN_ID, model: "gpt-5.6-sol", ...DEFAULTS });
  expect(sent()[1]?.params).toEqual({ threadId: THREAD_ID, lastTurnId: null, model: "gpt-5.6-sol", ...DEFAULTS });
});

test("fork_without_a_model_is_refused_because_codex_would_use_the_config_default", async () => {
  const { client, sent } = await setup();

  await expect(client.forkThread(asThreadId(THREAD_ID), null, " ")).rejects.toThrow(/model must not be empty/);

  expect(sent()).toEqual([]);
});

test("list_and_read_ask_for_the_data_the_window_needs", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/list", { data: [], nextCursor: null, backwardsCursor: null });
  fake.respond("thread/read", { thread: { id: THREAD_ID, turns: [] } });

  await client.listThreads();
  const thread = await client.readThread(asThreadId(THREAD_ID));

  expect(sent()[0]).toMatchObject({ method: "thread/list", params: { cwd: EMPTY_WORKSPACE } });
  expect(sent()[1]?.params).toEqual({ threadId: THREAD_ID, includeTurns: true });
  expect(thread.id).toBe(THREAD_ID);
});

test("list_fills_the_fork_parent_because_thread_list_leaves_it_empty", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("thread/list", { data: [{ id: "main-1", forkedFromId: null }, { id: "side-1", forkedFromId: null }], nextCursor: null, backwardsCursor: null });
  fake.respond("thread/read", (params) => {
    const threadId = (params as { threadId: string }).threadId;
    return { thread: { id: threadId, forkedFromId: threadId === "side-1" ? "main-1" : null, turns: [] } };
  });

  const threads = await client.listThreads();
  const again = await client.listThreads();

  expect(threads.map((thread) => [thread.id, thread.forkedFromId])).toEqual([["main-1", null], ["side-1", "main-1"]]);
  expect(again.map((thread) => thread.forkedFromId)).toEqual([null, "main-1"]);
  const reads = sent().filter((message) => message.method === "thread/read");
  expect(reads.map((message) => message.params)).toEqual([{ threadId: "main-1", includeTurns: false }, { threadId: "side-1", includeTurns: false }]);
});

test("a_turn_with_context_sends_two_text_items_and_the_context_ends_with_a_blank_line", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("turn/start", { turn: { id: TURN_ID } });

  const turnId = await client.startTurn(asThreadId(THREAD_ID), { question: "what is lr?", context: { text: "MARGIN SCREEN CONTEXT\nlr = 0.1" } });

  expect(turnId).toBe(TURN_ID);
  expect(sent()[0]?.params).toEqual({
    threadId: THREAD_ID,
    input: [
      { type: "text", text: "MARGIN SCREEN CONTEXT\nlr = 0.1\n\n", text_elements: [] },
      { type: "text", text: "what is lr?", text_elements: [] },
    ],
  });
});

test("a_turn_without_context_sends_only_the_question", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("turn/start", { turn: { id: TURN_ID } });

  await client.startTurn(asThreadId(THREAD_ID), { question: "hello", context: null });

  expect(sent()[0]?.params).toEqual({ threadId: THREAD_ID, input: [{ type: "text", text: "hello", text_elements: [] }] });
});

test("an_empty_question_is_rejected_before_any_request", async () => {
  const { client, sent } = await setup();

  await expect(client.startTurn(asThreadId(THREAD_ID), { question: "  ", context: { text: "ctx" } })).rejects.toThrow(/question must not be empty/);

  expect(sent()).toEqual([]);
});

test("interrupt_sends_the_thread_and_turn_ids", async () => {
  const { fake, client, sent } = await setup();
  fake.respond("turn/interrupt", {});

  await client.interruptTurn(asThreadId(THREAD_ID), asTurnId(TURN_ID));

  expect(sent()[0]?.params).toEqual({ threadId: THREAD_ID, turnId: TURN_ID });
});

test("a_thread_is_resumable_only_after_it_has_run_a_turn", async () => {
  const { fake, client } = await setup();
  fake.respond("thread/start", { thread: { id: THREAD_ID } });
  fake.respond("turn/start", { turn: { id: TURN_ID } });
  const threadId = await client.startThread({ model: "gpt-5.6-sol" });
  expect(client.resumableThreads()).toEqual([]);

  await client.startTurn(threadId, { question: "hi", context: null });

  expect(client.resumableThreads()).toEqual([THREAD_ID]);
});

test("the_client_tracks_the_active_turn_until_it_completes", async () => {
  const { fake, client } = await setup();
  fake.respond("thread/start", { thread: { id: THREAD_ID } });
  fake.respond("turn/start", { turn: { id: TURN_ID } });
  const threadId = await client.startThread({ model: "gpt-5.6-sol" });

  await client.startTurn(threadId, { question: "hi", context: null });
  expect(client.activeTurns()).toEqual([{ threadId: THREAD_ID, turnId: TURN_ID }]);
  fake.emit(completed("completed"));
  await settle();

  expect(client.activeTurns()).toEqual([]);
  expect(client.resumableThreads()).toEqual([THREAD_ID]);
});

const EVENT_TABLE: ReadonlyArray<Readonly<{ name: string; notification: ServerNotification; expected: ProviderEvent | null }>> = [
  {
    name: "agent message delta",
    notification: { method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", delta: "OK" } },
    expected: { type: "delta", threadId: asThreadId(THREAD_ID), turnId: asTurnId(TURN_ID), text: "OK" },
  },
  { name: "completed", notification: completed("completed"), expected: { type: "completed", threadId: asThreadId(THREAD_ID), turnId: asTurnId(TURN_ID), status: "completed", error: null } },
  { name: "interrupted", notification: completed("interrupted"), expected: { type: "completed", threadId: asThreadId(THREAD_ID), turnId: asTurnId(TURN_ID), status: "interrupted", error: null } },
  { name: "failed", notification: completed("failed", "429"), expected: { type: "completed", threadId: asThreadId(THREAD_ID), turnId: asTurnId(TURN_ID), status: "failed", error: "429" } },
  { name: "account updated", notification: { method: "account/updated", params: { authMode: null, planType: null } }, expected: { type: "accountChanged", provider: "codex" } },
  { name: "reasoning delta", notification: { method: "item/reasoning/textDelta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", delta: "x", contentIndex: 0 } }, expected: null },
  { name: "mcp startup", notification: { method: "mcpServer/startupStatus/updated", params: { name: "rea", status: "ready", error: null, failureReason: null } } as ServerNotification, expected: null },
];

test("provider_events_come_only_from_deltas_turn_completion_and_account_updates", () => {
  for (const { name, notification, expected } of EVENT_TABLE) {
    expect(toProviderEvent(notification), name).toEqual(expected);
  }
});

test("a_turn_completed_notification_that_is_still_in_progress_is_an_error", () => {
  expect(() => toProviderEvent(completed("inProgress"))).toThrow(/turn\/completed arrived with status `inProgress`/);
});

function startSupervisor(fakes: ReadonlyArray<FakeAppServer>, restartsAllowedWindowMs = 60_000) {
  const events: Array<ProviderEvent> = [];
  const failures: Array<Error> = [];
  let spawned = 0;
  const supervisor = new CodexSupervisor({
    startSession: () => {
      const fake = fakes[spawned++];
      if (fake === undefined) throw new Error("the test scripted fewer app-servers than Margin started");
      return startCodexSession({ codexPath: "/bin/codex", env: { HOME: "/h" }, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, spawn: fake.spawn, emptyWorkspacePath: EMPTY_WORKSPACE });
    },
    onEvent: (event) => void events.push(event),
    onRestartFailed: (error) => void failures.push(error),
    log: () => undefined,
    now: () => 0,
    restartWindowMs: restartsAllowedWindowMs,
  });
  return { supervisor, events, failures };
}

function scripted(): FakeAppServer {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", USER_CONFIG);
  fake.respond("thread/start", { thread: { id: THREAD_ID } });
  fake.respond("thread/resume", { thread: { id: THREAD_ID } });
  fake.respond("turn/start", { turn: { id: TURN_ID } });
  return fake;
}

test("crash_during_turn_restarts_and_resumes_the_thread", async () => {
  const [first, second] = [scripted(), scripted()];
  const { supervisor, events } = startSupervisor([first, second]);
  await supervisor.start();
  const threadId = await supervisor.client.startThread({ model: "gpt-5.6-sol" });
  await supervisor.client.startTurn(threadId, { question: "hi", context: null });
  first.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", delta: "par" } });
  await settle();

  first.crash();
  await until(() => second.received().some((message) => message.method === "thread/resume"));

  expect(CRASH_MESSAGE).toBe("Codex stopped unexpectedly. Retry");
  expect(events).toEqual([
    { type: "delta", threadId: THREAD_ID, turnId: TURN_ID, text: "par" },
    { type: "completed", threadId: THREAD_ID, turnId: TURN_ID, status: "failed", error: "Codex stopped unexpectedly. Retry" },
  ]);
  expect(second.received().map((message) => message.method)).toEqual(["initialize", "initialized", "config/read", "thread/resume"]);
  expect(second.received()[3]?.params).toEqual({ threadId: THREAD_ID, model: "gpt-5.6-sol", ...DEFAULTS });
});

test("after_a_restart_the_new_process_serves_requests_and_its_events_flow", async () => {
  const [first, second] = [scripted(), scripted()];
  const { supervisor, events } = startSupervisor([first, second]);
  await supervisor.start();
  const threadId = await supervisor.client.startThread({ model: "gpt-5.6-sol" });
  await supervisor.client.startTurn(threadId, { question: "hi", context: null });
  first.emit(completed("completed"));
  await settle();
  first.crash();
  await until(() => second.received().some((message) => message.method === "thread/resume"));
  await settle();

  const turnId = await supervisor.client.startTurn(threadId, { question: "retry", context: null });
  second.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "i", delta: "again" } });
  await settle();

  expect(turnId).toBe(TURN_ID);
  expect(second.received().at(-1)?.method).toBe("turn/start");
  expect(events.at(-1)).toEqual({ type: "delta", threadId: THREAD_ID, turnId: TURN_ID, text: "again" });
  expect(events).toHaveLength(2);
});

test("a_crash_with_no_active_turn_emits_no_failure_event_and_resumes_threads_that_have_turns", async () => {
  const [first, second] = [scripted(), scripted()];
  const { supervisor, events } = startSupervisor([first, second]);
  await supervisor.start();
  const threadId = await supervisor.client.startThread({ model: "gpt-5.6-sol" });
  await supervisor.client.startTurn(threadId, { question: "hi", context: null });
  first.emit(completed("completed"));
  await settle();

  first.crash();
  await until(() => second.received().some((message) => message.method === "thread/resume"));

  expect(events).toEqual([{ type: "completed", threadId: THREAD_ID, turnId: TURN_ID, status: "completed", error: null }]);
});

// Measured against codex-cli 0.146.0: `thread/resume` of a thread that never ran a turn fails with "no rollout found".
test("a_thread_that_never_ran_a_turn_is_not_resumed", async () => {
  const [first, second] = [scripted(), scripted()];
  const { supervisor, events, failures } = startSupervisor([first, second]);
  await supervisor.start();
  await supervisor.client.startThread({ model: "gpt-5.6-sol" });

  first.crash();
  await until(() => second.received().some((message) => message.method === "config/read"));
  await settle();

  expect(second.received().map((message) => message.method)).toEqual(["initialize", "initialized", "config/read"]);
  expect(events).toEqual([]);
  expect(failures).toEqual([]);
});

test("a_stop_requested_by_margin_does_not_restart", async () => {
  const [first, second] = [scripted(), scripted()];
  const { supervisor, events, failures } = startSupervisor([first, second]);
  await supervisor.start();

  await supervisor.stop();
  await settle();

  expect(second.received()).toEqual([]);
  expect(events).toEqual([]);
  expect(failures).toEqual([]);
});

test("more_than_the_allowed_restarts_in_the_window_is_reported_as_a_failure_and_stops_restarting", async () => {
  const fakes = Array.from({ length: MAX_RESTARTS_PER_WINDOW + 2 }, scripted);
  const { supervisor, failures } = startSupervisor(fakes);
  await supervisor.start();

  for (let crash = 0; crash <= MAX_RESTARTS_PER_WINDOW; crash++) {
    const running = fakes[crash];
    if (running === undefined) throw new Error("missing scripted app-server");
    running.crash();
    await until(() => crash === MAX_RESTARTS_PER_WINDOW ? failures.length > 0 : fakes[crash + 1]?.received().some((message) => message.method === "config/read") === true);
  }

  expect(failures[0]?.message).toMatch(new RegExp(`restarted ${MAX_RESTARTS_PER_WINDOW} times`));
  expect(() => supervisor.client).toThrow(/Codex is not running/);
});

test("the_client_getter_throws_while_the_supervisor_has_not_started", () => {
  const { supervisor } = startSupervisor([]);

  expect(() => supervisor.client).toThrow(/Codex is not running; the app-server has not started or is restarting/);
});
