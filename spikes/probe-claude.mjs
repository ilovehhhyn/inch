// Measures Claude's time to the first word of an answer. It sends PAID requests, so it refuses to start without a dollar cap.
// Usage: MARGIN_SPIKE_USD_CAP=1 node spikes/probe-claude.mjs > docs/spikes/raw-claude-latency.jsonl
// The API key comes from the macOS Keychain entry (service `margin-spike`, account `anthropic`), never from the environment or argv:
//   security add-generic-password -s margin-spike -a anthropic -w
// Output: one JSON line per request on stdout; a summary and every error on stderr.
import { execFileSync } from "node:child_process";

const MODEL = "claude-opus-5-5";
// $ per token: $4 and $20 per million input and output tokens (bundled Claude API reference, model table, 2026-11-03).
const INPUT_USD_PER_TOKEN = 4 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 20 / 1_000_000;
const PROMPT = "Reply with the single word OK.";
const CONTEXT_CHARS = 12_000;
const CONTEXT = "MARGIN SCREEN CONTEXT\n" + "The learning rate is annealed with a cosine schedule after warmup.\n".repeat(200).slice(0, CONTEXT_CHARS - 22);
const REQUESTS_PER_SETTING = 10;
/** Thinking tokens are billed as output, so output is bounded; the bound is also the worst case the cap guard assumes. */
const MAX_TOKENS = 1024;
/** A request of 12,000 characters is about 3,000 tokens; the guard assumes one token per 2.5 characters so it never undercounts. */
const CHARS_PER_TOKEN_WORST_CASE = 2.5;
const PROMPT_OVERHEAD_TOKENS = 200;
const PAUSE_BETWEEN_REQUESTS_MS = 2000;
const SETTINGS = [
  { effort: "low", withContext: false },
  { effort: "low", withContext: true },
  { effort: "medium", withContext: false },
  { effort: "medium", withContext: true },
];

function fail(message) {
  process.stderr.write(`probe-claude: ${message}\n`);
  process.exit(1);
}

/** Reads the cap before anything else, so a missing or invalid cap stops the probe before a key is read or a request is sent. */
function readCap() {
  const raw = process.env["MARGIN_SPIKE_USD_CAP"];
  if (raw === undefined || raw === "") fail("MARGIN_SPIKE_USD_CAP is not set; set it to the dollar cap Helen approved, for example MARGIN_SPIKE_USD_CAP=1");
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap <= 0) fail(`MARGIN_SPIKE_USD_CAP must be a positive number of dollars, got \`${raw}\``);
  return cap;
}

function readKey() {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "margin-spike", "-a", "anthropic", "-w"], { encoding: "utf8" }).trim();
  } catch {
    return fail("no Keychain entry `margin-spike` / `anthropic`; create it with `security add-generic-password -s margin-spike -a anthropic -w`");
  }
}

function worstCaseCostUsd(withContext) {
  const inputChars = PROMPT.length + (withContext ? CONTEXT_CHARS : 0);
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN_WORST_CASE) + PROMPT_OVERHEAD_TOKENS;
  return inputTokens * INPUT_USD_PER_TOKEN + MAX_TOKENS * OUTPUT_USD_PER_TOKEN;
}

async function timeOneRequest(client, setting) {
  const content = setting.withContext ? `${CONTEXT}\n\n${PROMPT}` : PROMPT;
  const start = performance.now();
  let firstTextMs = null;
  const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: setting.effort }, messages: [{ role: "user", content }] });
  for await (const event of stream) {
    if (firstTextMs === null && event.type === "content_block_delta" && event.delta.type === "text_delta") firstTextMs = performance.now() - start;
  }
  const message = await stream.finalMessage();
  const stopMs = performance.now() - start;
  const costUsd = message.usage.input_tokens * INPUT_USD_PER_TOKEN + message.usage.output_tokens * OUTPUT_USD_PER_TOKEN;
  return { firstTextMs, stopMs, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, costUsd, text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("") };
}

async function main() {
  const capUsd = readCap();
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: readKey() });
  let spentUsd = 0;
  for (const setting of SETTINGS) {
    for (let run = 1; run <= REQUESTS_PER_SETTING; run++) {
      if (spentUsd + worstCaseCostUsd(setting.withContext) > capUsd) fail(`stopping before the next request: spent $${spentUsd.toFixed(4)}, and the next request could cost $${worstCaseCostUsd(setting.withContext).toFixed(4)}, which would pass the cap of $${capUsd}`);
      const result = await timeOneRequest(client, setting);
      spentUsd += result.costUsd;
      process.stdout.write(JSON.stringify({ ...setting, run, ...result }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_REQUESTS_MS));
    }
  }
  process.stderr.write(`probe-claude: done, total cost $${spentUsd.toFixed(4)} of the $${capUsd} cap\n`);
}

await main();
