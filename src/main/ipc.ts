// Registers the main-process handlers behind the IPC channels in the contract and checks every argument.
import { clipboard, ipcMain } from "electron";

import { parseLoginKind, type AccountSummary, type LoginKind, type LoginStarted } from "../shared/auth";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";

export type IpcHandlers = Readonly<{
  startupStatus: () => Promise<StartupStatus>;
  authRead: () => Promise<AccountSummary>;
  authStart: (kind: LoginKind) => Promise<LoginStarted>;
  authApiKey: (apiKey: string) => Promise<void>;
  authCancel: (loginId: string) => Promise<void>;
  authLogout: () => Promise<void>;
}>;

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string, got ${typeof value}`);
  return value;
}

export function registerIpc(handlers: IpcHandlers): void {
  ipcMain.handle(IPC_CHANNELS.startupStatus, () => handlers.startupStatus());
  ipcMain.handle(IPC_CHANNELS.copyText, (_event, text: unknown) => {
    clipboard.writeText(requireString(text, "text"));
  });
  ipcMain.handle(IPC_CHANNELS.authRead, () => handlers.authRead());
  ipcMain.handle(IPC_CHANNELS.authStart, (_event, kind: unknown) => handlers.authStart(parseLoginKind(kind)));
  ipcMain.handle(IPC_CHANNELS.authApiKey, (_event, apiKey: unknown) => handlers.authApiKey(requireString(apiKey, "apiKey")));
  ipcMain.handle(IPC_CHANNELS.authCancel, (_event, loginId: unknown) => handlers.authCancel(requireString(loginId, "loginId")));
  ipcMain.handle(IPC_CHANNELS.authLogout, () => handlers.authLogout());
}
