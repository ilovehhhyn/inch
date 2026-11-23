// Names the IPC channels and the API object the preload script gives the renderer; the one place both sides agree.
import type { AccountSummary, AuthEvent, LoginKind, LoginStarted } from "./auth";
import type { Layout } from "./layout";
import type { LatencyRecord } from "./latency-record";
import type { ProviderEvent, ThreadId, TurnId } from "./provider-events";
import type { StartupErrorInfo } from "./startup-error";
import type { DisplayMessage, ThreadSummary } from "./thread-history";

export const IPC_CHANNELS = {
  startupStatus: "startup:status",
  copyText: "clipboard:copy",
  authRead: "auth:read",
  authStart: "auth:start",
  authApiKey: "auth:apiKey",
  authCancel: "auth:cancel",
  authLogout: "auth:logout",
  authChanged: "auth:changed",
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
  authRead(): Promise<AccountSummary>;
  authStart(kind: LoginKind): Promise<LoginStarted>;
  authApiKey(apiKey: string): Promise<void>;
  authCancel(loginId: string): Promise<void>;
  authLogout(): Promise<void>;
  onAuthChanged(handler: (event: AuthEvent) => void): () => void;
  /** Starts a thread on the account's default model. */
  threadStart(): Promise<ThreadId>;
  /** Resumes a stored thread and returns its messages. */
  threadOpen(threadId: ThreadId): Promise<ReadonlyArray<DisplayMessage>>;
  threadList(): Promise<ReadonlyArray<ThreadSummary>>;
  /** Forks `threadId` through `lastTurnId` into a new thread on the account's default model. */
  threadFork(threadId: ThreadId, lastTurnId: TurnId): Promise<ThreadId>;
  /** Opens the folder dialog; null when the user cancels. */
  chooseDiffFolder(): Promise<string | null>;
  /** The `git diff` text of the folder; rejects with a message that names the folder when git fails. */
  diffRead(folder: string): Promise<string>;
  layoutRead(): Promise<Layout>;
  layoutWrite(layout: Layout): Promise<void>;
  /** `contextText` is a finished MARGIN SCREEN CONTEXT block, or null for a plain message. */
  turnStart(threadId: ThreadId, question: string, contextText: string | null): Promise<TurnId>;
  turnInterrupt(threadId: ThreadId, turnId: TurnId): Promise<void>;
  /** Appends one latency record (numbers only) to metrics.jsonl in Margin's application support folder. */
  metricsAppend(record: LatencyRecord): Promise<void>;
  /** A problem found after start-up that the window must show in full. */
  onFault(handler: (info: StartupErrorInfo) => void): () => void;
  onProviderEvent(handler: (event: ProviderEvent) => void): () => void;
}>;
