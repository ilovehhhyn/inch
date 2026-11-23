// Registers the main-process handlers behind the IPC channels in the contract and checks every argument.
import { clipboard, ipcMain } from "electron";

import { parseLoginKind, type LoginKind, type LoginStarted } from "../shared/auth";
import type { ProviderAccount } from "../shared/chat-provider";
import type { ScreenContext } from "../shared/context-format";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import { parseLayout, type Layout } from "../shared/layout";
import type { ModelChoice, ModelOption } from "../shared/models";
import { parseProviderId, type ProviderId } from "../shared/provider-id";
import { asThreadId, asTurnId, type ThreadId, type TurnId } from "../shared/provider-events";
import type { DisplayMessage, ThreadSummary } from "../shared/thread-history";

import type { AttachmentChip } from "../shared/attachment";
import { parseAttachmentFile, parseAttachmentIds, parseModelChoice, parseScreenContext } from "./ipc-arguments";

export type IpcHandlers = Readonly<{
  startupStatus: () => Promise<StartupStatus>;
  codexRetry: () => Promise<StartupStatus>;
  accountRead: (provider: ProviderId) => Promise<ProviderAccount>;
  authStart: (kind: LoginKind) => Promise<LoginStarted>;
  authApiKey: (apiKey: string) => Promise<void>;
  authCancel: (loginId: string) => Promise<void>;
  authLogout: () => Promise<void>;
  claudeSignInConsole: () => Promise<void>;
  claudeSignInApiKey: (apiKey: string) => Promise<void>;
  claudeSignOut: () => Promise<void>;
  modelsList: (provider: ProviderId) => Promise<ReadonlyArray<ModelOption>>;
  choiceRead: (threadId: ThreadId) => Promise<ModelChoice | null>;
  speechTranscribe: (wav: Uint8Array) => Promise<string>;
  microphoneRequest: () => Promise<boolean>;
  attachmentAdd: (file: Readonly<{ name: string; bytes: Uint8Array }>) => Promise<AttachmentChip>;
  attachmentDiscard: (id: string) => Promise<void>;
  threadStart: (provider: ProviderId) => Promise<ThreadId>;
  threadOpen: (provider: ProviderId, threadId: ThreadId) => Promise<ReadonlyArray<DisplayMessage>>;
  threadList: () => Promise<ReadonlyArray<ThreadSummary>>;
  threadFork: (provider: ProviderId, threadId: ThreadId, lastTurnId: TurnId) => Promise<ThreadId>;
  chooseDiffFolder: () => Promise<string | null>;
  diffRead: (folder: string) => Promise<string>;
  layoutRead: () => Promise<Layout>;
  layoutWrite: (layout: Layout) => Promise<void>;
  turnStart: (provider: ProviderId, threadId: ThreadId, question: string, context: ScreenContext | null, choice: ModelChoice, attachmentIds: ReadonlyArray<string>) => Promise<TurnId>;
  turnInterrupt: (provider: ProviderId, threadId: ThreadId, turnId: TurnId) => Promise<void>;
  metricsAppend: (record: unknown) => Promise<void>;
}>;

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string, got ${typeof value}`);
  return value;
}

export function registerIpc(handlers: IpcHandlers): void {
  ipcMain.handle(IPC_CHANNELS.startupStatus, () => handlers.startupStatus());
  ipcMain.handle(IPC_CHANNELS.codexRetry, () => handlers.codexRetry());
  ipcMain.handle(IPC_CHANNELS.copyText, (_event, text: unknown) => {
    clipboard.writeText(requireString(text, "text"));
  });
  ipcMain.handle(IPC_CHANNELS.accountRead, (_event, provider: unknown) => handlers.accountRead(parseProviderId(provider)));
  ipcMain.handle(IPC_CHANNELS.authStart, (_event, kind: unknown) => handlers.authStart(parseLoginKind(kind)));
  ipcMain.handle(IPC_CHANNELS.authApiKey, (_event, apiKey: unknown) => handlers.authApiKey(requireString(apiKey, "apiKey")));
  ipcMain.handle(IPC_CHANNELS.authCancel, (_event, loginId: unknown) => handlers.authCancel(requireString(loginId, "loginId")));
  ipcMain.handle(IPC_CHANNELS.authLogout, () => handlers.authLogout());
  ipcMain.handle(IPC_CHANNELS.claudeSignInConsole, () => handlers.claudeSignInConsole());
  ipcMain.handle(IPC_CHANNELS.claudeSignInApiKey, (_event, apiKey: unknown) => handlers.claudeSignInApiKey(requireString(apiKey, "apiKey")));
  ipcMain.handle(IPC_CHANNELS.claudeSignOut, () => handlers.claudeSignOut());
  ipcMain.handle(IPC_CHANNELS.modelsList, (_event, provider: unknown) => handlers.modelsList(parseProviderId(provider)));
  ipcMain.handle(IPC_CHANNELS.choiceRead, (_event, threadId: unknown) => handlers.choiceRead(asThreadId(requireString(threadId, "threadId"))));
  ipcMain.handle(IPC_CHANNELS.speechTranscribe, (_event, wav: unknown) => {
    if (!(wav instanceof Uint8Array)) throw new Error("audio must be a Uint8Array; the window records it before sending");
    return handlers.speechTranscribe(wav);
  });
  ipcMain.handle(IPC_CHANNELS.microphoneRequest, () => handlers.microphoneRequest());
  ipcMain.handle(IPC_CHANNELS.attachmentAdd, (_event, name: unknown, bytes: unknown) => handlers.attachmentAdd(parseAttachmentFile(name, bytes)));
  ipcMain.handle(IPC_CHANNELS.attachmentDiscard, (_event, id: unknown) => handlers.attachmentDiscard(requireString(id, "id")));
  ipcMain.handle(IPC_CHANNELS.threadStart, (_event, provider: unknown) => handlers.threadStart(parseProviderId(provider)));
  ipcMain.handle(IPC_CHANNELS.threadOpen, (_event, provider: unknown, threadId: unknown) => handlers.threadOpen(parseProviderId(provider), asThreadId(requireString(threadId, "threadId"))));
  ipcMain.handle(IPC_CHANNELS.threadList, () => handlers.threadList());
  ipcMain.handle(IPC_CHANNELS.threadFork, (_event, provider: unknown, threadId: unknown, lastTurnId: unknown) =>
    handlers.threadFork(parseProviderId(provider), asThreadId(requireString(threadId, "threadId")), asTurnId(requireString(lastTurnId, "lastTurnId"))),
  );
  ipcMain.handle(IPC_CHANNELS.chooseDiffFolder, () => handlers.chooseDiffFolder());
  ipcMain.handle(IPC_CHANNELS.diffRead, (_event, folder: unknown) => handlers.diffRead(requireString(folder, "folder")));
  ipcMain.handle(IPC_CHANNELS.layoutRead, () => handlers.layoutRead());
  ipcMain.handle(IPC_CHANNELS.layoutWrite, (_event, layout: unknown) => handlers.layoutWrite(parseLayout(layout, "sent by the window")));
  ipcMain.handle(IPC_CHANNELS.turnStart, (_event, provider: unknown, threadId: unknown, question: unknown, contextText: unknown, choice: unknown, attachmentIds: unknown) =>
    handlers.turnStart(parseProviderId(provider), asThreadId(requireString(threadId, "threadId")), requireString(question, "question"), parseScreenContext(contextText), parseModelChoice(choice), parseAttachmentIds(attachmentIds)),
  );
  ipcMain.handle(IPC_CHANNELS.metricsAppend, (_event, record: unknown) => handlers.metricsAppend(record));
  ipcMain.handle(IPC_CHANNELS.turnInterrupt, (_event, provider: unknown, threadId: unknown, turnId: unknown) =>
    handlers.turnInterrupt(parseProviderId(provider), asThreadId(requireString(threadId, "threadId")), asTurnId(requireString(turnId, "turnId"))),
  );
}
