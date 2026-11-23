// Sends a question to a thread: reads the screen context when asked, starts the thread when needed, and tracks which threads are mid-send.
import { useCallback, useRef, useState } from "react";

import type { AttachmentChip } from "../../shared/attachment";
import type { MarginApi } from "../../shared/ipc-contract";
import type { ModelChoice } from "../../shared/models";
import type { ThreadId } from "../../shared/provider-events";
import type { ProviderId } from "../../shared/provider-id";
import type { SendMode } from "../components/Composer";
import { captureContext, CAPTURE_BUDGET_MS, type Capture } from "../context/capture-context";
import { asPaneId, type PaneId } from "../context/pane-id";
import type { ScrollTracker } from "../context/scroll-tracker";
import type { LatencyRecorder, SendMark } from "../metrics";
import type { ThreadStore } from "./thread-store";

/** The key under which a send with no thread yet is tracked. */
const NEW_CHAT_KEY = "new-chat";

/** The pane that holds keyboard focus: the nearest ancestor of the focused element that names a pane. */
function focusedPaneId(): PaneId | null {
  const id = document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
  return id === null || id === undefined ? null : asPaneId(id);
}

/** Reads the pane scrolled last (else the focused pane) for Command-I; Enter reads nothing. Either send starts a new scroll window. */
function contextFor(mode: SendMode, tracker: ScrollTracker): Capture | null {
  const paneId = tracker.choosePane(focusedPaneId());
  tracker.markMessageSent();
  if (mode === "plain") return null;
  if (paneId === null) throw new Error("no pane to read: scroll a pane or click into one, then press Command-I");
  const capture = captureContext(paneId);
  if (capture.elapsedMs > CAPTURE_BUDGET_MS) console.warn(`reading ${paneId} took ${capture.elapsedMs.toFixed(1)} ms, over the ${CAPTURE_BUDGET_MS} ms budget`);
  return capture;
}

export type Sender = Readonly<{
  /** Sends in `threadId`, or in a new thread of `provider` when null; `onThreadStarted` receives that new thread's id before the turn starts. */
  send: (provider: ProviderId, threadId: ThreadId | null, question: string, mode: SendMode, choice: ModelChoice, attachments: ReadonlyArray<AttachmentChip>, onThreadStarted: (threadId: ThreadId) => void) => Promise<boolean>;
  /** Sends the thread's last question again with the context it had; it reads the screen again for nobody. */
  retry: (threadId: ThreadId) => Promise<void>;
  isSending: (threadId: ThreadId | null) => boolean;
}>;

type LastSend = Readonly<{ provider: ProviderId; question: string; contextText: string | null; choice: ModelChoice; attachments: ReadonlyArray<AttachmentChip> }>;

export function useSender(api: MarginApi, store: ThreadStore, tracker: ScrollTracker, recorder: LatencyRecorder, report: (threadId: ThreadId | null, error: unknown) => void): Sender {
  const lastSent = useRef(new Map<ThreadId, LastSend>());
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
    async (provider: ProviderId, threadId: ThreadId | null, question: string, mode: SendMode, choice: ModelChoice, attachments: ReadonlyArray<AttachmentChip>, onThreadStarted: (threadId: ThreadId) => void): Promise<boolean> => {
      const key = threadId ?? NEW_CHAT_KEY;
      setPendingKey(key, true);
      let target = threadId;
      const startMs = performance.now();
      let mark: SendMark | null = null;
      try {
        const capture = contextFor(mode, tracker);
        const contextText = capture === null ? null : capture.text;
        if (capture !== null) mark = recorder.begin({ paneKind: capture.paneKind, blockCount: capture.blockCount, contextChars: capture.text.length, captureMs: capture.elapsedMs }, startMs);
        if (target === null) {
          target = await api.threadStart(provider);
          onThreadStarted(target);
        }
        lastSent.current.set(target, { provider, question, contextText, choice, attachments });
        const turnId = await api.turnStart(provider, target, question, contextText, choice, attachments.map((chip) => chip.id));
        mark?.acknowledged(turnId);
        store.begin(target, { turnId, question, attachments: attachments.map(({ name, kind }) => ({ name, kind })) });
        return true;
      } catch (error) {
        mark?.failed();
        report(target, error);
        return false;
      } finally {
        setPendingKey(key, false);
      }
    },
    [api, store, tracker, recorder, report, setPendingKey],
  );

  const retry = useCallback(
    async (threadId: ThreadId): Promise<void> => {
      const last = lastSent.current.get(threadId);
      if (last === undefined) return report(threadId, new Error("nothing to retry in this chat; type the question again"));
      setPendingKey(threadId, true);
      try {
        const turnId = await api.turnStart(last.provider, threadId, last.question, last.contextText, last.choice, last.attachments.map((chip) => chip.id));
        store.begin(threadId, { turnId, question: last.question, attachments: last.attachments.map(({ name, kind }) => ({ name, kind })) });
      } catch (error) {
        report(threadId, error);
      } finally {
        setPendingKey(threadId, false);
      }
    },
    [api, store, report, setPendingKey],
  );

  return { send, retry, isSending: (threadId) => pending.has(threadId ?? NEW_CHAT_KEY) };
}
