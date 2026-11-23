// Stands in for `codex` in end-to-end tests: answers `--version` and speaks the app-server JSON-RPC over stdio from a script, with no model.
// Usage: fake-codex.mjs [--log FILE] [--seed FILE] [--signed-out] (--version | app-server)
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const VERSION_LINE = "codex-cli 0.146.0";
const DELTA_INTERVAL_MS = 15;
const CONTEXT_MARKER = "--- train.py line 39";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION_LINE}\n`);
  process.exit(0);
}
if (!process.argv.includes("app-server")) {
  process.stderr.write("fake-codex: expected `--version` or `app-server`\n");
  process.exit(2);
}

const logPath = option("--log");
const seedPath = option("--seed");
const isSignedOut = process.argv.includes("--signed-out");
const threads = new Map();
let nextThread = 1;
let nextTurn = 1;
let clock = 1_700_000_000;

function log(entry) {
  if (logPath !== null) appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function threadRecord(thread) {
  return { id: thread.id, forkedFromId: thread.forkedFromId, preview: thread.preview, name: null, updatedAt: thread.updatedAt, cwd: "/fake", ephemeral: false, turns: thread.turns };
}

function turnRecord(turn, status) {
  return { id: turn.id, status, error: null, items: [{ type: "userMessage", id: `${turn.id}-u`, content: [{ type: "text", text: turn.user, text_elements: [] }] }, { type: "agentMessage", id: `${turn.id}-a`, text: turn.assistant }] };
}

if (seedPath !== null) {
  for (const seeded of JSON.parse(readFileSync(seedPath, "utf8")).threads) {
    threads.set(seeded.id, { id: seeded.id, forkedFromId: null, preview: seeded.turns[0].user, updatedAt: clock--, turns: seeded.turns.map((turn) => turnRecord(turn, "completed")) });
  }
}

function requireThread(id) {
  const thread = threads.get(id);
  if (thread === undefined) throw new Error(`fake-codex has no thread ${id}`);
  return thread;
}

function answerFor(userText, number) {
  return userText.includes(CONTEXT_MARKER) ? "You are reading train.py line 39, inside get_lr(). It returns peak * (step // warmup_steps)." : `Fake answer ${number}.`;
}

function runTurn(thread, params) {
  const number = nextTurn++;
  const turnId = `turn-${number}`;
  const user = params.input.map((item) => item.text).join("");
  const answer = answerFor(user, number);
  const itemId = `${turnId}-a`;
  const inProgress = { id: turnId, status: "inProgress", items: [], error: null };
  send({ method: "turn/started", params: { threadId: thread.id, turn: inProgress } });
  const chunks = answer.match(/.{1,16}/gs) ?? [];
  chunks.forEach((chunk, index) => {
    setTimeout(() => send({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId, itemId, delta: chunk } }), DELTA_INTERVAL_MS * (index + 1));
  });
  setTimeout(() => {
    const turn = { id: turnId, user, assistant: answer };
    thread.turns.push(turnRecord(turn, "completed"));
    if (thread.preview === "") thread.preview = user;
    thread.updatedAt = clock++;
    send({ method: "turn/completed", params: { threadId: thread.id, turn: turnRecord(turn, "completed") } });
  }, DELTA_INTERVAL_MS * (chunks.length + 2));
  return { turn: inProgress };
}

function handle(method, params) {
  switch (method) {
    case "initialize":
      return { userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" };
    case "config/read":
      return { config: { mcp_servers: {} }, origins: {}, layers: null };
    case "account/read":
      return { account: isSignedOut ? null : { type: "chatgpt", email: "fake@example.com", planType: "plus" }, requiresOpenaiAuth: false };
    case "model/list":
      return { data: [{ id: "fake-model", model: "fake-model", isDefault: true }], nextCursor: null };
    case "thread/start": {
      const thread = { id: `thread-${nextThread++}`, forkedFromId: null, preview: "", updatedAt: clock++, turns: [] };
      threads.set(thread.id, thread);
      return { thread: threadRecord(thread), model: params.model };
    }
    case "thread/fork": {
      const parent = requireThread(params.threadId);
      const through = parent.turns.findIndex((turn) => turn.id === params.lastTurnId);
      const copied = params.lastTurnId === null ? parent.turns : parent.turns.slice(0, through + 1);
      const thread = { id: `thread-${nextThread++}`, forkedFromId: parent.id, preview: parent.preview, updatedAt: clock++, turns: [...copied] };
      threads.set(thread.id, thread);
      return { thread: threadRecord(thread), model: params.model };
    }
    case "thread/resume":
      return { thread: threadRecord(requireThread(params.threadId)), model: params.model };
    case "thread/list":
      return { data: [...threads.values()].map((thread) => ({ ...threadRecord(thread), turns: [] })), nextCursor: null };
    case "thread/read": {
      const thread = threadRecord(requireThread(params.threadId));
      return { thread: params.includeTurns ? thread : { ...thread, turns: [] } };
    }
    case "turn/start":
      return runTurn(requireThread(params.threadId), params);
    case "turn/interrupt":
      return {};
    default:
      throw new Error(`fake-codex was not scripted to answer \`${method}\``);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  log({ method: message.method, params: message.params ?? null });
  if (message.id === undefined) return;
  try {
    send({ id: message.id, result: handle(message.method, message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
});
lines.on("close", () => process.exit(0));
