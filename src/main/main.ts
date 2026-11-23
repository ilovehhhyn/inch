// Starts the Electron app and opens the single Margin window.
import { app, BrowserWindow } from "electron";
import { join } from "node:path";

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

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  app.quit();
});
