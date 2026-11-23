// A hand-written MarginApi for renderer tests: scripted answers, recorded calls and an emitter for auth events.
import type { AccountSummary, AuthEvent, LoginKind, LoginStarted } from "../../src/shared/auth";
import type { ProviderAccount } from "../../src/shared/chat-provider";
import { DEFAULT_LAYOUT, type Layout } from "../../src/shared/layout";
import type { MarginApi, StartupStatus } from "../../src/shared/ipc-contract";
import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../../src/shared/provider-events";
import type { ModelChoice, ModelOption } from "../../src/shared/models";
import type { LatencyRecord } from "../../src/shared/latency-record";
import type { ProviderId } from "../../src/shared/provider-id";
import type { StartupErrorInfo } from "../../src/shared/startup-error";
import type { DisplayMessage, ThreadSummary } from "../../src/shared/thread-history";

export const SIGNED_IN_CHATGPT: AccountSummary = { signedIn: true, accountType: "chatgpt", planType: "plus" };

/** The choice a chat starts with when nothing is stored: the first Codex model with its default level. */
export const CODEX_DEFAULT_CHOICE: ModelChoice = { model: "gpt-5.6-sol", reasoning: "medium" };

export class FakeMarginApi implements MarginApi {
  account: AccountSummary = SIGNED_IN_CHATGPT;
  startup: StartupStatus = { ok: true, codexVersion: "0.146.0" };
  loginStarted: LoginStarted = { kind: "chatgpt", loginId: "login-1" };
  readonly calls: Array<string> = [];
  readonly apiKeys: Array<string> = [];
  /** Every `turn/start` the window sent: the exact arguments, in order. */
  readonly turnStarts: Array<Readonly<{ threadId: ThreadId; question: string; contextText: string | null; choice: ModelChoice }>> = [];
  /** Every provider-scoped call as `<call>:<provider>`, in order, so a test can see which provider a call named. */
  readonly providerCalls: Array<string> = [];
  readonly latencyRecords: Array<LatencyRecord> = [];
  readonly interrupts: Array<Readonly<{ threadId: ThreadId; turnId: TurnId }>> = [];
  threads: Array<ThreadSummary> = [];
  histories = new Map<ThreadId, ReadonlyArray<DisplayMessage>>();
  /** Ids handed out by `threadStart` and `turnStart`, in order of use. */
  nextThreadIds: Array<string> = ["thread-1", "thread-2", "thread-3"];
  readonly forks: Array<Readonly<{ threadId: ThreadId; lastTurnId: TurnId }>> = [];
  nextForkIds: Array<string> = ["side-1", "side-2", "side-3"];
  /** What the folder dialog returns next; null means the user cancelled. */
  chosenFolder: string | null = null;
  diffs = new Map<string, string>();
  readonly diffReads: Array<string> = [];
  layout: Layout = DEFAULT_LAYOUT;
  readonly layoutWrites: Array<Layout> = [];
  private turnCounter = 0;
  private readonly handlers = new Set<(event: AuthEvent) => void>();
  private readonly faultHandlers = new Set<(info: StartupErrorInfo) => void>();
  private readonly providerHandlers = new Set<(event: ProviderEvent) => void>();

  startupStatus = async (): Promise<StartupStatus> => this.startup;
  copyText = async (): Promise<void> => undefined;
  /** The Claude account; the OpenAI one is `account`. */
  claudeAccount: ProviderAccount = { provider: "claude", signedIn: false, label: null };
  accountRead = async (provider: ProviderId): Promise<ProviderAccount> => {
    if (provider === "claude") return this.claudeAccount;
    return { provider: "codex", signedIn: this.account.signedIn, label: this.account.signedIn ? "ChatGPT Plus" : null };
  };
  authStart = async (kind: LoginKind): Promise<LoginStarted> => {
    this.calls.push(`start:${kind}`);
    return this.loginStarted;
  };
  authApiKey = async (apiKey: string): Promise<void> => {
    this.calls.push("apiKey");
    this.apiKeys.push(apiKey);
  };
  /** When set, the Claude sign-in calls reject with it. */
  claudeSignInError: Error | null = null;
  readonly claudeApiKeys: Array<string> = [];
  claudeSignInConsole = async (): Promise<void> => {
    this.calls.push("claudeSignInConsole");
    if (this.claudeSignInError !== null) throw this.claudeSignInError;
  };
  claudeSignInApiKey = async (apiKey: string): Promise<void> => {
    this.calls.push("claudeSignInApiKey");
    this.claudeApiKeys.push(apiKey);
    if (this.claudeSignInError !== null) throw this.claudeSignInError;
  };
  claudeSignOut = async (): Promise<void> => {
    this.calls.push("claudeSignOut");
    this.claudeAccount = { provider: "claude", signedIn: false, label: null };
  };
  authCancel = async (loginId: string): Promise<void> => {
    this.calls.push(`cancel:${loginId}`);
  };
  authLogout = async (): Promise<void> => {
    this.calls.push("logout");
  };
  onAuthChanged = (handler: (event: AuthEvent) => void): (() => void) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  };

  /** What `modelsList` answers per provider; every provider has one model with three levels unless a test sets more. */
  models = new Map<ProviderId, ReadonlyArray<ModelOption>>([
    ["codex", [{ provider: "codex", id: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningLevels: ["low", "medium", "high"], defaultReasoning: "medium", acceptsImages: true, acceptsPdfs: false }]],
    ["claude", [{ provider: "claude", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "low", acceptsImages: true, acceptsPdfs: true }]],
  ]);
  readonly modelListCalls: Array<ProviderId> = [];
  /** The choice `choiceRead` answers per chat. */
  choices = new Map<ThreadId, ModelChoice>();
  modelsList = async (provider: ProviderId): Promise<ReadonlyArray<ModelOption>> => {
    this.modelListCalls.push(provider);
    const models = this.models.get(provider);
    if (models === undefined) throw new Error(`the fake has no models for ${provider}; add them to models`);
    return models;
  };
  choiceRead = async (threadId: ThreadId): Promise<ModelChoice | null> => this.choices.get(threadId) ?? null;
  threadStart = async (provider: ProviderId): Promise<ThreadId> => {
    this.calls.push("threadStart");
    this.providerCalls.push(`threadStart:${provider}`);
    const id = this.nextThreadIds.shift();
    if (id === undefined) throw new Error("the fake has no thread id left; add one to nextThreadIds");
    return asThreadId(id);
  };
  threadOpen = async (provider: ProviderId, threadId: ThreadId): Promise<ReadonlyArray<DisplayMessage>> => {
    this.calls.push(`threadOpen:${threadId}`);
    this.providerCalls.push(`threadOpen:${provider}`);
    return this.histories.get(threadId) ?? [];
  };
  threadList = async (): Promise<ReadonlyArray<ThreadSummary>> => this.threads;
  threadFork = async (provider: ProviderId, threadId: ThreadId, lastTurnId: TurnId): Promise<ThreadId> => {
    this.providerCalls.push(`threadFork:${provider}`);
    this.forks.push({ threadId, lastTurnId });
    const id = this.nextForkIds.shift();
    if (id === undefined) throw new Error("the fake has no fork id left; add one to nextForkIds");
    return asThreadId(id);
  };
  chooseDiffFolder = async (): Promise<string | null> => this.chosenFolder;
  diffRead = async (folder: string): Promise<string> => {
    this.diffReads.push(folder);
    const text = this.diffs.get(folder);
    if (text === undefined) throw new Error(`the fake has no diff for ${folder}; add one to diffs`);
    return text;
  };
  layoutRead = async (): Promise<Layout> => this.layout;
  layoutWrite = async (layout: Layout): Promise<void> => {
    this.layoutWrites.push(layout);
    this.layout = layout;
  };
  turnStart = async (provider: ProviderId, threadId: ThreadId, question: string, contextText: string | null, choice: ModelChoice): Promise<TurnId> => {
    this.providerCalls.push(`turnStart:${provider}`);
    this.turnStarts.push({ threadId, question, contextText, choice });
    this.choices.set(threadId, choice);
    this.turnCounter += 1;
    return asTurnId(`turn-${this.turnCounter}`);
  };
  metricsAppend = async (record: LatencyRecord): Promise<void> => {
    this.latencyRecords.push(record);
  };
  turnInterrupt = async (provider: ProviderId, threadId: ThreadId, turnId: TurnId): Promise<void> => {
    this.providerCalls.push(`turnInterrupt:${provider}`);
    this.interrupts.push({ threadId, turnId });
  };
  onProviderEvent = (handler: (event: ProviderEvent) => void): (() => void) => {
    this.providerHandlers.add(handler);
    return () => {
      this.providerHandlers.delete(handler);
    };
  };

  onFault = (handler: (info: StartupErrorInfo) => void): (() => void) => {
    this.faultHandlers.add(handler);
    return () => {
      this.faultHandlers.delete(handler);
    };
  };

  emitFault(info: StartupErrorInfo): void {
    for (const handler of this.faultHandlers) handler(info);
  }

  emitProvider(event: ProviderEvent): void {
    for (const handler of this.providerHandlers) handler(event);
  }

  emit(event: AuthEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
