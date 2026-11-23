// A hand-written MarginApi for renderer tests: scripted answers, recorded calls and an emitter for auth events.
import type { AccountSummary, AuthEvent, LoginKind, LoginStarted } from "../../src/shared/auth";
import { DEFAULT_LAYOUT, type Layout } from "../../src/shared/layout";
import type { MarginApi, StartupStatus } from "../../src/shared/ipc-contract";
import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../../src/shared/provider-events";
import type { LatencyRecord } from "../../src/shared/latency-record";
import type { StartupErrorInfo } from "../../src/shared/startup-error";
import type { HistoryMessage, ThreadSummary } from "../../src/shared/thread-history";

export const SIGNED_IN_CHATGPT: AccountSummary = { signedIn: true, accountType: "chatgpt", planType: "plus" };

export class FakeMarginApi implements MarginApi {
  account: AccountSummary = SIGNED_IN_CHATGPT;
  startup: StartupStatus = { ok: true, codexVersion: "0.146.0" };
  loginStarted: LoginStarted = { kind: "chatgpt", loginId: "login-1" };
  readonly calls: Array<string> = [];
  readonly apiKeys: Array<string> = [];
  /** Every `turn/start` the window sent: the exact arguments, in order. */
  readonly turnStarts: Array<Readonly<{ threadId: ThreadId; question: string; contextText: string | null }>> = [];
  readonly latencyRecords: Array<LatencyRecord> = [];
  readonly interrupts: Array<Readonly<{ threadId: ThreadId; turnId: TurnId }>> = [];
  threads: Array<ThreadSummary> = [];
  histories = new Map<ThreadId, ReadonlyArray<HistoryMessage>>();
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
  authRead = async (): Promise<AccountSummary> => this.account;
  authStart = async (kind: LoginKind): Promise<LoginStarted> => {
    this.calls.push(`start:${kind}`);
    return this.loginStarted;
  };
  authApiKey = async (apiKey: string): Promise<void> => {
    this.calls.push("apiKey");
    this.apiKeys.push(apiKey);
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

  threadStart = async (): Promise<ThreadId> => {
    this.calls.push("threadStart");
    const id = this.nextThreadIds.shift();
    if (id === undefined) throw new Error("the fake has no thread id left; add one to nextThreadIds");
    return asThreadId(id);
  };
  threadOpen = async (threadId: ThreadId): Promise<ReadonlyArray<HistoryMessage>> => {
    this.calls.push(`threadOpen:${threadId}`);
    return this.histories.get(threadId) ?? [];
  };
  threadList = async (): Promise<ReadonlyArray<ThreadSummary>> => this.threads;
  threadFork = async (threadId: ThreadId, lastTurnId: TurnId): Promise<ThreadId> => {
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
  turnStart = async (threadId: ThreadId, question: string, contextText: string | null): Promise<TurnId> => {
    this.turnStarts.push({ threadId, question, contextText });
    this.turnCounter += 1;
    return asTurnId(`turn-${this.turnCounter}`);
  };
  metricsAppend = async (record: LatencyRecord): Promise<void> => {
    this.latencyRecords.push(record);
  };
  turnInterrupt = async (threadId: ThreadId, turnId: TurnId): Promise<void> => {
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
