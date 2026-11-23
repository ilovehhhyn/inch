// Starts the Electron app: checks Codex, starts one app-server session and opens the single Margin window.
import { app, BrowserWindow, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { summarizeAccount } from "../codex/codex-client";
import { CodexSupervisor } from "../codex/codex-supervisor";
import type { AuthEvent } from "../shared/auth";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import { StartupError } from "../shared/startup-error";
import { buildCodexEnvironment } from "./codex-environment";
import { locateCodex } from "./codex-locator";
import { startCodexSession } from "./codex-session";
import { registerIpc } from "./ipc";

const WINDOW_WIDTH_PX = 1280;
const WINDOW_HEIGHT_PX = 800;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH_PX,
    height: WINDOW_HEIGHT_PX,
    webPreferences: { preload: join(import.meta.dirname, "../preload/preload.cjs"), contextIsolation: true, sandbox: true },
  });
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

type StartedCodex = Readonly<{ supervisor: CodexSupervisor; codexVersion: string }>;

/** Margin's own empty directory: every thread uses it as `cwd`, so Codex has nothing of the user's to read. */
async function createEmptyWorkspace(): Promise<string> {
  const path = join(app.getPath("userData"), "empty-workspace");
  await mkdir(path, { recursive: true });
  return path;
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
    onEvent: (event) => log(`provider event ${event.type}`),
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
