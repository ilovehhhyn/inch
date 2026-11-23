// Reads the chosen pane and builds the finished screen-context text, timing the read against its budget.
import { renderContextBlock } from "../../shared/context-format";
import type { PaneId } from "./pane-id";
import { describePane, readPane } from "./pane-registry";
import { CONTEXT_BUDGET_CHARS, selectContext } from "./select-context";

/** Reading context on Command-I must finish within this time on the end-to-end fixture (plan, global constraints). */
export const CAPTURE_BUDGET_MS = 20;

export const CAPTURE_MEASURE_NAME = "margin:capture";

export type Capture = Readonly<{ text: string; elapsedMs: number; paneKind: "chat" | "diff"; blockCount: number }>;

/** Returns the MARGIN SCREEN CONTEXT text for `paneId` and records a `margin:capture` User Timing entry. */
export function captureContext(paneId: PaneId, now: () => number = () => performance.now()): Capture {
  const start = now();
  const { kind, title, viewportHeight } = describePane(paneId);
  const blocks = selectContext(readPane(paneId), viewportHeight, CONTEXT_BUDGET_CHARS);
  const text = renderContextBlock({ paneKind: kind, paneTitle: title, blocks });
  const end = now();
  performance.measure(CAPTURE_MEASURE_NAME, { start, end });
  return { text, elapsedMs: end - start, paneKind: kind, blockCount: blocks.length };
}
