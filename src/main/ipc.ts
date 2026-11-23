// Registers the main-process handlers behind the IPC channels in the contract and checks every argument.
import { clipboard, ipcMain } from "electron";

import { parseLoginKind, type AccountSummary, type LoginKind, type LoginStarted } from "../shared/auth";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import { parseLayout, type Layout } from "../shared/layout";
import { asThreadId, asTurnId, type ThreadId, type TurnId } from "../shared/provider-events";
import type { HistoryMessage, ThreadSummary } from "../shared/thread-history";

import { parseContextText } from "./ipc-arguments";

export type IpcHandlers = Readonly<{
  startupStatus: () => Promise<StartupStatus>;
  authRead: () => Promise<AccountSummary>;
  authStart: (kind: LoginKind) => Promise<LoginStarted>;
  authApiKey: (apiKey: string) => Promise<void>;
  authCancel: (loginId: string) => Promise<void>;
  authLogout: () => Promise<void>;
  threadStart: () => Promise<ThreadId>;
  threadOpen: (threadId: ThreadId) => Promise<ReadonlyArray<HistoryMessage>>;
  threadList: () => Promise<ReadonlyArray<ThreadSummary>>;
  threadFork: (threadId: ThreadId, lastTurnId: TurnId) => Promise<ThreadId>;
  chooseDiffFolder: () => Promise<string | null>;
  diffRead: (folder: string) => Promise<string>;
  layoutRead: () => Promise<Layout>;
  layoutWrite: (layout: Layout) => Promise<void>;
  turnStart: (threadId: ThreadId, question: string, contextText: string | null) => Promise<TurnId>;
  turnInterrupt: (threadId: ThreadId, turnId: TurnId) => Promise<void>;
  metricsAppend: (record: unknown) => Promise<void>;
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
  ipcMain.handle(IPC_CHANNELS.threadStart, () => handlers.threadStart());
  ipcMain.handle(IPC_CHANNELS.threadOpen, (_event, threadId: unknown) => handlers.threadOpen(asThreadId(requireString(threadId, "threadId"))));
  ipcMain.handle(IPC_CHANNELS.threadList, () => handlers.threadList());
  ipcMain.handle(IPC_CHANNELS.threadFork, (_event, threadId: unknown, lastTurnId: unknown) =>
    handlers.threadFork(asThreadId(requireString(threadId, "threadId")), asTurnId(requireString(lastTurnId, "lastTurnId"))),
  );
  ipcMain.handle(IPC_CHANNELS.chooseDiffFolder, () => handlers.chooseDiffFolder());
  ipcMain.handle(IPC_CHANNELS.diffRead, (_event, folder: unknown) => handlers.diffRead(requireString(folder, "folder")));
  ipcMain.handle(IPC_CHANNELS.layoutRead, () => handlers.layoutRead());
  ipcMain.handle(IPC_CHANNELS.layoutWrite, (_event, layout: unknown) => handlers.layoutWrite(parseLayout(layout, "sent by the window")));
  ipcMain.handle(IPC_CHANNELS.turnStart, (_event, threadId: unknown, question: unknown, contextText: unknown) =>
    handlers.turnStart(asThreadId(requireString(threadId, "threadId")), requireString(question, "question"), parseContextText(contextText)),
  );
  ipcMain.handle(IPC_CHANNELS.metricsAppend, (_event, record: unknown) => handlers.metricsAppend(record));
  ipcMain.handle(IPC_CHANNELS.turnInterrupt, (_event, threadId: unknown, turnId: unknown) =>
    handlers.turnInterrupt(asThreadId(requireString(threadId, "threadId")), asTurnId(requireString(turnId, "turnId"))),
  );
}
