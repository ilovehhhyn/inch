// Appends validated latency records to metrics.jsonl, one JSON line each, without ever writing text content.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { parseLatencyRecord } from "../shared/latency-record";

/** Validates `record` first, so a rejected record leaves no file and no directory behind. */
export async function appendLatencyRecord(path: string, record: unknown): Promise<void> {
  const line = JSON.stringify(parseLatencyRecord(record)) + "\n";
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, "utf8");
}
