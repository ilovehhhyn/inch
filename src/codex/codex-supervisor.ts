// Keeps one usable app-server session alive: fails the active turn on a crash, restarts the child and resumes its threads.
import type { Logger } from "../shared/log";
import type { ProviderEvent } from "../shared/provider-events";
import type { CodexClient } from "./codex-client";
import type { CodexProcess } from "./codex-process";

export const CRASH_MESSAGE = "Codex stopped unexpectedly. Retry";

/** A server that dies this often in a minute has a fault a restart will not fix, so Margin reports it instead of looping. */
export const MAX_RESTARTS_PER_WINDOW = 3;
export const RESTART_WINDOW_MS = 60 * 1000;

/** What the supervisor needs from a started session: its client, and the child process to watch and stop. */
export type SupervisedSession = Readonly<{ client: CodexClient; process: Pick<CodexProcess, "exited" | "stop"> }>;

export type CodexSupervisorOptions = Readonly<{
  startSession: () => Promise<SupervisedSession>;
  /** Called with the client of every session, first and restarted, so callers can subscribe to its notifications. */
  onSessionStart?: (client: CodexClient) => void;
  onEvent: (event: ProviderEvent) => void;
  onRestartFailed: (error: Error) => void;
  log: Logger;
  now?: () => number;
  restartWindowMs?: number;
}>;

type State = "stopped" | "running" | "restarting" | "failed";

export class CodexSupervisor {
  private readonly options: CodexSupervisorOptions;
  private readonly now: () => number;
  private readonly restartWindowMs: number;
  private readonly restartTimes: Array<number> = [];
  private state: State = "stopped";
  private session: SupervisedSession | null = null;

  constructor(options: CodexSupervisorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.restartWindowMs = options.restartWindowMs ?? RESTART_WINDOW_MS;
  }

  get client(): CodexClient {
    if (this.state !== "running" || this.session === null) throw new Error("Codex is not running; the app-server has not started or is restarting");
    return this.session.client;
  }

  async start(): Promise<void> {
    this.attach(await this.options.startSession());
    this.state = "running";
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    await this.session?.process.stop();
  }

  private attach(session: SupervisedSession): void {
    this.session = session;
    this.options.onSessionStart?.(session.client);
    session.client.onProviderEvent(this.options.onEvent);
    void session.process.exited.then(() => this.handleExit(session));
  }

  /** Resumes only threads that ran a turn (see CodexClient.resumableThreads); a thread with no turn cannot be resumed. */
  private async handleExit(dead: SupervisedSession): Promise<void> {
    if (this.state !== "running" || this.session !== dead) return;
    this.state = "restarting";
    const threads = dead.client.resumableThreads();
    for (const { threadId, turnId } of dead.client.activeTurns()) {
      this.options.onEvent({ type: "completed", threadId, turnId, status: "failed", error: CRASH_MESSAGE });
    }
    if (this.restartBudgetExhausted()) {
      this.fail(new Error(`Codex restarted ${MAX_RESTARTS_PER_WINDOW} times in ${this.restartWindowMs / 1000} s and stopped again; check \`codex app-server\` in a terminal, then restart Margin`));
      return;
    }
    try {
      const session = await this.options.startSession();
      this.attach(session);
      for (const threadId of threads) await session.client.resumeThread(threadId);
      this.state = "running";
      this.options.log(`restarted codex and resumed ${threads.length} thread(s)`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private restartBudgetExhausted(): boolean {
    const now = this.now();
    while (this.restartTimes.length > 0 && now - (this.restartTimes[0] ?? now) >= this.restartWindowMs) this.restartTimes.shift();
    if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) return true;
    this.restartTimes.push(now);
    return false;
  }

  private fail(error: Error): void {
    this.state = "failed";
    this.options.onRestartFailed(error);
  }
}
