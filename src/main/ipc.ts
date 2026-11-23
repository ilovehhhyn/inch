// Registers the main-process handlers behind the IPC channels in the contract.
import { clipboard, ipcMain } from "electron";

import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";

export type IpcHandlers = Readonly<{ startupStatus: () => Promise<StartupStatus> }>;

export function registerIpc(handlers: IpcHandlers): void {
  ipcMain.handle(IPC_CHANNELS.startupStatus, () => handlers.startupStatus());
  ipcMain.handle(IPC_CHANNELS.copyText, (_event, text: unknown) => {
    if (typeof text !== "string") throw new Error(`copyText requires a string, got ${typeof text}`);
    clipboard.writeText(text);
  });
}
