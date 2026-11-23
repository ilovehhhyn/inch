// Invariant: the Codex provider exposes the ChatProvider interface over CodexClient and turns nothing but delta, completed and account notifications into provider events.
import { expect, test } from "vitest";

import { CodexClient } from "../../src/codex/codex-client";
import { createCodexProvider } from "../../src/codex/codex-provider";
import type { ServerNotification } from "../../src/codex/generated/ServerNotification";
import { RpcConnection } from "../../src/codex/rpc-connection";
import { renderContextBlock, type ScreenContext } from "../../src/shared/context-format";
import { asThreadId, asTurnId, type ProviderEvent } from "../../src/shared/provider-events";
import { FakeAppServer } from "../fakes/fake-app-server";

const EMPTY_WORKSPACE = "/Users/example/Library/Application Support/Margin/empty-workspace";
const INIT_RESULT = { userAgent: "codex/0.146.0", codexHome: "/Users/example/.codex", platformFamily: "unix", platformOs: "macos" };
const MODEL_LIST = { data: [{ id: "gpt-5.6-luna", isDefault: false }, { id: "gpt-5.6-sol", isDefault: true }], nextCursor: null };
const THREAD_ID = asThreadId("thread-1");
const CONTEXT: ScreenContext = { paneKind: "diff", paneTitle: "repo", blocks: [{ label: "train.py line 39", text: "return peak * (step // warmup_steps)" }] };

async function setup() {
  const fake = new FakeAppServer();
  fake.respond("initialize", INIT_RESULT);
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const client = new CodexClient({ connection, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });
  await client.initialize();
  const skip = fake.received().length;
  return { fake, provider: createCodexProvider(client), sent: () => fake.received().slice(skip) };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("codex_provider_forwards_start_turn_with_context_first", async () => {
  const { fake, provider, sent } = await setup();
  fake.respond("turn/start", { turn: { id: "turn-1" } });

  const turnId = await provider.startTurn(THREAD_ID, { question: "does this look right?", context: CONTEXT });

  expect(turnId).toBe("turn-1");
  expect(sent()[0]?.params).toEqual({
    threadId: "thread-1",
    input: [
      { type: "text", text: renderContextBlock(CONTEXT) + "\n\n", text_elements: [] },
      { type: "text", text: "does this look right?", text_elements: [] },
    ],
  });
});

test("a_turn_without_context_sends_only_the_question_through_the_provider", async () => {
  const { fake, provider, sent } = await setup();
  fake.respond("turn/start", { turn: { id: "turn-1" } });

  await provider.startTurn(THREAD_ID, { question: "hello", context: null });

  expect(sent()[0]?.params).toEqual({ threadId: "thread-1", input: [{ type: "text", text: "hello", text_elements: [] }] });
});

test("codex_provider_emits_provider_events_only", async () => {
  const { fake, provider } = await setup();
  const events: Array<ProviderEvent> = [];
  provider.onEvent((event) => events.push(event));
  const started: ServerNotification = { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } };
  const delta: ServerNotification = { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello" } };

  fake.emit(started);
  await settle();
  expect(events).toEqual([]);
  fake.emit(delta);
  await settle();

  expect(events).toEqual([{ type: "delta", threadId: "thread-1", turnId: asTurnId("turn-1"), text: "Hello" }]);
});

test("unsubscribing_stops_further_events", async () => {
  const { fake, provider } = await setup();
  const events: Array<ProviderEvent> = [];
  const unsubscribe = provider.onEvent((event) => events.push(event));
  unsubscribe();

  fake.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "x" } });
  await settle();

  expect(events).toEqual([]);
});

test.each([
  ["a ChatGPT plan", { account: { type: "chatgpt", email: "someone@example.com", planType: "plus" }, requiresOpenaiAuth: false }, { provider: "codex", signedIn: true, label: "ChatGPT Plus" }],
  ["a ChatGPT account with no plan", { account: { type: "chatgpt", email: "someone@example.com", planType: null }, requiresOpenaiAuth: false }, { provider: "codex", signedIn: true, label: "ChatGPT" }],
  ["an API key", { account: { type: "apiKey" }, requiresOpenaiAuth: false }, { provider: "codex", signedIn: true, label: "API key" }],
  ["no account", { account: null, requiresOpenaiAuth: false }, { provider: "codex", signedIn: false, label: null }],
])("the_account_of_%s_is_labelled_without_an_email", async (_name, response, expected) => {
  const { fake, provider } = await setup();
  fake.respond("account/read", response);

  const account = await provider.readAccount();

  expect(account).toEqual(expected);
  expect(JSON.stringify(account)).not.toContain("example.com");
});

test("start_thread_names_the_default_model_explicitly", async () => {
  const { fake, provider, sent } = await setup();
  fake.respond("model/list", MODEL_LIST);
  fake.respond("thread/start", { thread: { id: "thread-9" } });

  const threadId = await provider.startThread();

  expect(threadId).toBe("thread-9");
  expect(sent().map((message) => message.method)).toEqual(["model/list", "thread/start"]);
  expect(sent()[1]?.params).toMatchObject({ model: "gpt-5.6-sol" });
});

test("fork_thread_forwards_the_turn_and_names_the_default_model", async () => {
  const { fake, provider, sent } = await setup();
  fake.respond("model/list", MODEL_LIST);
  fake.respond("thread/fork", { thread: { id: "side-1" } });

  const forked = await provider.forkThread(THREAD_ID, asTurnId("turn-3"));

  expect(forked).toBe("side-1");
  expect(sent()[1]?.params).toMatchObject({ threadId: "thread-1", lastTurnId: "turn-3", model: "gpt-5.6-sol" });
});

test("read_thread_resumes_then_returns_the_questions_and_answers", async () => {
  const { fake, provider, sent } = await setup();
  fake.respond("model/list", MODEL_LIST);
  fake.respond("thread/resume", { thread: { id: "thread-1" } });
  fake.respond("thread/read", {
    thread: {
      id: "thread-1",
      turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "what is lr?", text_elements: [] }] }, { type: "agentMessage", id: "a", text: "The step size." }] }],
    },
  });

  const messages = await provider.readThread(THREAD_ID);

  expect(sent().map((message) => message.method)).toEqual(["model/list", "thread/resume", "thread/read"]);
  expect(messages.map((message) => [message.role, message.text])).toEqual([["user", "what is lr?"], ["assistant", "The step size."]]);
});

test("list_threads_leaves_out_side_chats_and_tags_every_chat_codex", async () => {
  const { fake, provider } = await setup();
  fake.respond("thread/list", { data: [{ id: "main-1", preview: "first question", name: null, updatedAt: 5, forkedFromId: null }, { id: "side-1", preview: "side", name: null, updatedAt: 9, forkedFromId: null }], nextCursor: null, backwardsCursor: null });
  fake.respond("thread/read", (params) => {
    const threadId = (params as { threadId: string }).threadId;
    return { thread: { id: threadId, forkedFromId: threadId === "side-1" ? "main-1" : null, turns: [] } };
  });

  const chats = await provider.listThreads();

  expect(chats).toEqual([{ id: "main-1", provider: "codex", title: "first question", updatedAtSec: 5 }]);
});

test("a_provider_reports_its_id", async () => {
  const { provider } = await setup();

  expect(provider.id).toBe("codex");
});
