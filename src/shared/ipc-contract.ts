// Names the IPC channels and the API object the preload script gives the renderer; the one place both sides agree.
import type { AccountSummary, AuthEvent, LoginKind, LoginStarted } from "./auth";
import type { StartupErrorInfo } from "./startup-error";

export const IPC_CHANNELS = {
  startupStatus: "startup:status",
  copyText: "clipboard:copy",
  authRead: "auth:read",
  authStart: "auth:start",
  authApiKey: "auth:apiKey",
  authCancel: "auth:cancel",
  authLogout: "auth:logout",
  authChanged: "auth:changed",
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
}>;
