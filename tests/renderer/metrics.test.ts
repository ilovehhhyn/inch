// Invariant: a Command-I send yields exactly one latency record with its three durations measured from the moment the key was pressed.
import { expect, test } from "vitest";

import { LatencyRecorder, type CaptureSummary } from "../../src/renderer/metrics";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import type { LatencyRecord } from "../../src/shared/latency-record";

const THREAD = asThreadId("thread-1");
const TURN = asTurnId("turn-1");
const CAPTURE: CaptureSummary = { paneKind: "diff", blockCount: 7, contextChars: 2100, captureMs: 3.5 };

function recorderWithClock(): Readonly<{ recorder: LatencyRecorder; records: Array<LatencyRecord>; clock: { now: number } }> {
  const records: Array<LatencyRecord> = [];
  const clock = { now: 1000 };
  const recorder = new LatencyRecorder({ sink: async (record) => void records.push(record), now: () => clock.now, wallClock: () => new Date("2026-11-23T10:00:00.000Z") });
  return { recorder, records, clock };
}

test("the record is written once, at the first delta, with durations from the key press", () => {
  const { recorder, records, clock } = recorderWithClock();
  const send = recorder.begin(CAPTURE);
  clock.now = 1040;
  send.acknowledged(TURN);
  clock.now = 2500;
  recorder.observe({ type: "delta", threadId: THREAD, turnId: TURN, text: "a" });
  clock.now = 2600;
  recorder.observe({ type: "delta", threadId: THREAD, turnId: TURN, text: "b" });
  recorder.observe({ type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null });

  expect(records).toEqual([{ at: "2026-11-23T10:00:00.000Z", paneKind: "diff", blockCount: 7, contextChars: 2100, captureMs: 3.5, turnStartAckMs: 40, firstDeltaMs: 1500 }]);
});

test("a delta that outruns the acknowledgement is still counted", () => {
  const { recorder, records, clock } = recorderWithClock();
  const send = recorder.begin(CAPTURE);
  clock.now = 1300;
  recorder.observe({ type: "delta", threadId: THREAD, turnId: TURN, text: "a" });
  clock.now = 1350;
  send.acknowledged(TURN);

  expect(records).toHaveLength(1);
  expect(records[0]?.firstDeltaMs).toBe(300);
  expect(records[0]?.turnStartAckMs).toBe(350);
});

test("a turn that ends with no delta is recorded with a null first delta", () => {
  const { recorder, records } = recorderWithClock();
  recorder.begin(CAPTURE).acknowledged(TURN);

  recorder.observe({ type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: "rate limit" });

  expect(records).toHaveLength(1);
  expect(records[0]?.firstDeltaMs).toBeNull();
});

test("a send that was rejected before the acknowledgement writes nothing", () => {
  const { recorder, records } = recorderWithClock();
  const send = recorder.begin(CAPTURE);

  send.failed();
  recorder.observe({ type: "delta", threadId: THREAD, turnId: TURN, text: "a" });

  expect(records).toEqual([]);
});

test("a delta for a turn that no Command-I send started writes nothing", () => {
  const { recorder, records } = recorderWithClock();

  recorder.observe({ type: "delta", threadId: THREAD, turnId: TURN, text: "a" });
  recorder.observe({ type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null });

  expect(records).toEqual([]);
});
