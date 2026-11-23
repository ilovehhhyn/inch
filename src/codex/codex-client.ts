// Gives typed methods over the app-server connection: initialize, account, sign-in, threads and turns.
import { isAbsolute } from "node:path";

import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../shared/provider-events";
import type { ScreenContext } from "../shared/screen-context";
import type { AccountSummary, AccountType, AuthEvent, LoginKind, LoginStarted } from "../shared/auth";
import type { Logger } from "../shared/log";
import type { ServerNotification } from "./generated/ServerNotification";
import type { AccountLoginCompletedNotification } from "./generated/v2/AccountLoginCompletedNotification";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { Thread } from "./generated/v2/Thread";
import type { RpcConnection } from "./rpc-connection";
import type { JsonValue, Unsubscribe } from "./rpc-types";

const CLIENT_NAME = "margin";
const CLIENT_TITLE = "Margin";
const UNSUPPORTED_ACCOUNT_FIX = "sign out of Codex and sign in with ChatGPT or an OpenAI API key";

/** The turn separator: two text inputs are stored joined with no separator, so the context item ends with a blank line. */
const CONTEXT_SEPARATOR = "\n\n";

export const MARGIN_INSTRUCTIONS =
  "You are a reading companion inside a chat app. Some user messages begin with a block marked MARGIN SCREEN CONTEXT. That block is the text the user was looking at when they asked. When it is present, the question refers to it: start your answer by naming what you read (the message, section, file and line), then answer. Quote file names, function names and line numbers exactly as they appear in the block. Never run commands or edit files.";

/**
 * Thread config that removes tools Margin must not offer. `features.shell_tool=false` removes the shell (measured in
 * docs/spikes/codex-app-server.md); `apps` and `plugins` remove the connectors and plugin tools. MCP servers from the
 * user's own Codex configuration are not covered by these keys.
 */
export const SHELL_TOOL_DISABLE: { readonly [key: string]: JsonValue } = { features: { shell_tool: false, apps: false, plugins: false } };

export type ThreadDefaults = Readonly<{
  cwd: string;
  sandbox: "read-only";
  approvalPolicy: "never";
  developerInstructions: string;
  config: { readonly [key: string]: JsonValue };
  serviceName: "margin";
}>;

/** Settings every thread Margin creates, resumes or forks must carry: read-only sandbox, no approvals, Margin's empty directory. */
export function createThreadDefaults(emptyWorkspacePath: string): ThreadDefaults {
  if (!isAbsolute(emptyWorkspacePath)) throw new Error(`empty workspace path must be absolute, got \`${emptyWorkspacePath}\`; pass a path under Margin's application support directory`);
  return { cwd: emptyWorkspacePath, sandbox: "read-only", approvalPolicy: "never", developerInstructions: MARGIN_INSTRUCTIONS, config: SHELL_TOOL_DISABLE, serviceName: "margin" };
}

export type CodexClientOptions = Readonly<{
  connection: RpcConnection;
  appVersion: string;
  openExternal: (url: string) => Promise<void>;
  log: Logger;
  emptyWorkspacePath: string;
}>;

export type ActiveTurn = Readonly<{ threadId: ThreadId; turnId: TurnId }>;

function unsupportedAccount(type: string): Error {
  return new Error(`unsupported account type \`${type}\`; ${UNSUPPORTED_ACCOUNT_FIX}`);
}

function accountTypeOfAuthMode(authMode: string): AccountType {
  if (authMode === "chatgpt") return "chatgpt";
  if (authMode === "apikey") return "apiKey";
  throw unsupportedAccount(authMode);
}

/** Reduces the app-server's account record to what the renderer may see; the email is dropped here. */
export function summarizeAccount(response: GetAccountResponse): AccountSummary {
  const { account } = response;
  if (account === null) return { signedIn: false };
  if (account.type === "chatgpt") return { signedIn: true, accountType: "chatgpt", planType: account.planType };
  if (account.type === "apiKey") return { signedIn: true, accountType: "apiKey", planType: null };
  throw unsupportedAccount(account.type);
}

/** Maps `account/updated` to an auth event; `authMode: null` means the account signed out. */
export function toAccountEvent(notification: ServerNotification): AuthEvent | null {
  if (notification.method !== "account/updated") return null;
  const { authMode, planType } = notification.params;
  if (authMode === null) return { type: "account", summary: { signedIn: false } };
  return { type: "account", summary: { signedIn: true, accountType: accountTypeOfAuthMode(authMode), planType } };
}

function loginMismatch(asked: LoginKind, answered: string): Error {
  return new Error(`asked for a \`${asked}\` login but the app-server answered \`${answered}\`; update Margin or Codex so their versions match`);
}

function requireHttps(url: string): void {
  if (!url.startsWith("https://")) throw new Error(`auth url must use https, got \`${url.slice(0, 40)}\`; the app-server answered with an unexpected address`);
}

/** Maps the notifications the reducer consumes to provider events; every other notification is ignored. */
export function toProviderEvent(notification: ServerNotification): ProviderEvent | null {
  if (notification.method === "item/agentMessage/delta") {
    const { threadId, turnId, delta } = notification.params;
    return { type: "delta", threadId: asThreadId(threadId), turnId: asTurnId(turnId), text: delta };
  }
  if (notification.method === "turn/completed") {
    const { threadId, turn } = notification.params;
    if (turn.status === "inProgress") throw new Error("turn/completed arrived with status `inProgress`; the app-server protocol changed, regenerate the bindings");
    return { type: "completed", threadId: asThreadId(threadId), turnId: asTurnId(turn.id), status: turn.status, error: turn.error?.message ?? null };
  }
  if (notification.method === "account/updated") return { type: "accountChanged", provider: "codex" };
  return null;
}

function requireText(value: string, name: string): void {
  if (value.trim() === "") throw new Error(`${name} must not be empty`);
}

export class CodexClient {
  private readonly connection: RpcConnection;
  private readonly appVersion: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly log: Logger;
  private readonly threadDefaults: ThreadDefaults;
  private readonly emptyWorkspacePath: string;
  private readonly resumable = new Set<ThreadId>();
  private readonly turns = new Map<TurnId, ThreadId>();

  constructor(options: CodexClientOptions) {
    this.connection = options.connection;
    this.appVersion = options.appVersion;
    this.openExternal = options.openExternal;
    this.log = options.log;
    this.emptyWorkspacePath = options.emptyWorkspacePath;
    this.threadDefaults = createThreadDefaults(options.emptyWorkspacePath);
    this.connection.onNotification((notification) => this.trackTurns(notification));
  }

  /** Turns that started and have not completed; a crash fails exactly these. */
  activeTurns(): Array<ActiveTurn> {
    return [...this.turns].map(([turnId, threadId]) => ({ threadId, turnId }));
  }

  /** Threads that have run a turn: only these have a rollout on disk, so only these can be resumed by a restarted app-server. */
  resumableThreads(): Array<ThreadId> {
    return [...this.resumable];
  }

  private trackTurns(notification: ServerNotification): void {
    if (notification.method === "turn/started") this.turns.set(asTurnId(notification.params.turn.id), asThreadId(notification.params.threadId));
    if (notification.method === "turn/completed") this.turns.delete(asTurnId(notification.params.turn.id));
  }

  /** Sends `initialize`, then the `initialized` notification only after the response arrives. */
  async initialize(): Promise<InitializeResponse> {
    const response = await this.connection.request("initialize", {
      clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: this.appVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.connection.notify("initialized");
    return response;
  }

  readAccount(): Promise<GetAccountResponse> {
    return this.connection.request("account/read", {});
  }

  async startLogin(kind: LoginKind): Promise<LoginStarted> {
    this.log(`login start type=${kind}`);
    const response = await this.connection.request("account/login/start", { type: kind });
    if (kind === "chatgpt") {
      if (response.type !== "chatgpt") throw loginMismatch(kind, response.type);
      requireHttps(response.authUrl);
      await this.openExternal(response.authUrl);
      return { kind, loginId: response.loginId };
    }
    if (response.type !== "chatgptDeviceCode") throw loginMismatch(kind, response.type);
    requireHttps(response.verificationUrl);
    return { kind, loginId: response.loginId, verificationUrl: response.verificationUrl, userCode: response.userCode };
  }

  /** Sends the key once and never logs it or lets it appear in an error message. */
  async startApiKeyLogin(apiKey: string): Promise<void> {
    if (apiKey.trim() === "") throw new Error("api key must not be empty; paste the key from the OpenAI dashboard");
    this.log("login start type=apiKey");
    try {
      await this.connection.request("account/login/start", { type: "apiKey", apiKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replaceAll(apiKey, "[redacted]"));
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.connection.request("account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.connection.request("account/logout", undefined);
  }

  onLoginCompleted(handler: (event: AccountLoginCompletedNotification) => void): Unsubscribe {
    return this.connection.onNotification((notification) => {
      if (notification.method === "account/login/completed") handler(notification.params);
    });
  }

  onAccountEvent(handler: (event: AuthEvent) => void): Unsubscribe {
    return this.connection.onNotification((notification) => {
      const event = toAccountEvent(notification);
      if (event !== null) handler(event);
    });
  }

  async startThread(options: Readonly<{ model: string }>): Promise<ThreadId> {
    requireText(options.model, "model");
    const { thread } = await this.connection.request("thread/start", { model: options.model, ...this.threadDefaults });
    return asThreadId(thread.id);
  }

  async resumeThread(threadId: ThreadId): Promise<void> {
    await this.connection.request("thread/resume", { threadId, ...this.threadDefaults });
    this.resumable.add(threadId);
  }

  /** Forks `threadId` through `lastTurnId` (all turns when null) into a new thread with Margin's defaults. */
  async forkThread(threadId: ThreadId, lastTurnId: TurnId | null): Promise<ThreadId> {
    const { thread } = await this.connection.request("thread/fork", { threadId, lastTurnId, ...this.threadDefaults });
    return asThreadId(thread.id);
  }

  /** Lists the threads that use Margin's empty workspace, which are the threads Margin created. */
  async listThreads(): Promise<Array<Thread>> {
    const response = await this.connection.request("thread/list", { cwd: this.emptyWorkspacePath });
    return response.data;
  }

  async readThread(threadId: ThreadId): Promise<Thread> {
    const { thread } = await this.connection.request("thread/read", { threadId, includeTurns: true });
    return thread;
  }

  /** Sends the context and the question as two text items; the context item ends with a blank line so they do not run together. */
  async startTurn(threadId: ThreadId, input: Readonly<{ question: string; context: ScreenContext | null }>): Promise<TurnId> {
    requireText(input.question, "question");
    const items = [...(input.context === null ? [] : [input.context.text + CONTEXT_SEPARATOR]), input.question];
    const { turn } = await this.connection.request("turn/start", { threadId, input: items.map((text) => ({ type: "text" as const, text, text_elements: [] })) });
    const turnId = asTurnId(turn.id);
    this.turns.set(turnId, threadId);
    this.resumable.add(threadId);
    return turnId;
  }

  async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
    await this.connection.request("turn/interrupt", { threadId, turnId });
  }

  onProviderEvent(handler: (event: ProviderEvent) => void): Unsubscribe {
    return this.connection.onNotification((notification) => {
      const event = toProviderEvent(notification);
      if (event !== null) handler(event);
    });
  }
}

