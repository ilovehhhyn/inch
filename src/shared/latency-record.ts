// Defines the one line of metrics.jsonl and parses it strictly, so a record can carry numbers and the pane kind but never text.

export type LatencyRecord = Readonly<{
  /** ISO 8601 time at which the record was written. */
  at: string;
  paneKind: "chat" | "diff";
  blockCount: number;
  contextChars: number;
  captureMs: number;
  /** Milliseconds from the key press until `turn/start` answered. */
  turnStartAckMs: number;
  /** Milliseconds from the key press until the first answer text; null when the turn ended without any. */
  firstDeltaMs: number | null;
}>;

const KEYS: ReadonlyArray<string> = ["at", "paneKind", "blockCount", "contextChars", "captureMs", "turnStartAckMs", "firstDeltaMs"];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function invalid(field: string, rule: string): Error {
  return new Error(`latency record field \`${field}\` ${rule}`);
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(field, `must be a whole number of at least 0, got ${JSON.stringify(value)}`);
  return value;
}

function requireDuration(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(field, `must be a finite number of milliseconds of at least 0, got ${JSON.stringify(value)}`);
  return value;
}

/** Parses untrusted data into a LatencyRecord; an unknown key is an error so text cannot ride along. */
export function parseLatencyRecord(value: unknown): LatencyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("latency record must be an object");
  const record = value as Record<string, unknown>; // checked above: a non-null, non-array object
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key));
  if (unknown !== undefined) throw new Error(`latency record has unknown key \`${unknown}\`; a record holds numbers and the pane kind only`);
  const at = record["at"];
  if (typeof at !== "string" || !ISO_TIMESTAMP.test(at)) throw invalid("at", `must be an ISO 8601 UTC timestamp, got ${JSON.stringify(at)}`);
  const paneKind = record["paneKind"];
  if (paneKind !== "chat" && paneKind !== "diff") throw invalid("paneKind", `must be \`chat\` or \`diff\`, got ${JSON.stringify(paneKind)}`);
  const firstDelta = record["firstDeltaMs"];
  return {
    at,
    paneKind,
    blockCount: requireCount(record["blockCount"], "blockCount"),
    contextChars: requireCount(record["contextChars"], "contextChars"),
    captureMs: requireDuration(record["captureMs"], "captureMs"),
    turnStartAckMs: requireDuration(record["turnStartAckMs"], "turnStartAckMs"),
    firstDeltaMs: firstDelta === null ? null : requireDuration(firstDelta, "firstDeltaMs"),
  };
}
