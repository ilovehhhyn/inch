// Starts the Electron app: checks Codex, starts one app-server session and opens the single Margin window.
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { buildAntEnvironment, createAntCli, nodeAntExec, type AntCli } from "../claude/ant-cli";
import { createClaudeProvider } from "../claude/claude-provider";
import { createClaudeThreadStore } from "../claude/claude-thread-store";
import { CodexSupervisor } from "../codex/codex-supervisor";
import type { AuthEvent } from "../shared/auth";
import type { ChatProvider } from "../shared/chat-provider";
import { IPC_CHANNELS, type StartupStatus } from "../shared/ipc-contract";
import type { ProviderEvent } from "../shared/provider-events";
import type { ProviderId } from "../shared/provider-id";
import { StartupError, type StartupErrorInfo } from "../shared/startup-error";
import { readClaudeBaseUrl, scrubAnthropicVariables } from "./claude-environment";
import { createClaudeServices, type ClaudeServices } from "./claude-services";
import { buildCodexEnvironment } from "./codex-environment";
import { locateCodex, nodeStartupServices } from "./codex-locator";
import { startCodexSession } from "./codex-session";
import { runGitDiff } from "./git-diff";
import { requireSavedDiffFolder } from "./ipc-arguments";
import { registerIpc } from "./ipc";
import { readLayout, writeLayout } from "./layout-store";
import { clearStagedAttachments, createAttachmentContent, createAttachmentStore } from "./attachments";
import { createChoiceStore } from "./choice-store";
import { createSafeStorageSecretStore } from "./secret-store";
import { appendLatencyRecord } from "./metrics-store";
import { createSupervisedCodexProvider } from "./supervised-codex-provider";

/** Read once, before the variables are removed: the address of a fake Anthropic service in the end-to-end tests. */
const claudeBaseUrl = readClaudeBaseUrl(process.env);
scrubAnthropicVariables(process.env);

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

function sendFault(info: StartupErrorInfo): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.fault, info);
}

function sendProviderEvent(event: ProviderEvent): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.providerEvent, event);
}

type StartedCodex = Readonly<{ supervisor: CodexSupervisor; codexVersion: string }>;

let starting: Promise<StartedCodex> | undefined;

/** The Codex provider: every call goes to the client that is running now, and the supervisor publishes its events. */
const attachmentContent = createAttachmentContent();

const codex = createSupervisedCodexProvider(async () => {
  if (starting === undefined) throw new Error("Codex has not started; wait for the window to finish starting");
  return (await starting).supervisor.ready();
}, attachmentContent);

/** The providers in use; Claude is added once the app is ready, because its key store needs Electron's safeStorage. */
const providers: Partial<Record<ProviderId, ChatProvider>> = { codex: codex.provider };

let claude: ClaudeServices | undefined;

function requireClaude(): ClaudeServices {
  if (claude === undefined) throw new Error("Claude is not ready; wait for the window to finish starting");
  return claude;
}

/** `ant` is found through the login-shell PATH, which a window started from Finder does not have; it is read once, on first use. */
function createLazyAnt(): () => Promise<AntCli> {
  let pending: Promise<AntCli> | undefined;
  return () => {
    pending ??= nodeStartupServices.readLoginShellPath().then((path) => createAntCli({ exec: nodeAntExec, environment: buildAntEnvironment(process.env, path) }));
    return pending;
  };
}

function providerFor(id: ProviderId): ChatProvider {
  const provider = providers[id];
  if (provider === undefined) throw new Error(`provider \`${id}\` is not available in this build; use codex`);
  return provider;
}

/** Margin's own empty directory: every thread uses it as `cwd`, so Codex has nothing of the user's to read. */
async function createEmptyWorkspace(): Promise<string> {
  const path = join(app.getPath("userData"), "empty-workspace");
  await mkdir(path, { recursive: true });
  return path;
}

function metricsPath(): string {
  return join(app.getPath("userData"), "metrics.jsonl");
}

function attachmentsDirectory(): string {
  return join(app.getPath("userData"), "attachments");
}

function choicesPath(): string {
  return join(app.getPath("userData"), "choices.json");
}

function layoutPath(): string {
  return join(app.getPath("userData"), "layout.json");
}

/** Read once at start-up: the end-to-end tests set it to start a scripted stand-in for Codex; an empty value is an error, not "unset". */
function codexPathOverride(): string | undefined {
  const value = process.env["MARGIN_CODEX_PATH"];
  if (value === "") throw new StartupError({ kind: "codex-missing", message: "MARGIN_CODEX_PATH is set but empty; unset it or give the full path", fix: "unset MARGIN_CODEX_PATH" });
  return value;
}

async function startCodex(): Promise<StartedCodex> {
  const located = await locateCodex(nodeStartupServices, codexPathOverride());
  const emptyWorkspacePath = await createEmptyWorkspace();
  const env = buildCodexEnvironment(process.env, located.loginShellPath);
  const supervisor = new CodexSupervisor({
    startSession: () => startCodexSession({ codexPath: located.codexPath, env, appVersion: app.getVersion(), openExternal: (url) => shell.openExternal(url), log, emptyWorkspacePath }),
    onSessionStart: (client) => {
      client.onAccountEvent(sendToWindows);
      client.onFault(sendFault);
      client.onLoginCompleted((event) => sendToWindows({ type: "loginCompleted", success: event.success, error: event.error }));
    },
    onEvent: codex.publish,
    onRestartFailed: (error) => log(`codex restart failed: ${error.message}`),
    log,
  });
  await supervisor.start();
  return { supervisor, codexVersion: located.version };
}

function registerHandlers(started: Promise<StartedCodex>): void {
  const choices = createChoiceStore(choicesPath());
  const attachments = createAttachmentStore({ directory: attachmentsDirectory() });
  /** The running Codex client; a request made during a restart waits for it instead of failing. */
  const readyClient = async () => (await started).supervisor.ready();
  for (const provider of Object.values(providers)) provider.onEvent(sendProviderEvent);
  registerIpc({
    startupStatus: async (): Promise<StartupStatus> => {
      try {
        return { ok: true, codexVersion: (await started).codexVersion };
      } catch (error) {
        if (error instanceof StartupError) return { ok: false, error: error.info };
        throw error;
      }
    },
    accountRead: (provider) => providerFor(provider).readAccount(),
    authStart: async (kind) => (await readyClient()).startLogin(kind),
    authApiKey: async (apiKey) => (await readyClient()).startApiKeyLogin(apiKey),
    authCancel: async (loginId) => (await readyClient()).cancelLogin(loginId),
    authLogout: async () => (await readyClient()).logout(),
    claudeSignInConsole: () => requireClaude().signInConsole(),
    claudeSignInApiKey: (apiKey) => requireClaude().signInApiKey(apiKey),
    claudeSignOut: () => requireClaude().signOut(),
    modelsList: (provider) => providerFor(provider).listModels(),
    choiceRead: (threadId) => choices.read(threadId),
    attachmentAdd: async (file) => {
      const { id, kind, name, bytes } = await attachments.add(file);
      return { id, kind, name, bytes };
    },
    attachmentDiscard: (id) => attachments.discard(id),
    threadStart: (provider) => providerFor(provider).startThread(),
    threadOpen: (provider, threadId) => providerFor(provider).readThread(threadId),
    threadList: async () => (await Promise.all(Object.values(providers).map((provider) => provider.listThreads()))).flat().sort((left, right) => right.updatedAtSec - left.updatedAtSec),
    threadFork: (provider, threadId, lastTurnId) => providerFor(provider).forkThread(threadId, lastTurnId),
    chooseDiffFolder: async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { title: "Choose a folder for the code diff", properties: ["openDirectory" as const] };
      const result = await (window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options));
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    diffRead: async (folder) => runGitDiff({ folder: requireSavedDiffFolder(folder, (await readLayout(layoutPath())).diffFolder), base: "HEAD" }),
    layoutRead: () => readLayout(layoutPath()),
    layoutWrite: (layout) => writeLayout(layoutPath(), layout),
    turnStart: async (provider, threadId, question, context, choice, attachmentIds) => {
      const adopted = await attachments.adopt(threadId, attachmentIds);
      const turnId = await providerFor(provider).startTurn(threadId, { question, context, model: choice.model, reasoning: choice.reasoning, attachments: adopted });
      await choices.write(threadId, choice);
      return turnId;
    },
    turnInterrupt: (provider, threadId, turnId) => providerFor(provider).interruptTurn(threadId, turnId),
    metricsAppend: (record) => appendLatencyRecord(metricsPath(), record),
  });
}

void app.whenReady().then(async () => {
  await clearStagedAttachments(attachmentsDirectory()); // files staged by a session that ended before sending
  claude = createClaudeServices({
    store: createSafeStorageSecretStore({ safeStorage, directory: join(app.getPath("userData"), "secrets") }),
    ant: createLazyAnt(),
    clock: Date.now,
    clientOptions: claudeBaseUrl === undefined ? {} : { baseURL: claudeBaseUrl },
    log,
  });
  providers.claude = createClaudeProvider({
    credentials: claude.credentials,
    store: createClaudeThreadStore(join(app.getPath("userData"), "claude-threads")),
    clientOptions: claude.clientOptions,
    content: attachmentContent,
  });
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
