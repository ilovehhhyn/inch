// Times each Command-I send from the key press to the acknowledgement and the first answer text, and hands one record to a sink.
import type { LatencyRecord } from "../shared/latency-record";
import type { ProviderEvent, TurnId } from "../shared/provider-events";

/** Deltas can outrun the acknowledgement of their own turn; only this many unclaimed ones are remembered, so memory stays bounded. */
const MAX_UNCLAIMED_DELTAS = 32;

/** What reading the pane produced; no text. */
export type CaptureSummary = Readonly<{ paneKind: "chat" | "diff"; blockCount: number; contextChars: number; captureMs: number }>;

export type LatencySink = (record: LatencyRecord) => Promise<void>;

export type LatencyRecorderOptions = Readonly<{
  sink: LatencySink;
  now: () => number;
  wallClock: () => Date;
}>;

export type SendMark = Readonly<{
  /** `turn/start` answered with `turnId`. */
  acknowledged: (turnId: TurnId) => void;
  /** The send failed before it was acknowledged; nothing is recorded. */
  failed: () => void;
}>;

type Pending = {
  readonly capture: CaptureSummary;
  readonly startMs: number;
  ackMs: number | null;
  firstDeltaMs: number | null;
};

export class LatencyRecorder {
  private readonly options: LatencyRecorderOptions;
  private readonly pending = new Map<TurnId, Pending>();
  private readonly unacknowledged = new Set<Pending>();
  private readonly unclaimedDeltas = new Map<TurnId, number>();

  constructor(options: LatencyRecorderOptions) {
    this.options = options;
  }

  /** Starts the clock; call it when the key is pressed, before the pane is read, and pass the capture summary once it exists. */
  begin(capture: CaptureSummary, startMs: number = this.options.now()): SendMark {
    const entry: Pending = { capture, startMs, ackMs: null, firstDeltaMs: null };
    this.unacknowledged.add(entry);
    return {
      acknowledged: (turnId) => this.acknowledge(entry, turnId),
      failed: () => void this.unacknowledged.delete(entry),
    };
  }

  private acknowledge(entry: Pending, turnId: TurnId): void {
    this.unacknowledged.delete(entry);
    entry.ackMs = this.options.now();
    const early = this.unclaimedDeltas.get(turnId);
    if (early !== undefined) {
      entry.firstDeltaMs = early;
      this.unclaimedDeltas.delete(turnId);
    }
    this.pending.set(turnId, entry);
    if (entry.firstDeltaMs !== null) this.finish(turnId, entry);
  }

  /** Feeds every provider event; the first delta of a pending turn completes its record, and a turn that ends without one records null. */
  observe(event: ProviderEvent): void {
    if (event.type === "accountChanged") return;
    const entry = this.pending.get(event.turnId);
    if (event.type === "delta") {
      const at = this.options.now();
      if (entry === undefined) return this.rememberUnclaimed(event.turnId, at);
      if (entry.firstDeltaMs === null) {
        entry.firstDeltaMs = at;
        this.finish(event.turnId, entry);
      }
      return;
    }
    this.unclaimedDeltas.delete(event.turnId);
    if (entry !== undefined) this.finish(event.turnId, entry);
  }

  private rememberUnclaimed(turnId: TurnId, at: number): void {
    if (this.unacknowledged.size === 0 || this.unclaimedDeltas.has(turnId)) return;
    this.unclaimedDeltas.set(turnId, at);
    if (this.unclaimedDeltas.size > MAX_UNCLAIMED_DELTAS) {
      const oldest = this.unclaimedDeltas.keys().next();
      if (oldest.done !== true) this.unclaimedDeltas.delete(oldest.value);
    }
  }

  private finish(turnId: TurnId, entry: Pending): void {
    this.pending.delete(turnId);
    const { capture, startMs, ackMs, firstDeltaMs } = entry;
    if (ackMs === null) throw new Error("a latency record cannot be finished before turn/start is acknowledged");
    const record: LatencyRecord = {
      at: this.options.wallClock().toISOString(),
      paneKind: capture.paneKind,
      blockCount: capture.blockCount,
      contextChars: capture.contextChars,
      captureMs: capture.captureMs,
      turnStartAckMs: ackMs - startMs,
      firstDeltaMs: firstDeltaMs === null ? null : firstDeltaMs - startMs,
    };
    this.options.sink(record).catch((error: unknown) => console.warn(`could not write the latency record: ${error instanceof Error ? error.message : String(error)}`));
  }
}
