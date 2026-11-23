// Invariant: each latency record becomes exactly one JSON line appended to metrics.jsonl, and a rejected record writes nothing.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { appendLatencyRecord } from "../../src/main/metrics-store";
import type { LatencyRecord } from "../../src/shared/latency-record";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "margin-metrics-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const RECORD: LatencyRecord = { at: "2026-11-23T10:00:00.000Z", paneKind: "chat", blockCount: 3, contextChars: 900, captureMs: 0.5, turnStartAckMs: 12, firstDeltaMs: 1200 };

test("two records are two lines in order", async () => {
  const path = join(directory, "metrics.jsonl");

  await appendLatencyRecord(path, RECORD);
  await appendLatencyRecord(path, { ...RECORD, blockCount: 4 });

  const lines = (await readFile(path, "utf8")).split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe("");
  expect(JSON.parse(lines[0] ?? "")).toEqual(RECORD);
  expect(JSON.parse(lines[1] ?? "")).toEqual({ ...RECORD, blockCount: 4 });
});

test("a record with an unknown key is rejected and the file is not created", async () => {
  const path = join(directory, "metrics.jsonl");

  await expect(appendLatencyRecord(path, { ...RECORD, text: "question" })).rejects.toThrow("unknown key `text`");

  expect(await readdir(directory)).toEqual([]);
});
