// Stands in for api.anthropic.com in end-to-end tests: a local HTTP server that lists models and streams scripted answers as server-sent events.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const CONTEXT_MARKER = "--- train.py line 39";
const ANSWER_WITH_CONTEXT = "You are reading train.py line 39, inside get_lr(). It returns peak * (step // warmup_steps).";
const CHUNK_PATTERN = /.{1,16}/gs;
const CHUNK_INTERVAL_MS = 15;

export type RecordedMessagesRequest = Readonly<{ path: string; authorization: string | null; beta: string | null; body: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>; [key: string]: unknown } }>;

export type FakeAnthropicServer = Readonly<{
  /** `http://127.0.0.1:<port>`, the value for MARGIN_ANTHROPIC_BASE_URL. */
  url: string;
  messagesRequests: Array<RecordedMessagesRequest>;
  modelRequests: Array<Readonly<{ authorization: string | null }>>;
  /** Makes the next model-list request fail with 401, as a rejected key does. */
  rejectNextKey: () => void;
  close: () => Promise<void>;
}>;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => parts.push(chunk));
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

function sse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function answerFor(body: RecordedMessagesRequest["body"], number: number): string {
  const last = body.messages.at(-1);
  const text = JSON.stringify(last?.content ?? "");
  return text.includes(CONTEXT_MARKER) ? ANSWER_WITH_CONTEXT : `Fake Claude answer ${number}.`;
}

async function streamAnswer(response: ServerResponse, answer: string): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(response, "message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  sse(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const chunk of answer.match(CHUNK_PATTERN) ?? []) {
    await new Promise<void>((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
    sse(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
  }
  sse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(response, "message_stop", { type: "message_stop" });
  response.end();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startFakeAnthropicServer(): Promise<FakeAnthropicServer> {
  const messagesRequests: Array<RecordedMessagesRequest> = [];
  const modelRequests: Array<Readonly<{ authorization: string | null }>> = [];
  let shouldRejectNextKey = false;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const authorization = request.headers.authorization ?? null;
      if (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
        modelRequests.push({ authorization });
        if (shouldRejectNextKey) {
          shouldRejectNextKey = false;
          return sendJson(response, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        }
        if (path !== "/v1/models") {
          const id = path.slice("/v1/models/".length);
          return sendJson(response, 200, { id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" });
        }
        return sendJson(response, 200, { data: [], has_more: false, first_id: null, last_id: null });
      }
      if (request.method === "POST" && path === "/v1/messages") {
        const body = JSON.parse(await readBody(request)) as RecordedMessagesRequest["body"]; // the request body Margin's SDK sent
        const beta = request.headers["anthropic-beta"];
        messagesRequests.push({ path, authorization, beta: typeof beta === "string" ? beta : null, body });
        return streamAnswer(response, answerFor(body, messagesRequests.length));
      }
      return sendJson(response, 404, { type: "error", error: { type: "not_found_error", message: `fake Anthropic has no route for ${request.method} ${path}` } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo; // listen(0, host) always yields an address object
  return {
    url: `http://127.0.0.1:${port}`,
    messagesRequests,
    modelRequests,
    rejectNextKey: () => {
      shouldRejectNextKey = true;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}
