// Names the IPC channels and the API object the preload script gives the renderer; the one place both sides agree.
import type { AuthEvent, LoginKind, LoginStarted } from "./auth";
import type { ProviderAccount } from "./chat-provider";
import type { Layout } from "./layout";
import type { ModelChoice, ModelOption } from "./models";
import type { ProviderId } from "./provider-id";
import type { LatencyRecord } from "./latency-record";
import type { ProviderEvent, ThreadId, TurnId } from "./provider-events";
import type { StartupErrorInfo } from "./startup-error";
import type { DisplayMessage, ThreadSummary } from "./thread-history";

export const IPC_CHANNELS = {
  startupStatus: "startup:status",
  copyText: "clipboard:copy",
  accountRead: "account:read",
  authStart: "auth:start",
  authApiKey: "auth:apiKey",
  authCancel: "auth:cancel",
  authLogout: "auth:logout",
  authChanged: "auth:changed",
  claudeSignInConsole: "claude:signInConsole",
  claudeSignInApiKey: "claude:signInApiKey",
  claudeSignOut: "claude:signOut",
  modelsList: "models:list",
  choiceRead: "choice:read",
  threadStart: "thread:start",
  threadOpen: "thread:open",
  threadList: "thread:list",
  threadFork: "thread:fork",
  chooseDiffFolder: "diff:chooseFolder",
  diffRead: "diff:read",
  layoutRead: "layout:read",
  layoutWrite: "layout:write",
  turnStart: "turn:start",
  turnInterrupt: "turn:interrupt",
  providerEvent: "provider:event",
  metricsAppend: "metrics:append",
  fault: "startup:fault",
} as const;

export type StartupStatus = Readonly<{ ok: true; codexVersion: string }> | Readonly<{ ok: false; error: StartupErrorInfo }>;

export type MarginApi = Readonly<{
  startupStatus(): Promise<StartupStatus>;
  copyText(text: string): Promise<void>;
  /** The signed-in state of `provider`; it carries a label such as "ChatGPT Plus", never a key, a token or an email. */
  accountRead(provider: ProviderId): Promise<ProviderAccount>;
  /** The four calls below sign in to OpenAI through Codex. */
  authStart(kind: LoginKind): Promise<LoginStarted>;
  authApiKey(apiKey: string): Promise<void>;
  authCancel(loginId: string): Promise<void>;
  authLogout(): Promise<void>;
  onAuthChanged(handler: (event: AuthEvent) => void): () => void;
  /** Signs in to a Claude Console account through `ant`; rejects with a message that names the fix, such as installing `ant`. */
  claudeSignInConsole(): Promise<void>;
  /** Checks the key with Anthropic and stores it encrypted; the key is never returned, logged or shown again. */
  claudeSignInApiKey(apiKey: string): Promise<void>;
  /** Deletes the stored key and logs out of Margin's own `ant` profile; other `ant` profiles and Claude Code are untouched. */
  claudeSignOut(): Promise<void>;
  /** The models `provider` offers, its default first; rejects when the provider is not signed in or not running. */
  modelsList(provider: ProviderId): Promise<ReadonlyArray<ModelOption>>;
  /** The model and reasoning level last used in a chat, or null for a chat that has none. */
  choiceRead(threadId: ThreadId): Promise<ModelChoice | null>;
  /** Starts a thread of `provider` on its default model. */
  threadStart(provider: ProviderId): Promise<ThreadId>;
  /** Opens a stored thread of `provider` and returns its messages. */
  threadOpen(provider: ProviderId, threadId: ThreadId): Promise<ReadonlyArray<DisplayMessage>>;
  /** The stored chats of every provider, newest first, each tagged with its provider. */
  threadList(): Promise<ReadonlyArray<ThreadSummary>>;
  /** Forks `threadId` through `lastTurnId` into a new thread of the same provider. */
  threadFork(provider: ProviderId, threadId: ThreadId, lastTurnId: TurnId): Promise<ThreadId>;
  /** Opens the folder dialog; null when the user cancels. */
  chooseDiffFolder(): Promise<string | null>;
  /** The `git diff` text of the folder; rejects with a message that names the folder when git fails. */
  diffRead(folder: string): Promise<string>;
  layoutRead(): Promise<Layout>;
  layoutWrite(layout: Layout): Promise<void>;
  /** `contextText` is a finished MARGIN SCREEN CONTEXT block, or null for a plain message; `choice` must be one of `modelsList(provider)` and is remembered for the chat. */
  turnStart(provider: ProviderId, threadId: ThreadId, question: string, contextText: string | null, choice: ModelChoice): Promise<TurnId>;
  turnInterrupt(provider: ProviderId, threadId: ThreadId, turnId: TurnId): Promise<void>;
  /** Appends one latency record (numbers only) to metrics.jsonl in Margin's application support folder. */
  metricsAppend(record: LatencyRecord): Promise<void>;
  /** A problem found after start-up that the window must show in full. */
  onFault(handler: (info: StartupErrorInfo) => void): () => void;
  onProviderEvent(handler: (event: ProviderEvent) => void): () => void;
}>;
