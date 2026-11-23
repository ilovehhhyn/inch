// Gives the sandboxed renderer the typed MarginApi and nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AuthEvent } from "../shared/auth";
import type { ProviderEvent } from "../shared/provider-events";
import { IPC_CHANNELS, type MarginApi } from "../shared/ipc-contract";

const api: MarginApi = {
  startupStatus: () => ipcRenderer.invoke(IPC_CHANNELS.startupStatus),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  authRead: () => ipcRenderer.invoke(IPC_CHANNELS.authRead),
  authStart: (kind) => ipcRenderer.invoke(IPC_CHANNELS.authStart, kind),
  authApiKey: (apiKey) => ipcRenderer.invoke(IPC_CHANNELS.authApiKey, apiKey),
  authCancel: (loginId) => ipcRenderer.invoke(IPC_CHANNELS.authCancel, loginId),
  authLogout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
  threadStart: () => ipcRenderer.invoke(IPC_CHANNELS.threadStart),
  threadOpen: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.threadOpen, threadId),
  threadList: () => ipcRenderer.invoke(IPC_CHANNELS.threadList),
  turnStart: (threadId, question, contextText) => ipcRenderer.invoke(IPC_CHANNELS.turnStart, threadId, question, contextText),
  turnInterrupt: (threadId, turnId) => ipcRenderer.invoke(IPC_CHANNELS.turnInterrupt, threadId, turnId),
  onProviderEvent: (handler) => {
    const listener = (_event: IpcRendererEvent, providerEvent: ProviderEvent): void => handler(providerEvent);
    ipcRenderer.on(IPC_CHANNELS.providerEvent, listener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.providerEvent, listener);
    };
  },
  onAuthChanged: (handler) => {
    const listener = (_event: IpcRendererEvent, authEvent: AuthEvent): void => handler(authEvent);
    ipcRenderer.on(IPC_CHANNELS.authChanged, listener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.authChanged, listener);
    };
  },
};

contextBridge.exposeInMainWorld("margin", api);
