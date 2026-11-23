// Starts the Electron app: checks Codex, starts one app-server session and opens the single Margin window.
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";

import { summarizeAccount } from "../codex/codex-client";
import type { AuthEvent } from "../shared/auth";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import { StartupError } from "../shared/startup-error";
import { buildCodexEnvironment } from "./codex-environment";
import { locateCodex } from "./codex-locator";
import { startCodexSession, type CodexSession } from "./codex-session";
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

type StartedSession = Readonly<{ session: CodexSession; codexVersion: string }>;

async function startSession(): Promise<StartedSession> {
  const located = await locateCodex();
  const session = await startCodexSession({
    codexPath: located.codexPath,
    env: buildCodexEnvironment(process.env, located.loginShellPath),
    appVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    log,
  });
  session.client.onAccountEvent(sendToWindows);
  session.client.onLoginCompleted((event) => sendToWindows({ type: "loginCompleted", success: event.success, error: event.error }));
  return { session, codexVersion: located.version };
}

function registerHandlers(starting: Promise<StartedSession>): void {
  registerIpc({
    startupStatus: async (): Promise<StartupStatus> => {
      try {
        return { ok: true, codexVersion: (await starting).codexVersion };
      } catch (error) {
        if (error instanceof StartupError) return { ok: false, error: error.info };
        throw error;
      }
    },
    authRead: async () => summarizeAccount(await (await starting).session.client.readAccount()),
    authStart: async (kind) => (await starting).session.client.startLogin(kind),
    authApiKey: async (apiKey) => (await starting).session.client.startApiKeyLogin(apiKey),
    authCancel: async (loginId) => (await starting).session.client.cancelLogin(loginId),
    authLogout: async () => (await starting).session.client.logout(),
  });
}

let starting: Promise<StartedSession> | undefined;

void app.whenReady().then(() => {
  const started = startSession();
  starting = started;
  started.catch(() => undefined); // not silent: startupStatus reports the failure to the window
  registerHandlers(started);
  createWindow();
});
app.on("will-quit", () => {
  void starting?.then(({ session }) => session.process.stop(), () => undefined); // a failed start has no child to stop
});
app.on("window-all-closed", () => {
  app.quit();
});
