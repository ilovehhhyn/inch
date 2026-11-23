// Gives the sandboxed renderer the typed MarginApi and nothing else.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { AuthEvent } from "../shared/auth";
import type { StartupErrorInfo } from "../shared/startup-error";
import type { ProviderEvent } from "../shared/provider-events";
import { IPC_CHANNELS, type MarginApi } from "../shared/ipc-contract";

const api: MarginApi = {
  startupStatus: () => ipcRenderer.invoke(IPC_CHANNELS.startupStatus),
  codexRetry: () => ipcRenderer.invoke(IPC_CHANNELS.codexRetry),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  accountRead: (provider) => ipcRenderer.invoke(IPC_CHANNELS.accountRead, provider),
  authStart: (kind) => ipcRenderer.invoke(IPC_CHANNELS.authStart, kind),
  authApiKey: (apiKey) => ipcRenderer.invoke(IPC_CHANNELS.authApiKey, apiKey),
  authCancel: (loginId) => ipcRenderer.invoke(IPC_CHANNELS.authCancel, loginId),
  authLogout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
  modelsList: (provider) => ipcRenderer.invoke(IPC_CHANNELS.modelsList, provider),
  choiceRead: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.choiceRead, threadId),
  speechTranscribe: (wav) => ipcRenderer.invoke(IPC_CHANNELS.speechTranscribe, wav),
  microphoneRequest: () => ipcRenderer.invoke(IPC_CHANNELS.microphoneRequest),
  attachmentAdd: (name, bytes) => ipcRenderer.invoke(IPC_CHANNELS.attachmentAdd, name, bytes),
  attachmentDiscard: (id) => ipcRenderer.invoke(IPC_CHANNELS.attachmentDiscard, id),
  threadStart: (provider) => ipcRenderer.invoke(IPC_CHANNELS.threadStart, provider),
  threadOpen: (provider, threadId) => ipcRenderer.invoke(IPC_CHANNELS.threadOpen, provider, threadId),
  threadList: () => ipcRenderer.invoke(IPC_CHANNELS.threadList),
  threadFork: (provider, threadId, lastTurnId) => ipcRenderer.invoke(IPC_CHANNELS.threadFork, provider, threadId, lastTurnId),
  chooseDiffFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDiffFolder),
  diffRead: (folder) => ipcRenderer.invoke(IPC_CHANNELS.diffRead, folder),
  layoutRead: () => ipcRenderer.invoke(IPC_CHANNELS.layoutRead),
  layoutWrite: (layout) => ipcRenderer.invoke(IPC_CHANNELS.layoutWrite, layout),
  turnStart: (provider, threadId, question, contextText, choice, attachmentIds) => ipcRenderer.invoke(IPC_CHANNELS.turnStart, provider, threadId, question, contextText, choice, attachmentIds),
  turnInterrupt: (provider, threadId, turnId) => ipcRenderer.invoke(IPC_CHANNELS.turnInterrupt, provider, threadId, turnId),
  metricsAppend: (record) => ipcRenderer.invoke(IPC_CHANNELS.metricsAppend, record),
  claudeSignInConsole: () => ipcRenderer.invoke(IPC_CHANNELS.claudeSignInConsole),
  claudeSignInApiKey: (apiKey) => ipcRenderer.invoke(IPC_CHANNELS.claudeSignInApiKey, apiKey),
  claudeSignOut: () => ipcRenderer.invoke(IPC_CHANNELS.claudeSignOut),
  onFault: (handler) => {
    const listener = (_event: IpcRendererEvent, info: StartupErrorInfo): void => handler(info);
    ipcRenderer.on(IPC_CHANNELS.fault, listener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.fault, listener);
    };
  },
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
