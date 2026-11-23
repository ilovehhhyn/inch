// Sends a question to a thread: reads the screen context when asked, starts the thread when needed, and tracks which threads are mid-send.
import { useCallback, useState } from "react";

import type { MarginApi } from "../../shared/ipc-contract";
import type { ThreadId } from "../../shared/provider-events";
import type { SendMode } from "../components/Composer";
import { captureContext, CAPTURE_BUDGET_MS } from "../context/capture-context";
import { asPaneId, type PaneId } from "../context/pane-id";
import type { ScrollTracker } from "../context/scroll-tracker";
import type { ThreadStore } from "./thread-store";

/** The key under which a send with no thread yet is tracked. */
const NEW_CHAT_KEY = "new-chat";

/** The pane that holds keyboard focus: the nearest ancestor of the focused element that names a pane. */
function focusedPaneId(): PaneId | null {
  const id = document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
  return id === null || id === undefined ? null : asPaneId(id);
}

/** Reads the pane scrolled last (else the focused pane) for Command-I; Enter reads nothing. Either send starts a new scroll window. */
function contextFor(mode: SendMode, tracker: ScrollTracker): string | null {
  const paneId = tracker.choosePane(focusedPaneId());
  tracker.markMessageSent();
  if (mode === "plain") return null;
  if (paneId === null) throw new Error("no pane to read: scroll a pane or click into one, then press Command-I");
  const capture = captureContext(paneId);
  if (capture.elapsedMs > CAPTURE_BUDGET_MS) console.warn(`reading ${paneId} took ${capture.elapsedMs.toFixed(1)} ms, over the ${CAPTURE_BUDGET_MS} ms budget`);
  return capture.text;
}

export type Sender = Readonly<{
  /** Sends in `threadId`, or in a new thread when null; `onThreadStarted` receives that new thread's id before the turn starts. */
  send: (threadId: ThreadId | null, question: string, mode: SendMode, onThreadStarted: (threadId: ThreadId) => void) => Promise<void>;
  isSending: (threadId: ThreadId | null) => boolean;
}>;

export function useSender(api: MarginApi, store: ThreadStore, tracker: ScrollTracker, report: (threadId: ThreadId | null, error: unknown) => void): Sender {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const setPendingKey = useCallback((key: string, isPending: boolean) => {
    setPending((previous) => {
      const next = new Set(previous);
      if (isPending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const send = useCallback(
    async (threadId: ThreadId | null, question: string, mode: SendMode, onThreadStarted: (threadId: ThreadId) => void): Promise<void> => {
      const key = threadId ?? NEW_CHAT_KEY;
      setPendingKey(key, true);
      let target = threadId;
      try {
        const contextText = contextFor(mode, tracker);
        if (target === null) {
          target = await api.threadStart();
          onThreadStarted(target);
        }
        const turnId = await api.turnStart(target, question, contextText);
        store.begin(target, { turnId, question });
      } catch (error) {
        report(target, error);
      } finally {
        setPendingKey(key, false);
      }
    },
    [api, store, tracker, report, setPendingKey],
  );

  return { send, isSending: (threadId) => pending.has(threadId ?? NEW_CHAT_KEY) };
}
