// Gives the sandboxed renderer the typed MarginApi and nothing else.
import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS, type MarginApi } from "../shared/ipc-contract";

const api: MarginApi = {
  startupStatus: () => ipcRenderer.invoke(IPC_CHANNELS.startupStatus),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
};

contextBridge.exposeInMainWorld("margin", api);
