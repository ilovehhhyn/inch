// Gives typed methods over the app-server connection: initialize, account, sign-in, threads and turns.
import { isAbsolute } from "node:path";

import type { StartupErrorInfo } from "../shared/startup-error";
import { asThreadId, asTurnId, type ProviderEvent, type ThreadId, type TurnId } from "../shared/provider-events";
import type { RenderedContext } from "../shared/rendered-context";
import type { AccountSummary, AccountType, AuthEvent, LoginKind, LoginStarted } from "../shared/auth";
import type { Logger } from "../shared/log";
import type { ServerNotification } from "./generated/ServerNotification";
import type { AccountLoginCompletedNotification } from "./generated/v2/AccountLoginCompletedNotification";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { InitializeResponse } from "./generated/InitializeResponse";
import { buildMcpDisableConfig } from "./mcp-overrides";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { RpcConnection } from "./rpc-connection";
import type { JsonValue, Unsubscribe } from "./rpc-types";

const CLIENT_NAME = "margin";
const CLIENT_TITLE = "Margin";
const UNSUPPORTED_ACCOUNT_FIX = "sign out of Codex and sign in with ChatGPT or an OpenAI API key";

/** The turn separator: two text inputs are stored joined with no separator, so the context item ends with a blank line. */
/** A bound on pages of `thread/list`, so a server that never ends the list cannot loop the client. */
const MAX_LIST_PAGES = 50;

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
export function createThreadDefaults(emptyWorkspacePath: string, mcpServers: { readonly [name: string]: JsonValue } = {}): ThreadDefaults {
  if (!isAbsolute(emptyWorkspacePath)) throw new Error(`empty workspace path must be absolute, got \`${emptyWorkspacePath}\`; pass a path under Margin's application support directory`);
  return { cwd: emptyWorkspacePath, sandbox: "read-only", approvalPolicy: "never", developerInstructions: MARGIN_INSTRUCTIONS, config: { ...SHELL_TOOL_DISABLE, mcp_servers: mcpServers }, serviceName: "margin" };
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
  private threadDefaultsValue: ThreadDefaults | null = null;
  private readonly emptyWorkspacePath: string;
  private readonly resumable = new Set<ThreadId>();
  private readonly turns = new Map<TurnId, ThreadId>();
  private readonly faultHandlers = new Set<(info: StartupErrorInfo) => void>();
  private readonly models = new Map<ThreadId, string>();
  private readonly forkParents = new Map<string, string | null>();

  constructor(options: CodexClientOptions) {
    this.connection = options.connection;
    this.appVersion = options.appVersion;
    this.openExternal = options.openExternal;
    this.log = options.log;
    this.emptyWorkspacePath = options.emptyWorkspacePath;
    createThreadDefaults(options.emptyWorkspacePath); // fails at construction when the path is not absolute
    this.connection.onNotification((notification) => this.trackTurns(notification));
  }

  /** Turns that started and have not completed; a crash fails exactly these. */
  activeTurns(): Array<ActiveTurn> {
    return [...this.turns].map(([turnId, threadId]) => ({ threadId, turnId }));
  }

  /**
   * Threads that have run a turn. Measured on codex-cli 0.146.0: `thread/resume` of a thread that never ran a turn fails
   * with "no rollout found", so only these can be resumed by a restarted app-server. A thread without a turn is lost
   * on a crash; sending to it then fails with a server error.
   */
  resumableThreads(): Array<ThreadId> {
    return [...this.resumable];
  }

  private trackTurns(notification: ServerNotification): void {
    if (notification.method === "turn/started") this.turns.set(asTurnId(notification.params.turn.id), asThreadId(notification.params.threadId));
    if (notification.method === "turn/completed") this.turns.delete(asTurnId(notification.params.turn.id));
  }

  /** Sends `initialize`, then `initialized` only after the response, then reads the user's config to find MCP servers to disable. */
  async initialize(): Promise<InitializeResponse> {
    const response = await this.connection.request("initialize", {
      clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: this.appVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.connection.notify("initialized");
    const { config } = await this.connection.request("config/read", { includeLayers: false });
    this.threadDefaultsValue = createThreadDefaults(this.emptyWorkspacePath, buildMcpDisableConfig(config));
    return response;
  }

  /** The defaults of every thread; they exist only after initialize has read which MCP servers the user configured. */
  private get threadDefaults(): ThreadDefaults {
    if (this.threadDefaultsValue === null) throw new Error("call initialize() before starting a thread so every MCP server can be disabled");
    return this.threadDefaultsValue;
  }

  /** Returns the id of the model `model/list` marks as default; a thread must always name its model. */
  async defaultModelId(): Promise<string> {
    const { data } = await this.connection.request("model/list", {});
    const found = data.find((model) => model.isDefault);
    if (found === undefined) throw new Error("model/list marks no default model; choose a model explicitly or sign in to an account that has one");
    return found.id;
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

  /** Receives problems that cannot be tied to a request, such as an account mode Margin cannot show; the window shows them in full. */
  onFault(handler: (info: StartupErrorInfo) => void): Unsubscribe {
    this.faultHandlers.add(handler);
    return () => {
      this.faultHandlers.delete(handler);
    };
  }

  private fault(error: unknown, fix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const handler of this.faultHandlers) handler({ kind: "codex-protocol", message, fix });
  }

  onAccountEvent(handler: (event: AuthEvent) => void): Unsubscribe {
    return this.connection.onNotification((notification) => {
      let event: AuthEvent | null;
      try {
        event = toAccountEvent(notification);
      } catch (error) {
        this.fault(error, UNSUPPORTED_ACCOUNT_FIX);
        return;
      }
      if (event !== null) handler(event);
    });
  }

  async startThread(options: Readonly<{ model: string }>): Promise<ThreadId> {
    requireText(options.model, "model");
    const { thread } = await this.connection.request("thread/start", { model: options.model, ...this.threadDefaults });
    this.models.set(asThreadId(thread.id), options.model);
    return asThreadId(thread.id);
  }

  /** The model is explicit on every thread, resumed ones included, because a missing model falls back to the user's config default, which can be rate limited. */
  async resumeThread(threadId: ThreadId, model: string): Promise<void> {
    requireText(model, "model");
    await this.connection.request("thread/resume", { threadId, model, ...this.threadDefaults });
    this.models.set(threadId, model);
    this.resumable.add(threadId);
  }

  /** The model this client last gave `threadId`; a restarted session resumes the thread with it. */
  modelOf(threadId: ThreadId): string {
    const model = this.models.get(threadId);
    if (model === undefined) throw new Error(`no model is recorded for thread ${threadId}; start, fork or resume the thread through this client first`);
    return model;
  }

  /**
   * Forks `threadId` through `lastTurnId` (all turns when null) into a new thread with Margin's defaults. The model is
   * explicit because a fork without one uses the user's config default (measured on codex-cli 0.146.0), which can be rate limited.
   */
  async forkThread(threadId: ThreadId, lastTurnId: TurnId | null, model: string): Promise<ThreadId> {
    requireText(model, "model");
    const { thread } = await this.connection.request("thread/fork", { threadId, lastTurnId, model, ...this.threadDefaults });
    this.models.set(asThreadId(thread.id), model);
    return asThreadId(thread.id);
  }

  /**
   * Lists the threads that use Margin's empty workspace, which are the threads Margin created. `thread/list` leaves
   * `forkedFromId` null (measured on codex-cli 0.146.0), so it is filled from `thread/read`, once per thread: a fork's
   * parent never changes.
   */
  async listThreads(): Promise<Array<Thread>> {
    const listed: Array<Thread> = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_LIST_PAGES) throw new Error(`thread/list returned more than ${MAX_LIST_PAGES} pages; the app-server did not end the list, so update Codex or Margin`);
      const response: ThreadListResponse = await this.connection.request("thread/list", cursor === null ? { cwd: this.emptyWorkspacePath } : { cwd: this.emptyWorkspacePath, cursor });
      listed.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return Promise.all(listed.map(async (thread) => ({ ...thread, forkedFromId: await this.forkParentOf(thread) })));
  }

  private async forkParentOf(thread: Thread): Promise<string | null> {
    const known = this.forkParents.get(thread.id);
    if (known !== undefined) return known;
    const { thread: read } = await this.connection.request("thread/read", { threadId: thread.id, includeTurns: false });
    this.forkParents.set(thread.id, read.forkedFromId);
    return read.forkedFromId;
  }

  async readThread(threadId: ThreadId): Promise<Thread> {
    const { thread } = await this.connection.request("thread/read", { threadId, includeTurns: true });
    return thread;
  }

  /** Sends the context and the question as two text items; the context item ends with a blank line so they do not run together. */
  async startTurn(threadId: ThreadId, input: Readonly<{ question: string; context: RenderedContext | null }>): Promise<TurnId> {
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

  /** A `turn/completed` that cannot be mapped fails that turn with the reason, so the window never waits for it. */
  onProviderEvent(handler: (event: ProviderEvent) => void): Unsubscribe {
    return this.connection.onNotification((notification) => {
      let event: ProviderEvent | null;
      try {
        event = toProviderEvent(notification);
      } catch (error) {
        if (notification.method !== "turn/completed") throw error;
        const message = error instanceof Error ? error.message : String(error);
        event = { type: "completed", threadId: asThreadId(notification.params.threadId), turnId: asTurnId(notification.params.turn.id), status: "failed", error: message };
      }
      if (event !== null) handler(event);
    });
  }
}
