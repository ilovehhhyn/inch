// Invariant: a latency record holds only numbers, the pane kind and a timestamp, and the parser rejects anything else, so no text can reach metrics.jsonl.
import { expect, test } from "vitest";

import { parseLatencyRecord, type LatencyRecord } from "../../src/shared/latency-record";

const VALID: LatencyRecord = { at: "2026-11-23T10:00:00.000Z", paneKind: "diff", blockCount: 12, contextChars: 3400, captureMs: 4.5, turnStartAckMs: 30.2, firstDeltaMs: 1500.8 };

test("a valid record parses to the same fields", () => {
  expect(parseLatencyRecord({ ...VALID })).toEqual(VALID);
});

test("a record with no first delta keeps null", () => {
  expect(parseLatencyRecord({ ...VALID, firstDeltaMs: null }).firstDeltaMs).toBeNull();
});

test.each([
  ["an unknown key such as a text field", { ...VALID, text: "secret question" }, "unknown key `text`"],
  ["a pane kind outside chat and diff", { ...VALID, paneKind: "side" }, "paneKind"],
  ["a negative duration", { ...VALID, captureMs: -1 }, "captureMs"],
  ["a fractional block count", { ...VALID, blockCount: 1.5 }, "blockCount"],
  ["a time that is not an ISO timestamp", { ...VALID, at: "yesterday" }, "at"],
  ["a missing field", { at: VALID.at }, "paneKind"],
  ["a value that is not an object", "text", "object"],
])("%s is rejected with a message naming the field", (_name, value, fragment) => {
  expect(() => parseLatencyRecord(value)).toThrow(fragment);
});
