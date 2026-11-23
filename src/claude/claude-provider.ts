// Implements the ChatProvider interface over the Anthropic Messages API, keeping each chat in a local file because the API stores no conversation.
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

import type { ChatProvider, ProviderAccount, TurnInput } from "../shared/chat-provider";
import { renderContextBlock } from "../shared/context-format";
import { requireModelChoice, type ModelOption } from "../shared/models";
import { MARGIN_INSTRUCTIONS } from "../shared/margin-instructions";
import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../shared/provider-events";
import type { DisplayMessage, ThreadSummary } from "../shared/thread-history";
import { betasFor, claudeAccountOf, createClaudeClient, type ClaudeClientOptions, type ClaudeCredential } from "./claude-credentials";
import { CLAUDE_EFFORTS, parseClaudeEffort, type ClaudeEffort, type ClaudeThreadFile, type ClaudeThreadStore, type StoredMessage } from "./claude-thread-store";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
/** Provisional: the plan picks the lower effort unless its answers are wrong on the latency probe, and the probe has not run (docs/spikes/claude.md). */
export const CLAUDE_DEFAULT_EFFORT: ClaudeEffort = "low";
/** The output bound with streaming (bundled Claude API reference); thinking tokens count toward it. */
export const CLAUDE_MAX_TOKENS = 64_000;
/** The models Margin offers for Claude; each is checked against `models.retrieve` at sign-in, and Helen adds any further model here. */
export const CLAUDE_MODELS: ReadonlyArray<ModelOption> = [
  { provider: "claude", id: CLAUDE_DEFAULT_MODEL, label: "Claude Opus 5.5", reasoningLevels: CLAUDE_EFFORTS, defaultReasoning: CLAUDE_DEFAULT_EFFORT, acceptsImages: true, acceptsPdfs: true },
];
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const NOT_SIGNED_IN = "Claude is not signed in; sign in from the Accounts page";
export const STOPPED_BEFORE_ANY_ANSWER = "(stopped before any answer)";
const SIGN_IN_EXPIRED = "Claude sign-in expired. Sign in again";
const UNREACHABLE = "Cannot reach Anthropic. Check the connection";
const REFUSED = "Claude declined to answer this";
const TITLE_MAX_CHARS = 60;
const EMPTY_TITLE = "New chat";

export type ClaudeProviderOptions = Readonly<{
  /** The credential to use now; null when signed out. */
  credentials: () => Promise<ClaudeCredential | null>;
  store: ClaudeThreadStore;
  makeClient?: (credential: ClaudeCredential) => Anthropic;
  clientOptions?: ClaudeClientOptions;
  /** Makes the ids of threads and turns; random by default. */
  createId?: () => string;
}>;

type ActiveTurn = { readonly turnId: TurnId; readonly controller: AbortController; shownText: string; isInterrupted: boolean };

type Outcome = Readonly<{ status: "completed" | "interrupted" | "refused"; error: string | null; content: Anthropic.Beta.BetaAssistantMessageParam["content"] }>;

function textOf(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** The question of a stored user message: its last text block, because a context block, when present, comes first. */
function questionOf(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  const texts = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  return texts.at(-1) ?? "";
}

function titleOf(file: ClaudeThreadFile): string {
  const first = file.messages[0];
  const title = first === undefined ? "" : (questionOf(first.content).split("\n")[0]?.trim().slice(0, TITLE_MAX_CHARS) ?? "");
  return title === "" ? EMPTY_TITLE : title;
}

function describeFailure(error: unknown): Readonly<{ message: string; isAccountChange: boolean }> {
  if (error instanceof Anthropic.AuthenticationError) return { message: SIGN_IN_EXPIRED, isAccountChange: true };
  if (error instanceof Anthropic.RateLimitError) {
    const seconds = Number(error.headers.get("retry-after"));
    return { message: `Claude rate limit reached. Try again ${Number.isFinite(seconds) && seconds > 0 ? `in ${Math.ceil(seconds)} s` : "later"}`, isAccountChange: false };
  }
  if (error instanceof Anthropic.APIConnectionError) return { message: UNREACHABLE, isAccountChange: false };
  return { message: error instanceof Error ? error.message : String(error), isAccountChange: false };
}

export function createClaudeProvider(options: ClaudeProviderOptions): ChatProvider {
  const handlers = new Set<(event: ProviderEvent) => void>();
  const createId = options.createId ?? randomUUID;
  const makeClient = options.makeClient ?? ((credential: ClaudeCredential) => createClaudeClient(credential, options.clientOptions));
  /** Chats started in this session whose first turn has not finished; they have no file yet. */
  const unsaved = new Map<ThreadId, ClaudeThreadFile>();
  const active = new Map<ThreadId, ActiveTurn>();

  const emit = (event: ProviderEvent): void => {
    for (const handler of [...handlers]) handler(event);
  };

  async function load(threadId: ThreadId): Promise<ClaudeThreadFile> {
    return unsaved.get(threadId) ?? options.store.read(threadId);
  }

  /** Streams the answer to `file.messages` plus `userMessage`, emitting each text delta; returns how the turn ended. */
  async function stream(credential: ClaudeCredential, file: ClaudeThreadFile, userMessage: Anthropic.Beta.BetaUserMessageParam, turn: ActiveTurn): Promise<Outcome> {
    const client = makeClient(credential);
    const request = client.beta.messages.stream(
      {
        model: file.model,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: MARGIN_INSTRUCTIONS,
        messages: [...file.messages, userMessage],
        output_config: { effort: file.effort },
        betas: betasFor(credential, [SERVER_SIDE_FALLBACK_BETA]),
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
      },
      { signal: turn.controller.signal },
    );
    for await (const event of request) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        turn.shownText += event.delta.text;
        emit({ type: "delta", threadId: file.threadId, turnId: turn.turnId, text: event.delta.text });
      }
    }
    const final = await request.finalMessage();
    if (final.stop_reason === "refusal") {
      const category = final.stop_details?.category ?? null;
      return { status: "refused", error: category === null ? REFUSED : `${REFUSED} (category: ${category})`, content: final.content.length > 0 ? final.content : [{ type: "text", text: REFUSED }] };
    }
    return { status: "completed", error: null, content: final.content };
  }

  /** The assistant message of a turn that ended early: the text already shown, else a marker, so user and assistant messages keep alternating. */
  function interruptedOutcome(turn: ActiveTurn): Outcome {
    return { status: "interrupted", error: null, content: [{ type: "text", text: turn.shownText === "" ? STOPPED_BEFORE_ANY_ANSWER : turn.shownText }] };
  }

  async function runTurn(credential: ClaudeCredential, file: ClaudeThreadFile, userMessage: Anthropic.Beta.BetaUserMessageParam, turn: ActiveTurn): Promise<void> {
    const threadId = file.threadId;
    try {
      let outcome: Outcome;
      try {
        outcome = await stream(credential, file, userMessage, turn);
      } catch (error) {
        if (!turn.isInterrupted) throw error;
        outcome = interruptedOutcome(turn);
      }
      const saved: ClaudeThreadFile = {
        ...file,
        messages: [...file.messages, userMessage, { role: "assistant", content: outcome.content }],
        turns: [...file.turns, { turnId: turn.turnId, userMessageIndex: file.messages.length }],
      };
      await options.store.write(saved);
      unsaved.delete(threadId);
      emit({ type: "completed", threadId, turnId: turn.turnId, status: outcome.status, error: outcome.error });
    } catch (error) {
      const { message, isAccountChange } = describeFailure(error);
      emit({ type: "completed", threadId, turnId: turn.turnId, status: "failed", error: message });
      if (isAccountChange) emit({ type: "accountChanged", provider: "claude" });
    } finally {
      active.delete(threadId);
    }
  }

  return {
    id: "claude",
    async readAccount(): Promise<ProviderAccount> {
      return claudeAccountOf(await options.credentials());
    },
    async listModels() {
      return CLAUDE_MODELS;
    },
    async startThread() {
      const threadId = asThreadId(createId());
      unsaved.set(threadId, { version: 1, threadId, forkedFrom: null, model: CLAUDE_DEFAULT_MODEL, effort: CLAUDE_DEFAULT_EFFORT, messages: [], turns: [] });
      return threadId;
    },
    async forkThread(threadId, lastTurnId) {
      const parent = await load(threadId);
      const through = lastTurnId === null ? parent.turns.length - 1 : parent.turns.findIndex((turn) => turn.turnId === lastTurnId);
      if (through < 0) throw new Error(`chat ${threadId} has no turn ${lastTurnId}; open the chat it was forked from or close this side chat`);
      const lastTurn = parent.turns[through];
      if (lastTurn === undefined) throw new Error(`chat ${threadId} has no turns to fork; send a message first`);
      const forkId = asThreadId(createId());
      await options.store.write({ ...parent, threadId: forkId, forkedFrom: threadId, messages: parent.messages.slice(0, lastTurn.userMessageIndex + 2), turns: parent.turns.slice(0, through + 1) });
      return forkId;
    },
    async startTurn(threadId: ThreadId, input: TurnInput) {
      if (input.question.trim() === "") throw new Error("question must not be empty");
      if (active.has(threadId)) throw new Error("a turn is already running in this chat; wait for the answer or stop it first");
      requireModelChoice(CLAUDE_MODELS, { model: input.model, reasoning: input.reasoning });
      const credential = await options.credentials();
      if (credential === null) throw new Error(NOT_SIGNED_IN);
      const file: ClaudeThreadFile = { ...(await load(threadId)), model: input.model, effort: parseClaudeEffort(input.reasoning) };
      const content: Array<Anthropic.Beta.BetaTextBlockParam> = [...(input.context === null ? [] : [{ type: "text" as const, text: renderContextBlock(input.context) }]), { type: "text", text: input.question }];
      const turn: ActiveTurn = { turnId: asTurnId(createId()), controller: new AbortController(), shownText: "", isInterrupted: false };
      active.set(threadId, turn);
      void runTurn(credential, file, { role: "user", content }, turn); // answers and failures reach the window as events; runTurn never rejects
      return turn.turnId;
    },
    async interruptTurn(threadId, turnId) {
      const turn = active.get(threadId);
      if (turn === undefined || turn.turnId !== turnId) throw new Error(`turn ${turnId} is not running in chat ${threadId}`);
      turn.isInterrupted = true;
      turn.controller.abort();
    },
    async readThread(threadId): Promise<ReadonlyArray<DisplayMessage>> {
      const file = await load(threadId);
      return file.turns.flatMap((turn): Array<DisplayMessage> => {
        const user = file.messages[turn.userMessageIndex];
        const assistant = file.messages[turn.userMessageIndex + 1];
        if (user === undefined || assistant === undefined) throw new Error(`chat ${threadId} turn ${turn.turnId} points outside its messages; delete the chat's file to remove it`);
        return [
          { turnId: turn.turnId, role: "user", text: questionOf(user.content), status: "done" },
          { turnId: turn.turnId, role: "assistant", text: textOf(assistant.content), status: "done" },
        ];
      });
    },
    async listThreads(): Promise<ReadonlyArray<ThreadSummary>> {
      return (await options.store.list())
        .filter((stored) => stored.file.forkedFrom === null && stored.file.turns.length > 0)
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .map((stored) => ({ id: stored.file.threadId, provider: "claude", title: titleOf(stored.file), updatedAtSec: Math.floor(stored.updatedAtMs / 1000) }));
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
