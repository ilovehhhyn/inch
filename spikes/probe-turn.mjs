// Measures codex app-server turn latency and answers two protocol questions. Usage:
//   node spikes/probe-turn.mjs latency            (JSON lines on stdout: 20 timed turns)
//   node spikes/probe-turn.mjs shell [paramsJson]  (extra thread/start params as JSON; does "run ls" produce a commandExecution item?)
//   node spikes/probe-turn.mjs two-item            (are two text inputs stored in order?)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The user's ~/.codex/config.toml names gpt-6-astra, which is not in model/list and answers 429; pass a listed model.
const MODEL = "gpt-5.6-sol";
const PROMPT = "Reply with the single word OK.";
const CONTEXT = "MARGIN SCREEN CONTEXT\n" + "The learning rate is annealed with a cosine schedule after warmup.\n".repeat(200).slice(0, 12000 - 22);
const TURNS_PER_CONDITION = 10;
const TURN_TIMEOUT_MS = 120_000;
// Bursts of back-to-back turns on one account returned 429 after about five turns; space turns like a person would.
const PAUSE_BETWEEN_TURNS_MS = 4000;

const server = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
const listeners = new Set();
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method !== undefined && message.id === undefined) {
      for (const listener of listeners) listener(message);
    } else if (message.id !== undefined) {
      server.stdin.write(JSON.stringify({ id: message.id, result: { decision: "decline" } }) + "\n");
    }
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });

async function runTurn(threadId, input) {
  const events = [];
  const start = performance.now();
  let firstDeltaMs = null;
  let startedMs = null;
  let completed;
  let status = "timeout";
  let failure = null;
  const done = new Promise((resolve) => (completed = resolve));
  const listener = (message) => {
    const elapsed = performance.now() - start;
    events.push({ at: elapsed, message });
    if (message.params?.threadId !== threadId) return;
    if (message.method === "turn/started" && startedMs === null) startedMs = elapsed;
    if (message.method === "item/agentMessage/delta" && firstDeltaMs === null) firstDeltaMs = elapsed;
    if (message.method === "turn/completed") {
      status = message.params.turn.status;
      failure = message.params.turn.error ?? null;
      completed(elapsed);
    }
  };
  listeners.add(listener);
  await request("turn/start", { threadId, input: input.map((text) => ({ type: "text", text, text_elements: [] })) });
  const timer = setTimeout(() => completed(null), TURN_TIMEOUT_MS);
  const completedMs = await done;
  clearTimeout(timer);
  listeners.delete(listener);
  if (status !== "completed") throw new Error(`turn ${status}: ${JSON.stringify(failure)}`);
  return { startedMs, firstDeltaMs, completedMs, events };
}

const threadParams = (extra) => ({
  model: MODEL,
  ephemeral: true,
  sandbox: "read-only",
  approvalPolicy: "never",
  cwd: mkdtempSync(join(tmpdir(), "margin-spike-")),
  developerInstructions: "Answer briefly.",
  ...extra,
});

await request("initialize", { clientInfo: { name: "margin_probe", title: "Margin probe", version: "0.0.0" }, capabilities: { experimentalApi: true } });
server.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const mode = process.argv[2];

if (mode === "latency") {
  // Two threads, turns alternate between them so that drift in server load hits both. The context thread
  // sends the 12,000-character context before the question on every turn, so its history grows as in use.
  const conditions = [
    { name: "no_context", input: [PROMPT], threadId: (await request("thread/start", threadParams({}))).thread.id },
    { name: "context_12000", input: [CONTEXT, PROMPT], threadId: (await request("thread/start", threadParams({}))).thread.id },
  ];
  for (let index = 0; index < TURNS_PER_CONDITION; index++) {
    for (const condition of conditions) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_TURNS_MS));
      const row = { condition: condition.name, index, contextChars: condition.name === "no_context" ? 0 : CONTEXT.length };
      try {
        const { startedMs, firstDeltaMs, completedMs } = await runTurn(condition.threadId, condition.input);
        console.log(JSON.stringify({ ...row, status: "completed", startedMs, firstDeltaMs, completedMs }));
      } catch (error) {
        console.log(JSON.stringify({ ...row, status: "failed", error: error.message }));
      }
    }
  }
} else if (mode === "shell") {
  const extra = process.argv[3] === undefined ? {} : JSON.parse(process.argv[3]);
  const { thread } = await request("thread/start", threadParams(extra));
  const { events } = await runTurn(thread.id, [process.env["PROBE_PROMPT"] ?? "Run the shell command `ls` in your working directory and tell me the output."]);
  const itemTypes = events.filter((e) => e.message.method === "item/started").map((e) => e.message.params.item.type);
  const answer = events.filter((e) => e.message.method === "item/completed" && e.message.params.item.type === "agentMessage").map((e) => e.message.params.item.text);
  const mcpServers = [...new Set(events.filter((e) => e.message.method === "mcpServer/startupStatus/updated").map((e) => e.message.params.name))].sort();
  console.log(JSON.stringify({ extra, mcpServers, itemTypes, commandExecution: itemTypes.includes("commandExecution"), answer }));
} else if (mode === "two-item") {
  const { thread } = await request("thread/start", threadParams({ ephemeral: false }));
  await runTurn(thread.id, ["CONTEXT-ITEM first", "QUESTION-ITEM second. Reply OK."]);
  const read = await request("thread/read", { threadId: thread.id, includeTurns: true });
  const user = read.thread.turns.flatMap((turn) => turn.items).filter((item) => item.type === "userMessage");
  console.log(JSON.stringify(user.map((item) => item.content)));
} else {
  throw new Error(`unknown mode ${mode}; use latency, shell or two-item`);
}
server.kill();
