// Speaks newline-delimited JSON-RPC over a pair of byte streams without knowing how the peer was started.
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { ServerNotification } from "./generated/ServerNotification";
import type { ServerRequest } from "./generated/ServerRequest";
import type { JsonValue, ParamsOf, RequestMethod, ResultOf, Unsubscribe } from "./rpc-types";

/** A thread or turn start can take over a second cold; 30 s covers a slow network without hanging the UI forever. */
export const REQUEST_TIMEOUT_MS = 30 * 1000;

/** No message from the app-server comes near this size; a longer line means the stream is not JSON-RPC. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;
const MALFORMED_PREVIEW_CHARS = 80;

export type RpcErrorKind = "timeout" | "server" | "closed" | "malformed";

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly method: string;

  constructor(kind: RpcErrorKind, method: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.method = method;
  }
}

export type RpcConnectionOptions = Readonly<{
  input: Readable;
  output: Writable;
  requestTimeoutMs: number;
  maxLineChars?: number;
}>;

type Incoming =
  | { kind: "response"; requestId: number; result: JsonValue; error: null }
  | { kind: "response"; requestId: number; result: null; error: Readonly<{ code: number; message: string }> }
  | { kind: "notification"; notification: ServerNotification }
  | { kind: "serverRequest"; request: ServerRequest };

type PendingRequest = Readonly<{ method: string; resolve: (result: never) => void; reject: (error: RpcError) => void; timer: NodeJS.Timeout }>;

type ServerRequestHandler = (request: ServerRequest) => Promise<JsonValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the message kind of a parsed line, or undefined when the object is not a JSON-RPC message. */
function classify(value: unknown): Incoming | undefined {
  if (!isRecord(value)) return undefined;
  const { id, method } = value;
  if (typeof method === "string" && id === undefined) {
    // The cast records that the method string is trusted to belong to the pinned protocol version.
    return { kind: "notification", notification: value as unknown as ServerNotification };
  }
  if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
    return { kind: "serverRequest", request: value as unknown as ServerRequest };
  }
  if (typeof id !== "number") return undefined;
  const error = value["error"];
  if (isRecord(error) && typeof error["message"] === "string") {
    const code = typeof error["code"] === "number" ? error["code"] : 0;
    return { kind: "response", requestId: id, result: null, error: { code, message: error["message"] } };
  }
  if (!("result" in value)) return undefined;
  return { kind: "response", requestId: id, result: value["result"] as JsonValue, error: null };
}

export class RpcConnection {
  private readonly output: Writable;
  private readonly requestTimeoutMs: number;
  private readonly maxLineChars: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: ServerNotification) => void>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readonly input: Readable;
  private buffer = "";
  private nextRequestId = 1;
  private closedReason: string | null = null;

  constructor(options: RpcConnectionOptions) {
    this.input = options.input;
    this.output = options.output;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS;
    this.input.on("data", this.handleData);
    this.input.on("end", this.handleEnd);
    this.input.on("error", this.handleStreamError);
    this.output.on("error", this.handleStreamError);
  }

  request<Method extends RequestMethod>(method: Method, params: ParamsOf<Method>): Promise<ResultOf<Method>> {
    if (this.closedReason !== null) {
      return Promise.reject(new RpcError("closed", method, `${method} was not sent; the connection is closed (${this.closedReason})`));
    }
    const requestId = this.nextRequestId++;
    return new Promise<ResultOf<Method>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RpcError("timeout", method, `${method} did not answer within ${this.requestTimeoutMs} ms; the Codex app-server may be hung, so restart Margin`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
      this.write({ id: requestId, method, params });
    });
  }

  notify(method: "initialized"): void {
    this.write({ method });
  }

  onNotification(handler: (notification: ServerNotification) => void): Unsubscribe {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  close(reason = "the connection was closed by Margin"): void {
    this.fail("closed", reason);
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(JSON.stringify(message) + "\n");
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closedReason !== null) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0 && this.closedReason === null) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.closedReason === null && this.buffer.length > this.maxLineChars) {
      this.fail("malformed", `a line from the app-server exceeds ${this.maxLineChars} characters`);
    }
  };

  private readonly handleEnd = (): void => {
    this.fail("closed", "the app-server closed its output");
  };

  private readonly handleStreamError = (error: Error): void => {
    this.fail("closed", `stream error: ${error.message}`);
  };

  private handleLine(line: string): void {
    if (line.length > this.maxLineChars) {
      this.fail("malformed", `a line from the app-server exceeds ${this.maxLineChars} characters`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("malformed", `the app-server sent a line that is not JSON: ${line.slice(0, MALFORMED_PREVIEW_CHARS)}`);
      return;
    }
    const message = classify(parsed);
    if (message === undefined) {
      this.fail("malformed", `the app-server sent JSON that is not a JSON-RPC message: ${line.slice(0, MALFORMED_PREVIEW_CHARS)}`);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Incoming): void {
    if (message.kind === "response") {
      this.settle(message);
      return;
    }
    if (message.kind === "notification") {
      for (const handler of this.notificationHandlers) {
        this.runHandler(() => handler(message.notification));
      }
      return;
    }
    void this.answerServerRequest(message.request);
  }

  /** A response with no pending request is a late answer to a request that already timed out. */
  private settle(response: Extract<Incoming, { kind: "response" }>): void {
    const request = this.pending.get(response.requestId);
    if (request === undefined) return;
    this.pending.delete(response.requestId);
    clearTimeout(request.timer);
    if (response.error !== null) {
      request.reject(new RpcError("server", request.method, `${request.method} failed with code ${response.error.code}: ${response.error.message}`));
      return;
    }
    request.resolve(response.result as never); // the caller's ResultOf<Method> type is the only record of the result shape
  }

  /** A failing notification handler must not stop other handlers; its error is rethrown outside the read loop. */
  private runHandler(run: () => void): void {
    try {
      run();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  private async answerServerRequest(request: ServerRequest): Promise<void> {
    if (this.serverRequestHandler === null) {
      this.write({ id: request.id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Margin has no handler for ${request.method}` } });
      return;
    }
    try {
      this.write({ id: request.id, result: await this.serverRequestHandler(request) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write({ id: request.id, error: { code: JSON_RPC_INTERNAL_ERROR, message } });
    }
  }

  private fail(kind: "closed" | "malformed", reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new RpcError(kind, request.method, `${request.method} failed because ${reason}`));
    }
  }
}
