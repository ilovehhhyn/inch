// Gives the sandboxed renderer the typed MarginApi and nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AuthEvent } from "../shared/auth";
import { IPC_CHANNELS, type MarginApi } from "../shared/ipc-contract";

const api: MarginApi = {
  startupStatus: () => ipcRenderer.invoke(IPC_CHANNELS.startupStatus),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  authRead: () => ipcRenderer.invoke(IPC_CHANNELS.authRead),
  authStart: (kind) => ipcRenderer.invoke(IPC_CHANNELS.authStart, kind),
  authApiKey: (apiKey) => ipcRenderer.invoke(IPC_CHANNELS.authApiKey, apiKey),
  authCancel: (loginId) => ipcRenderer.invoke(IPC_CHANNELS.authCancel, loginId),
  authLogout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
  onAuthChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, authEvent: AuthEvent): void => handler(authEvent);
    ipcRenderer.on(IPC_CHANNELS.authChanged, listener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.authChanged, listener);
    };
  },
};

contextBridge.exposeInMainWorld("margin", api);
