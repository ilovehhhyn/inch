// Starts the Electron app and opens the single Margin window.
import { app, BrowserWindow } from "electron";
import { join } from "node:path";

import type { StartupStatus } from "../shared/ipc-contract";
import { StartupError } from "../shared/startup-error";
import { locateCodex } from "./codex-locator";
import { registerIpc } from "./ipc";

const WINDOW_WIDTH_PX = 1280;
const WINDOW_HEIGHT_PX = 800;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH_PX,
    height: WINDOW_HEIGHT_PX,
    webPreferences: { preload: join(import.meta.dirname, "../preload/preload.mjs"), contextIsolation: true, sandbox: true },
  });
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
}

async function checkCodex(): Promise<StartupStatus> {
  try {
    const { version } = await locateCodex();
    return { ok: true, codexVersion: version };
  } catch (error) {
    if (error instanceof StartupError) return { ok: false, error: error.info };
    throw error;
  }
}

void app.whenReady().then(() => {
  registerIpc({ startupStatus: checkCodex });
  createWindow();
});
app.on("window-all-closed", () => {
  app.quit();
});
