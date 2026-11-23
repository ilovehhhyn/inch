// Starts the app-server child, builds the client and initializes it, so a session exists only when it is usable.
import { startCodexProcess, type CodexProcess, type SpawnFunction } from "../codex/codex-process";
import { CodexClient } from "../codex/codex-client";
import { answerServerRequest } from "../codex/server-requests";
import type { Logger } from "../shared/log";
import { StartupError } from "../shared/startup-error";

const RESTART_FIX = "Restart Margin";

export type CodexSession = Readonly<{ client: CodexClient; process: CodexProcess }>;

export type StartCodexSessionOptions = Readonly<{
  codexPath: string;
  env: Readonly<Record<string, string>>;
  appVersion: string;
  openExternal: (url: string) => Promise<void>;
  log: Logger;
  emptyWorkspacePath: string;
  spawn?: SpawnFunction;
  requestTimeoutMs?: number;
}>;

export async function startCodexSession(options: StartCodexSessionOptions): Promise<CodexSession> {
  const process = startCodexProcess({
    codexPath: options.codexPath,
    env: options.env,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  process.connection.onServerRequest((request) => Promise.resolve(answerServerRequest(request, options.log)));
  const client = new CodexClient({ connection: process.connection, appVersion: options.appVersion, openExternal: options.openExternal, log: options.log, emptyWorkspacePath: options.emptyWorkspacePath });
  try {
    await client.initialize();
  } catch (error) {
    await process.stop();
    const exit = await process.exited;
    const cause = error instanceof Error ? error.message : String(error);
    const stderr = exit.stderrTail.trim();
    const detail = stderr === "" ? cause : `${cause}; ${stderr}`;
    throw new StartupError({ kind: "codex-crashed", message: `Codex stopped during start-up: ${detail}`, fix: RESTART_FIX });
  }
  return { client, process };
}
