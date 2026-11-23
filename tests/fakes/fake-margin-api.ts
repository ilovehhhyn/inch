// A hand-written MarginApi for renderer tests: scripted answers, recorded calls and an emitter for auth events.
import type { AccountSummary, AuthEvent, LoginKind, LoginStarted } from "../../src/shared/auth";
import type { MarginApi, StartupStatus } from "../../src/shared/ipc-contract";

export const SIGNED_IN_CHATGPT: AccountSummary = { signedIn: true, accountType: "chatgpt", planType: "plus" };

export class FakeMarginApi implements MarginApi {
  account: AccountSummary = SIGNED_IN_CHATGPT;
  startup: StartupStatus = { ok: true, codexVersion: "0.146.0" };
  loginStarted: LoginStarted = { kind: "chatgpt", loginId: "login-1" };
  readonly calls: Array<string> = [];
  readonly apiKeys: Array<string> = [];
  private readonly handlers = new Set<(event: AuthEvent) => void>();

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

  emit(event: AuthEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
