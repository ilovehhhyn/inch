// Starts `codex app-server` as a child process and exposes its JSON-RPC connection, exit and stop.
import { spawn as spawnChild } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { REQUEST_TIMEOUT_MS, RpcConnection } from "./rpc-connection";

/** Enough stderr to show the last error report without letting a chatty server grow memory without bound. */
export const STDERR_TAIL_BYTES = 64 * 1024;

/** Time the app-server gets to exit after SIGTERM before it is killed. */
export const STOP_TIMEOUT_MS = 5 * 1000;

export type ChildProcessLike = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

export type SpawnOptions = Readonly<{ stdio: ["pipe", "pipe", "pipe"]; env: Readonly<Record<string, string>> }>;

export type SpawnFunction = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcessLike;

export type ExitInfo = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  spawnError: string | null;
}>;

export type CodexProcess = Readonly<{
  connection: RpcConnection;
  exited: Promise<ExitInfo>;
  stop(): Promise<void>;
}>;

export type StartCodexProcessOptions = Readonly<{
  codexPath: string;
  env: Readonly<Record<string, string>>;
  spawn?: SpawnFunction;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}>;

/** Starts a real child process; the argument array and explicit environment mean no shell and no inherited variables. */
const spawnNode: SpawnFunction = (command, args, options) => spawnChild(command, [...args], { stdio: options.stdio, env: { ...options.env } });

/** Keeps the last STDERR_TAIL_BYTES bytes written to it. */
class TailBuffer {
  private bytes = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const combined = Buffer.concat([this.bytes, incoming]);
    this.bytes = combined.subarray(Math.max(0, combined.length - STDERR_TAIL_BYTES));
  }

  text(): string {
    return this.bytes.toString("utf8");
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code}` : `signal ${signal}`;
}

export function startCodexProcess(options: StartCodexProcessOptions): CodexProcess {
  const spawn = options.spawn ?? spawnNode;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const child = spawn(options.codexPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: options.env });
  const connection = new RpcConnection({ input: child.stdout, output: child.stdin, requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS });
  const stderr = new TailBuffer();
  child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));

  let hasExited = false;
  let resolveExited: (info: ExitInfo) => void = () => undefined;
  const exited = new Promise<ExitInfo>((resolve) => {
    resolveExited = resolve;
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): void => {
    if (hasExited) return;
    hasExited = true;
    connection.close(spawnError === null ? `the Codex app-server exited (${describeExit(code, signal)})` : `the Codex app-server did not start: ${spawnError}`);
    resolveExited({ code, signal, stderrTail: stderr.text(), spawnError });
  };
  child.once("exit", (code, signal) => finish(code, signal, null));
  child.once("error", (error) => finish(null, null, error.message));

  const stop = async (): Promise<void> => {
    if (hasExited) return;
    connection.close("Margin stopped the Codex app-server");
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), stopTimeoutMs);
    });
    const outcome = await Promise.race([exited, timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  };

  return { connection, exited, stop };
}
