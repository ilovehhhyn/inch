// Invariant: a Claude chat sends the context block and the question as one user message, stores the assistant reply unchanged, keeps messages alternating through interrupts and errors, and maps each failure to one message.
import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createClaudeProvider, CLAUDE_DEFAULT_EFFORT, CLAUDE_DEFAULT_MODEL, CLAUDE_MAX_TOKENS, NOT_SIGNED_IN, STOPPED_BEFORE_ANY_ANSWER } from "../../src/claude/claude-provider";
import { createClaudeThreadStore, type ClaudeThreadStore } from "../../src/claude/claude-thread-store";
import type { ClaudeCredential } from "../../src/claude/claude-credentials";
import type { Attachment } from "../../src/shared/attachment";
import type { ChatProvider } from "../../src/shared/chat-provider";
import { renderContextBlock, type ScreenContext } from "../../src/shared/context-format";
import { MARGIN_INSTRUCTIONS } from "../../src/shared/margin-instructions";
import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../../src/shared/provider-events";
import { answerContent, FakeAnthropic } from "../fakes/fake-anthropic";

const API_KEY: ClaudeCredential = { kind: "apiKey", apiKey: "sk-ant-test-123" };
const CONTEXT: ScreenContext = { paneKind: "diff", paneTitle: "repo", blocks: [{ label: "train.py line 39", text: "return peak * (step // warmup_steps)" }] };

type Setup = Readonly<{ provider: ChatProvider; store: ClaudeThreadStore; fake: FakeAnthropic; events: Array<ProviderEvent> }>;

async function setup(credential: ClaudeCredential | null = API_KEY, onCredentialRejected: () => void = () => undefined): Promise<Setup> {
  const store = createClaudeThreadStore(join(await mkdtemp(join(tmpdir(), "margin-claude-")), "claude-threads"));
  const fake = new FakeAnthropic();
  let counter = 0;
  const provider = createClaudeProvider({ credentials: async () => credential, store, makeClient: () => fake.asClient(), createId: () => `id-${++counter}`, onCredentialRejected });
  const events: Array<ProviderEvent> = [];
  provider.onEvent((event) => events.push(event));
  return { provider, store, fake, events };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

function completedEvents(events: ReadonlyArray<ProviderEvent>): Array<Extract<ProviderEvent, { type: "completed" }>> {
  return events.flatMap((event) => (event.type === "completed" ? [event] : []));
}

/** Starts a thread, sends one turn and waits until it completed. */
async function runTurn(context: Setup, threadId: ThreadId, question: string, screen: ScreenContext | null = null): Promise<TurnId> {
  const before = completedEvents(context.events).length;
  const turnId = await context.provider.startTurn(threadId, { question, context: screen, model: "claude-opus-5-5", reasoning: "low", attachments: [] });
  await until(() => completedEvents(context.events).length === before + 1);
  return turnId;
}

test("command_i_sends_context_block_then_question_in_one_user_message", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "does this look right?", CONTEXT);

  const messages = context.fake.requests[0]?.params["messages"];
  expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: renderContextBlock(CONTEXT) }, { type: "text", text: "does this look right?" }] }]);
});

test("a_plain_question_has_no_context_block", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(context.fake.requests[0]?.params["messages"]).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("request_carries_model_effort_fallbacks_and_cache_control", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(CLAUDE_DEFAULT_MODEL).toBe("claude-opus-5-5");
  expect(CLAUDE_MAX_TOKENS).toBe(64_000);
  expect(context.fake.requests[0]?.params).toEqual({
    model: "claude-opus-5-5",
    max_tokens: 64_000,
    system: MARGIN_INSTRUCTIONS,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    output_config: { effort: CLAUDE_DEFAULT_EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
  });
  expect(context.fake.requests[0]?.options.signal).toBeInstanceOf(AbortSignal);
});

test("an_ant_token_adds_the_oauth_beta_to_the_request_betas", async () => {
  const context = await setup({ kind: "antProfile", profile: "margin", accessToken: "tok", fetchedAtMs: 0 });
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(context.fake.requests[0]?.params["betas"]).toEqual(["server-side-fallback-2026-07-01", "oauth-2025-04-20"]);
});

test("every_text_delta_is_one_delta_event_and_the_turn_then_completes", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["The ", "step ", "size."] });
  const threadId = await context.provider.startThread();

  const turnId = await runTurn(context, threadId, "what is lr?");

  expect(context.events).toEqual([
    { type: "delta", threadId, turnId, text: "The " },
    { type: "delta", threadId, turnId, text: "step " },
    { type: "delta", threadId, turnId, text: "size." },
    { type: "completed", threadId, turnId, status: "completed", error: null },
  ]);
});

test("assistant_content_is_stored_unchanged_including_thinking_blocks", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["The step size."] }, { kind: "answer", chunks: ["Yes."] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "what is lr?");
  await runTurn(context, threadId, "really?");

  const stored = await context.store.read(threadId);
  expect(stored.messages[1]).toEqual({ role: "assistant", content: answerContent(["The step size."]) });
  expect(context.fake.requests[1]?.params["messages"]).toEqual([
    { role: "user", content: [{ type: "text", text: "what is lr?" }] },
    { role: "assistant", content: answerContent(["The step size."]) },
    { role: "user", content: [{ type: "text", text: "really?" }] },
  ]);
  expect(stored.turns.map((turn) => turn.userMessageIndex)).toEqual([0, 2]);
});

test("a_new_chat_is_not_stored_until_its_first_turn_finishes", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();

  expect(await context.store.list()).toEqual([]);
  expect(await context.provider.readThread(threadId)).toEqual([]);
  await expect(context.store.read(threadId)).rejects.toThrow(`no stored Claude chat ${threadId}`);
});

test("a_chat_that_is_neither_started_here_nor_stored_is_an_error_naming_it", async () => {
  const context = await setup();

  await expect(context.provider.readThread(asThreadId("11111111-2222"))).rejects.toThrow("no stored Claude chat 11111111-2222");
});

test("interrupt_keeps_messages_alternating", async () => {
  const context = await setup();
  context.fake.script({ kind: "hang" });
  const threadId = await context.provider.startThread();
  const turnId = await context.provider.startTurn(threadId, { question: "long question", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] });

  await context.provider.interruptTurn(threadId, turnId);
  await until(() => completedEvents(context.events).length === 1);

  expect(completedEvents(context.events)[0]).toEqual({ type: "completed", threadId, turnId, status: "interrupted", error: null });
  const stored = await context.store.read(threadId);
  expect(stored.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "long question" }] },
    { role: "assistant", content: [{ type: "text", text: STOPPED_BEFORE_ANY_ANSWER }] },
  ]);
  expect(STOPPED_BEFORE_ANY_ANSWER).toBe("(stopped before any answer)");
});

test("an_interrupt_after_some_text_stores_only_the_text_already_shown", async () => {
  const context = await setup();
  context.fake.script({ kind: "hang", chunksBefore: ["The step ", "size"] });
  const threadId = await context.provider.startThread();
  const turnId = await context.provider.startTurn(threadId, { question: "what is lr?", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] });
  await until(() => context.events.filter((event) => event.type === "delta").length === 2);

  await context.provider.interruptTurn(threadId, turnId);
  await until(() => completedEvents(context.events).length === 1);

  expect((await context.store.read(threadId)).messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "The step size" }] });
});

test("an_interrupt_for_a_turn_that_is_not_running_is_an_error", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();

  await expect(context.provider.interruptTurn(threadId, asTurnId("turn-9"))).rejects.toThrow(`turn turn-9 is not running in chat ${threadId}`);
});

test("a_second_turn_while_one_runs_is_refused_and_sends_nothing", async () => {
  const context = await setup();
  context.fake.script({ kind: "hang" });
  const threadId = await context.provider.startThread();
  await context.provider.startTurn(threadId, { question: "first", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] });

  await expect(context.provider.startTurn(threadId, { question: "second", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] })).rejects.toThrow("a turn is already running in this chat; wait for the answer or stop it first");

  expect(context.fake.requests).toHaveLength(1);
});

test("two_turns_started_without_waiting_for_each_other_start_one_stream_and_refuse_the_second", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["first answer"] });
  const threadId = await context.provider.startThread();
  const input = { context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] } as const;

  const results = await Promise.allSettled([context.provider.startTurn(threadId, { ...input, question: "first" }), context.provider.startTurn(threadId, { ...input, question: "second" })]);

  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason).toEqual(new Error("a turn is already running in this chat; wait for the answer or stop it first"));
  await until(() => completedEvents(context.events).length === 1);
  expect(context.fake.requests).toHaveLength(1);
  expect((await context.store.read(threadId)).turns).toHaveLength(1);
});

test("a_turn_that_fails_before_it_streams_releases_the_chat_for_the_next_send", async () => {
  const context = await setup(null);
  const threadId = await context.provider.startThread();
  const input = { question: "q", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] } as const;

  await expect(context.provider.startTurn(threadId, input)).rejects.toThrow(NOT_SIGNED_IN);
  await expect(context.provider.startTurn(threadId, input)).rejects.toThrow(NOT_SIGNED_IN);
});

async function chatWithTwoTurns(context: Setup): Promise<Readonly<{ threadId: ThreadId; first: TurnId; second: TurnId }>> {
  context.fake.script({ kind: "answer", chunks: ["A1"] }, { kind: "answer", chunks: ["A2"] });
  const threadId = await context.provider.startThread();
  const first = await runTurn(context, threadId, "Q1");
  const second = await runTurn(context, threadId, "Q2");
  return { threadId, first, second };
}

test("fork_copies_messages_through_the_chosen_turn", async () => {
  const context = await setup();
  const { threadId, first } = await chatWithTwoTurns(context);

  const forkId = await context.provider.forkThread(threadId, first);

  const forked = await context.store.read(forkId);
  expect(forkId).not.toBe(threadId);
  expect(forked.forkedFrom).toBe(threadId);
  expect(forked.messages).toEqual((await context.store.read(threadId)).messages.slice(0, 2));
  expect(forked.turns).toEqual([{ turnId: first, userMessageIndex: 0 }]);
  expect((await context.provider.readThread(forkId)).map((message) => message.text)).toEqual(["Q1", "A1"]);
});

test("fork_leaves_the_original_thread_unchanged", async () => {
  const context = await setup();
  const { threadId, first } = await chatWithTwoTurns(context);
  const before = await context.store.read(threadId);

  await context.provider.forkThread(threadId, first);

  expect(await context.store.read(threadId)).toEqual(before);
});

test("a_fork_through_no_turn_is_an_error_naming_the_turn", async () => {
  const context = await setup();
  const { threadId } = await chatWithTwoTurns(context);

  await expect(context.provider.forkThread(threadId, asTurnId("turn-9"))).rejects.toThrow(`chat ${threadId} has no turn turn-9; open the chat it was forked from or close this side chat`);
});

test("a_fork_with_no_turn_given_copies_the_whole_chat", async () => {
  const context = await setup();
  const { threadId } = await chatWithTwoTurns(context);

  const forkId = await context.provider.forkThread(threadId, null);

  expect((await context.store.read(forkId)).messages).toHaveLength(4);
});

test("a_side_chat_continues_with_the_inherited_messages_and_leaves_the_parent_alone", async () => {
  const context = await setup();
  const { threadId, first } = await chatWithTwoTurns(context);
  const forkId = await context.provider.forkThread(threadId, first);
  context.fake.script({ kind: "answer", chunks: ["S1"] });

  await runTurn(context, forkId, "side question");

  expect(context.fake.requests[2]?.params["messages"]).toHaveLength(3);
  expect((await context.store.read(forkId)).messages).toHaveLength(4);
  expect((await context.store.read(threadId)).messages).toHaveLength(4);
});

test.each([
  [
    "an expired sign-in",
    Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid" } }, "401 invalid", new Headers()),
    { status: "failed", error: "Claude sign-in expired. Sign in again" },
    true,
  ],
  [
    "a rate limit with a retry-after of 30 seconds",
    Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "429 slow down", new Headers({ "retry-after": "30" })),
    { status: "failed", error: "Claude rate limit reached. Try again in 30 s" },
    false,
  ],
  [
    "a rate limit with no retry-after",
    Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "429 slow down", new Headers()),
    { status: "failed", error: "Claude rate limit reached. Try again later" },
    false,
  ],
  ["a lost connection", new Anthropic.APIConnectionError({ message: "fetch failed" }), { status: "failed", error: "Cannot reach Anthropic. Check the connection" }, false],
])("each_error_maps_to_its_message: %s", async (_name, error, expected, isAccountChange) => {
  const context = await setup();
  context.fake.script({ kind: "fail", error });
  const threadId = await context.provider.startThread();

  const turnId = await runTurn(context, threadId, "hello");

  expect(completedEvents(context.events)).toEqual([{ type: "completed", threadId, turnId, ...expected }]);
  expect(context.events.some((event) => event.type === "accountChanged")).toBe(isAccountChange);
  expect(await context.store.list()).toEqual([]);
});

test("an_error_after_some_text_stores_nothing_so_a_retry_starts_clean", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["A1"] }, { kind: "fail", error: new Anthropic.APIConnectionError({ message: "fetch failed" }), chunksBefore: ["partial"] });
  const threadId = await context.provider.startThread();
  await runTurn(context, threadId, "Q1");
  const before = await context.store.read(threadId);

  await runTurn(context, threadId, "Q2");

  expect(await context.store.read(threadId)).toEqual(before);
});

test("an_error_that_is_not_an_api_error_is_reported_with_its_message", async () => {
  const context = await setup();
  context.fake.script({ kind: "fail", error: new Error("the stream broke") });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(completedEvents(context.events)[0]).toMatchObject({ status: "failed", error: "the stream broke" });
});

test.each([
  ["a category", "cyber", "Claude declined to answer this (category: cyber)"],
  ["no category", null, "Claude declined to answer this"],
])("a_refusal_with_%s_is_refused_and_keeps_alternation", async (_name, category, message) => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: [], stopReason: "refusal", category, emptyContent: true });
  const threadId = await context.provider.startThread();

  const turnId = await runTurn(context, threadId, "something");

  expect(completedEvents(context.events)).toEqual([{ type: "completed", threadId, turnId, status: "refused", error: message }]);
  const stored = await context.store.read(threadId);
  expect(stored.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(stored.messages[1])).not.toBe(JSON.stringify({ role: "assistant", content: [] }));
});

test("signed_out_start_turn_is_refused_before_any_request", async () => {
  const context = await setup(null);
  const threadId = await context.provider.startThread();

  await expect(context.provider.startTurn(threadId, { question: "hello", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] })).rejects.toThrow(NOT_SIGNED_IN);

  expect(NOT_SIGNED_IN).toBe("Claude is not signed in; sign in from the Accounts page");
  expect(context.fake.requests).toEqual([]);
});

test("a_blank_question_is_refused_before_any_request", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();

  await expect(context.provider.startTurn(threadId, { question: "  ", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [] })).rejects.toThrow("question must not be empty");

  expect(context.fake.requests).toEqual([]);
});

test("reloaded_thread_hides_the_context_block", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["It returns peak * (step // warmup_steps)."] }, { kind: "answer", chunks: ["Yes."] });
  const threadId = await context.provider.startThread();
  const first = await runTurn(context, threadId, "does this look right?", CONTEXT);
  await runTurn(context, threadId, "and now?");

  const messages = await context.provider.readThread(threadId);

  expect(messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "does this look right?"],
    ["assistant", "It returns peak * (step // warmup_steps)."],
    ["user", "and now?"],
    ["assistant", "Yes."],
  ]);
  expect(messages[0]?.turnId).toBe(first);
  expect(messages.every((message) => message.status === "done")).toBe(true);
  expect(JSON.stringify(messages)).not.toContain("MARGIN SCREEN CONTEXT");
});

test("the_account_is_read_from_the_credential_without_exposing_it", async () => {
  expect(await (await setup()).provider.readAccount()).toEqual({ provider: "claude", signedIn: true, label: "API key" });
  expect(await (await setup(null)).provider.readAccount()).toEqual({ provider: "claude", signedIn: false, label: null });
});

test("the_chat_list_has_main_chats_only_newest_first_titled_by_their_first_question", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["A"] }, { kind: "answer", chunks: ["B"] });
  const first = await context.provider.startThread();
  const turn = await runTurn(context, first, "First question\nwith a second line");
  await context.provider.forkThread(first, turn);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const second = await context.provider.startThread();
  await runTurn(context, second, "x".repeat(100), CONTEXT);

  const chats = await context.provider.listThreads();

  expect(chats.map((chat) => [chat.id, chat.provider, chat.title])).toEqual([
    [second, "claude", "x".repeat(60)],
    [first, "claude", "First question"],
  ]);
  expect(chats[0]?.updatedAtSec).toBeGreaterThanOrEqual(chats[1]?.updatedAtSec ?? 0);
});

test("a_corrupt_chat_file_is_listed_as_a_row_with_its_problem_and_the_other_chats_still_list", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "margin-claude-")), "claude-threads");
  const store = createClaudeThreadStore(directory);
  const fake = new FakeAnthropic().script({ kind: "answer", chunks: ["A"] });
  let counter = 0;
  const provider = createClaudeProvider({ credentials: async () => API_KEY, store, makeClient: () => fake.asClient(), createId: () => `id-${++counter}` });
  const events: Array<ProviderEvent> = [];
  provider.onEvent((event) => events.push(event));
  const context: Setup = { provider, store, fake, events };
  const good = await provider.startThread();
  await runTurn(context, good, "Good question");
  await writeFile(join(directory, "deadbeef-0000.json"), "{}");

  const chats = await provider.listThreads();

  expect(chats.map((chat) => chat.title).sort()).toEqual(["Good question", "Unreadable chat deadbeef"]);
  const broken = chats.find((chat) => chat.id === "deadbeef-0000");
  expect(broken?.problem).toContain(join(directory, "deadbeef-0000.json"));
  expect(chats.find((chat) => chat.id === good)?.problem).toBeUndefined();
});

test("the_default_effort_is_the_provisional_low", () => {
  expect(CLAUDE_DEFAULT_EFFORT).toBe("low");
});

test("claude_turn_carries_model_and_effort", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["A1"] });
  const threadId = await context.provider.startThread();
  const before = completedEvents(context.events).length;

  await context.provider.startTurn(threadId, { question: "Q1", context: null, model: "claude-opus-5-5", reasoning: "xhigh", attachments: [] });
  await until(() => completedEvents(context.events).length === before + 1);

  expect(context.fake.requests[0]?.params).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "xhigh" } });
});

test("a_turns_choice_is_stored_with_the_chat_and_the_next_turn_uses_the_newer_one", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["A1"] }, { kind: "answer", chunks: ["A2"] });
  const threadId = await context.provider.startThread();
  await runTurn(context, threadId, "Q1");
  expect((await context.store.read(threadId)).effort).toBe("low");

  const before = completedEvents(context.events).length;
  await context.provider.startTurn(threadId, { question: "Q2", context: null, model: "claude-opus-5-5", reasoning: "max", attachments: [] });
  await until(() => completedEvents(context.events).length === before + 1);

  expect(context.fake.requests[1]?.params["output_config"]).toEqual({ effort: "max" });
  expect((await context.store.read(threadId)).effort).toBe("max");
});

test("unknown_reasoning_value_is_rejected_before_sending", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();

  await expect(context.provider.startTurn(threadId, { question: "Q", context: null, model: "claude-opus-5-5", reasoning: "turbo", attachments: [] })).rejects.toThrow(
    "reasoning level `turbo` is not offered by `claude-opus-5-5`; choose low, medium, high, xhigh or max",
  );

  expect(context.fake.requests).toEqual([]);
  expect(await context.store.list()).toEqual([]);
});

test("an_unknown_model_is_rejected_before_sending", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();

  await expect(context.provider.startTurn(threadId, { question: "Q", context: null, model: "claude-haiku-9", reasoning: "low", attachments: [] })).rejects.toThrow("model `claude-haiku-9` is not offered; choose claude-opus-5-5");

  expect(context.fake.requests).toEqual([]);
});

test("list_models_offers_opus_with_all_five_levels_images_and_pdfs", async () => {
  const context = await setup();

  expect(await context.provider.listModels()).toEqual([
    { provider: "claude", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: CLAUDE_DEFAULT_EFFORT, acceptsImages: true, acceptsPdfs: true },
  ]);
});

const FALLBACK = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: null };

test("a_turn_with_a_fallback_block_is_stored_without_the_thinking_and_tool_blocks_before_it", async () => {
  const context = await setup();
  const content = [
    { type: "thinking", thinking: "", signature: "sig-before" },
    { type: "text", text: "partial ", citations: null },
    { type: "redacted_thinking", data: "x" },
    { type: "tool_use", id: "t1", name: "x", input: {} },
    FALLBACK,
    { type: "thinking", thinking: "", signature: "sig-after" },
    { type: "text", text: "final answer", citations: null },
  ];
  context.fake.script({ kind: "answer", chunks: ["partial final answer"], content, servedModel: "claude-opus-4-8" }, { kind: "answer", chunks: ["next"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "first");
  await runTurn(context, threadId, "second");

  const replayed = (context.fake.requests[1]?.params["messages"] as Array<{ role: string; content: Array<{ type: string }> }>)[1];
  expect(replayed?.content.map((block) => block.type)).toEqual(["text", "fallback", "thinking", "text"]);
  expect((await context.store.read(threadId)).messages[1]?.content).toEqual([content[1], FALLBACK, content[5], content[6]]);
});

test("a_turn_without_a_fallback_block_is_stored_unchanged", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "first");

  expect((await context.store.read(threadId)).messages[1]?.content).toEqual(answerContent(["Hi"]));
});

test("a_refused_turn_is_kept_for_display_but_never_sent_again", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["partial text"], stopReason: "refusal", category: "cyber" }, { kind: "answer", chunks: ["fine"] });
  const threadId = await context.provider.startThread();
  await runTurn(context, threadId, "something that is declined");

  const history = await context.provider.readThread(threadId);
  await runTurn(context, threadId, "a harmless question");

  expect(history.map((message) => [message.role, message.status])).toEqual([["user", "done"], ["assistant", "failed"]]);
  expect(history[1]?.text).toBe("partial text");
  expect(context.fake.requests[1]?.params["messages"]).toEqual([{ role: "user", content: [{ type: "text", text: "a harmless question" }] }]);
  const stored = await context.store.read(threadId);
  expect(stored.messages).toHaveLength(4);
  expect((await context.provider.readThread(threadId)).map((message) => message.text)).toEqual(["something that is declined", "partial text", "a harmless question", "fine"]);
});

test("a_refusal_with_no_text_shows_the_decline_message_after_a_reload", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: [], stopReason: "refusal", category: null, emptyContent: true });
  const threadId = await context.provider.startThread();
  await runTurn(context, threadId, "something");

  expect((await context.provider.readThread(threadId))[1]).toMatchObject({ status: "failed", text: "Claude declined to answer this" });
});

test("a_side_chat_forked_after_a_refused_turn_does_not_replay_it_either", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["x"], stopReason: "refusal", category: "cyber" }, { kind: "answer", chunks: ["ok1"] }, { kind: "answer", chunks: ["ok2"] });
  const threadId = await context.provider.startThread();
  await runTurn(context, threadId, "declined");
  const secondTurn = await runTurn(context, threadId, "fine");
  const forkId = await context.provider.forkThread(threadId, secondTurn);

  await runTurn(context, forkId, "in the side chat");

  expect((context.fake.requests[2]?.params["messages"] as Array<unknown>).length).toBe(3);
});

test("an_answer_served_by_another_model_is_reported_and_stored_with_the_turn", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"], servedModel: "claude-opus-4-8" });
  const threadId = await context.provider.startThread();

  const turnId = await runTurn(context, threadId, "hello");

  expect(completedEvents(context.events)).toEqual([{ type: "completed", threadId, turnId, status: "completed", error: null, servedBy: "claude-opus-4-8" }]);
  expect((await context.store.read(threadId)).turns[0]).toEqual({ turnId, userMessageIndex: 0, servedBy: "claude-opus-4-8" });
  expect((await context.provider.readThread(threadId))[1]).toMatchObject({ role: "assistant", servedBy: "claude-opus-4-8" });
});

test("an_answer_served_by_the_chats_own_model_carries_no_served_by", async () => {
  const context = await setup();
  context.fake.script({ kind: "answer", chunks: ["Hi"] });
  const threadId = await context.provider.startThread();

  const turnId = await runTurn(context, threadId, "hello");

  expect(completedEvents(context.events)).toEqual([{ type: "completed", threadId, turnId, status: "completed", error: null }]);
  expect((await context.provider.readThread(threadId))[1]).not.toHaveProperty("servedBy");
});

test("a_rejected_credential_is_reported_to_the_owner_before_the_window_is_told", async () => {
  const order: Array<string> = [];
  const context = await setup(API_KEY, () => order.push("rejected"));
  context.provider.onEvent((event) => order.push(event.type));
  context.fake.script({ kind: "fail", error: Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid" } }, "401 invalid", new Headers()) });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(order).toEqual(["rejected", "completed", "accountChanged"]);
});

test("another_error_does_not_report_a_rejected_credential", async () => {
  const order: Array<string> = [];
  const context = await setup(API_KEY, () => order.push("rejected"));
  context.fake.script({ kind: "fail", error: new Anthropic.APIConnectionError({ message: "fetch failed" }) });
  const threadId = await context.provider.startThread();

  await runTurn(context, threadId, "hello");

  expect(order).toEqual([]);
});

test("an_image_over_five_megabytes_is_refused_before_any_request_and_nothing_is_stored", async () => {
  const context = await setup();
  const threadId = await context.provider.startThread();
  const big: Attachment = { id: "x", kind: "image", name: "big.png", storedPath: "/nonexistent/big.png", bytes: 5 * 1024 * 1024 + 1, mediaType: "image/png" };

  await expect(context.provider.startTurn(threadId, { question: "q", context: null, model: "claude-opus-5-5", reasoning: "low", attachments: [big] })).rejects.toThrow("cannot send image `big.png` to Claude");

  expect(context.fake.requests).toEqual([]);
  expect(await context.store.list()).toEqual([]);
});
