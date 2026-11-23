// Starts the Electron app: checks Codex, starts one app-server session and opens the single Margin window.
import { app, BrowserWindow, dialog, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { summarizeAccount } from "../codex/codex-client";
import { listChats, summarizeThread, toHistory } from "../codex/thread-history";
import { CodexSupervisor } from "../codex/codex-supervisor";
import type { AuthEvent } from "../shared/auth";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import type { ProviderEvent } from "../shared/provider-events";
import { StartupError } from "../shared/startup-error";
import { buildCodexEnvironment } from "./codex-environment";
import { locateCodex } from "./codex-locator";
import { startCodexSession } from "./codex-session";
import { runGitDiff } from "./git-diff";
import { registerIpc } from "./ipc";
import { readLayout, writeLayout } from "./layout-store";

const WINDOW_WIDTH_PX = 1280;
const WINDOW_HEIGHT_PX = 800;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH_PX,
    height: WINDOW_HEIGHT_PX,
    webPreferences: { preload: join(import.meta.dirname, "../preload/preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // Links in answers must never navigate the window away from Margin.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
}

function log(line: string): void {
  console.log(`[margin] ${line}`);
}

function sendToWindows(event: AuthEvent): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.authChanged, event);
}

function sendProviderEvent(event: ProviderEvent): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.providerEvent, event);
}

type StartedCodex = Readonly<{ supervisor: CodexSupervisor; codexVersion: string }>;

/** Margin's own empty directory: every thread uses it as `cwd`, so Codex has nothing of the user's to read. */
async function createEmptyWorkspace(): Promise<string> {
  const path = join(app.getPath("userData"), "empty-workspace");
  await mkdir(path, { recursive: true });
  return path;
}

function layoutPath(): string {
  return join(app.getPath("userData"), "layout.json");
}

async function startCodex(): Promise<StartedCodex> {
  const located = await locateCodex();
  const emptyWorkspacePath = await createEmptyWorkspace();
  const env = buildCodexEnvironment(process.env, located.loginShellPath);
  const supervisor = new CodexSupervisor({
    startSession: () => startCodexSession({ codexPath: located.codexPath, env, appVersion: app.getVersion(), openExternal: (url) => shell.openExternal(url), log, emptyWorkspacePath }),
    onSessionStart: (client) => {
      client.onAccountEvent(sendToWindows);
      client.onLoginCompleted((event) => sendToWindows({ type: "loginCompleted", success: event.success, error: event.error }));
    },
    onEvent: sendProviderEvent,
    onRestartFailed: (error) => log(`codex restart failed: ${error.message}`),
    log,
  });
  await supervisor.start();
  return { supervisor, codexVersion: located.version };
}

function registerHandlers(starting: Promise<StartedCodex>): void {
  registerIpc({
    startupStatus: async (): Promise<StartupStatus> => {
      try {
        return { ok: true, codexVersion: (await starting).codexVersion };
      } catch (error) {
        if (error instanceof StartupError) return { ok: false, error: error.info };
        throw error;
      }
    },
    authRead: async () => summarizeAccount(await (await starting).supervisor.client.readAccount()),
    authStart: async (kind) => (await starting).supervisor.client.startLogin(kind),
    authApiKey: async (apiKey) => (await starting).supervisor.client.startApiKeyLogin(apiKey),
    authCancel: async (loginId) => (await starting).supervisor.client.cancelLogin(loginId),
    authLogout: async () => (await starting).supervisor.client.logout(),
    threadStart: async () => {
      const { client } = (await starting).supervisor;
      return client.startThread({ model: await client.defaultModelId() });
    },
    threadOpen: async (threadId) => {
      const { client } = (await starting).supervisor;
      await client.resumeThread(threadId, await client.defaultModelId());
      return toHistory(await client.readThread(threadId));
    },
    threadList: async () => listChats(await (await starting).supervisor.client.listThreads()).map(summarizeThread),
    threadFork: async (threadId, lastTurnId) => {
      const { client } = (await starting).supervisor;
      return client.forkThread(threadId, lastTurnId, await client.defaultModelId());
    },
    chooseDiffFolder: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { title: "Choose a folder for the code diff", properties: ["openDirectory" as const] };
      const result = await (window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options));
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    diffRead: (folder) => runGitDiff({ folder, base: "HEAD" }),
    layoutRead: () => readLayout(layoutPath()),
    layoutWrite: (layout) => writeLayout(layoutPath(), layout),
    turnStart: async (threadId, question, contextText) => (await starting).supervisor.client.startTurn(threadId, { question, context: contextText === null ? null : { text: contextText } }),
    turnInterrupt: async (threadId, turnId) => (await starting).supervisor.client.interruptTurn(threadId, turnId),
  });
}

let starting: Promise<StartedCodex> | undefined;

void app.whenReady().then(() => {
  const started = startCodex();
  starting = started;
  started.catch(() => undefined); // not silent: startupStatus reports the failure to the window
  registerHandlers(started);
  createWindow();
});
app.on("will-quit", () => {
  void starting?.then(({ supervisor }) => supervisor.stop(), () => undefined); // a failed start has no child to stop
});
app.on("window-all-closed", () => {
  app.quit();
});
