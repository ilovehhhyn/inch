// Stands in for `codex app-server` in tests: records requests, answers only scripted ones and can crash.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ChildProcessLike, SpawnFunction } from "../../src/codex/codex-process";
import type { ServerNotification } from "../../src/codex/generated/ServerNotification";
import type { ServerRequest } from "../../src/codex/generated/ServerRequest";
import type { JsonValue } from "../../src/codex/rpc-types";

export const RESPONSE_METHOD = "<response>";

export type ReceivedMessage = Readonly<{ id: number | null; method: string; params: JsonValue | undefined }>;
export type SpawnCall = Readonly<{ command: string; args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }>;

type ResultScript = JsonValue | ((params: JsonValue | undefined) => JsonValue);
type Script = { kind: "result"; result: ResultScript } | { kind: "error"; code: number; message: string } | { kind: "silent" };

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<string> = [];
  ignoresTerminate = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.ignoresTerminate && signal !== "SIGKILL") return true;
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.stdout.end();
    this.emit("exit", code, signal);
  }
}

export class FakeAppServer {
  readonly child = new FakeChild();
  readonly spawnCalls: Array<SpawnCall> = [];
  private readonly scripts = new Map<string, Script>();
  private readonly messages: Array<ReceivedMessage> = [];
  private buffer = "";

  constructor() {
    this.child.stdin.setEncoding("utf8");
    this.child.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.handleLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  /** The stream the client reads (the server's stdout). */
  get input(): PassThrough {
    return this.child.stdout;
  }

  /** The stream the client writes (the server's stdin). */
  get output(): PassThrough {
    return this.child.stdin;
  }

  readonly spawn: SpawnFunction = (command, args, options) => {
    this.spawnCalls.push({ command, args, env: options.env });
    return this.child;
  };

  respond(method: string, result: ResultScript): void {
    this.scripts.set(method, { kind: "result", result });
  }

  respondError(method: string, code: number, message: string): void {
    this.scripts.set(method, { kind: "error", code, message });
  }

  /** Records messages for the method and never answers them; use reply() to answer a request by id. */
  ignore(method: string): void {
    this.scripts.set(method, { kind: "silent" });
  }

  reply(requestId: number, result: JsonValue): void {
    this.sendRaw(JSON.stringify({ id: requestId, result }) + "\n");
  }

  emit(notification: ServerNotification): void {
    this.sendRaw(JSON.stringify(notification) + "\n");
  }

  sendRequest(request: ServerRequest): void {
    this.sendRaw(JSON.stringify(request) + "\n");
  }

  sendRaw(text: string): void {
    this.child.stdout.write(text);
  }

  writeStderr(text: string): void {
    this.child.stderr.write(text);
  }

  crash(): void {
    this.child.exit(1, null);
  }

  received(): Array<ReceivedMessage> {
    return [...this.messages];
  }

  private handleLine(line: string): void {
    const parsed = JSON.parse(line) as { id?: number; method?: string; params?: JsonValue; result?: JsonValue; error?: JsonValue };
    if (parsed.method === undefined) {
      this.messages.push({ id: parsed.id ?? null, method: RESPONSE_METHOD, params: parsed.result ?? parsed.error });
      return;
    }
    this.messages.push({ id: parsed.id ?? null, method: parsed.method, params: parsed.params });
    const script = this.scripts.get(parsed.method);
    if (script === undefined) {
      throw new Error(`FakeAppServer received \`${parsed.method}\` but was not scripted to answer it; call respond("${parsed.method}", ...) first`);
    }
    if (script.kind === "silent" || parsed.id === undefined) return;
    if (script.kind === "error") {
      this.sendRaw(JSON.stringify({ id: parsed.id, error: { code: script.code, message: script.message } }) + "\n");
      return;
    }
    const result = typeof script.result === "function" ? script.result(parsed.params) : script.result;
    this.reply(parsed.id, result);
  }
}
