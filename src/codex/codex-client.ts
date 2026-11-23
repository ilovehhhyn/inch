// Gives typed methods over the app-server connection: initialize, account and sign-in.
import type { AccountSummary, AccountType, AuthEvent, LoginKind, LoginStarted } from "../shared/auth";
import type { Logger } from "../shared/log";
import type { ServerNotification } from "./generated/ServerNotification";
import type { AccountLoginCompletedNotification } from "./generated/v2/AccountLoginCompletedNotification";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { RpcConnection } from "./rpc-connection";
import type { Unsubscribe } from "./rpc-types";

const CLIENT_NAME = "margin";
const CLIENT_TITLE = "Margin";
const UNSUPPORTED_ACCOUNT_FIX = "sign out of Codex and sign in with ChatGPT or an OpenAI API key";

export type CodexClientOptions = Readonly<{
  connection: RpcConnection;
  appVersion: string;
  openExternal: (url: string) => Promise<void>;
  log: Logger;
}>;

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

export class CodexClient {
  private readonly connection: RpcConnection;
  private readonly appVersion: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly log: Logger;

  constructor(options: CodexClientOptions) {
    this.connection = options.connection;
    this.appVersion = options.appVersion;
    this.openExternal = options.openExternal;
    this.log = options.log;
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
}
