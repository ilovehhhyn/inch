// Sends a question to a thread: reads the screen context when asked, starts the thread when needed, and tracks which threads are mid-send.
import { useCallback, useRef, useState } from "react";

import type { AttachmentChip } from "../../shared/attachment";
import type { MarginApi } from "../../shared/ipc-contract";
import type { ModelChoice } from "../../shared/models";
import type { ThreadId, TurnId } from "../../shared/provider-events";
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

/** Reads the pane scrolled last (else the focused pane); `choosePane` has no side effect, so a read that is never sent leaves the scroll window as it was. */
function readContext(tracker: ScrollTracker): Capture {
  const paneId = tracker.choosePane(focusedPaneId());
  if (paneId === null) throw new Error("no pane to read: scroll a pane or click into one, then press Command-I");
  const capture = captureContext(paneId);
  if (capture.elapsedMs > CAPTURE_BUDGET_MS) console.warn(`reading ${paneId} took ${capture.elapsedMs.toFixed(1)} ms, over the ${CAPTURE_BUDGET_MS} ms budget`);
  return capture;
}

/** Reads for Command-I; Enter reads nothing. Either send starts a new scroll window. */
function contextFor(mode: SendMode, tracker: ScrollTracker): Capture | null {
  const capture = mode === "plain" ? null : readContext(tracker);
  tracker.markMessageSent();
  return capture;
}

/** The read a spoken message makes when its key goes down, because that is when the person was reading; the scroll window is reset only when the message is sent. */
export function captureForSpeech(tracker: ScrollTracker): Capture {
  return readContext(tracker);
}

/** A spoken message was read earlier; sending it starts the new scroll window, as any send does. */
function resetAfterSpeech(capture: Capture, tracker: ScrollTracker): Capture {
  tracker.markMessageSent();
  return capture;
}

/** One send. `capture` is a context read earlier (a spoken message reads at key down); without it Command-I reads now. */
export type SendRequest = Readonly<{
  provider: ProviderId;
  /** The chat to send in, or null to start a new chat of `provider`; `onThreadStarted` receives that chat's id before the turn starts. */
  threadId: ThreadId | null;
  question: string;
  mode: SendMode;
  choice: ModelChoice;
  attachments: ReadonlyArray<AttachmentChip>;
  capture?: Capture;
  onThreadStarted: (threadId: ThreadId) => void;
  /** Receives the id of the turn once the provider accepted it. */
  onTurnStarted?: (turnId: TurnId) => void;
}>;

export type Sender = Readonly<{
  send: (request: SendRequest) => Promise<boolean>;
  /** Sends the thread's last question again with the context it had; it reads the screen again for nobody. */
  retry: (threadId: ThreadId) => Promise<void>;
  isSending: (threadId: ThreadId | null) => boolean;
}>;

type LastSend = Readonly<{ provider: ProviderId; question: string; contextText: string | null; choice: ModelChoice; attachments: ReadonlyArray<AttachmentChip> }>;

export function useSender(api: MarginApi, store: ThreadStore, tracker: ScrollTracker, recorder: LatencyRecorder, report: (threadId: ThreadId | null, error: unknown) => void): Sender {
  const lastSent = useRef(new Map<ThreadId, LastSend>());
  /** Chats with a retry in flight; state would update too late to stop a double click. */
  const retrying = useRef(new Set<ThreadId>());
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
    async (request: SendRequest): Promise<boolean> => {
      const { provider, question, choice, attachments } = request;
      const key = request.threadId ?? NEW_CHAT_KEY;
      setPendingKey(key, true);
      let target = request.threadId;
      const startMs = performance.now();
      let mark: SendMark | null = null;
      try {
        const capture = request.capture === undefined ? contextFor(request.mode, tracker) : resetAfterSpeech(request.capture, tracker);
        const contextText = capture === null ? null : capture.text;
        if (capture !== null) mark = recorder.begin({ paneKind: capture.paneKind, blockCount: capture.blockCount, contextChars: capture.text.length, captureMs: capture.elapsedMs }, startMs);
        if (target === null) {
          target = await api.threadStart(provider);
          request.onThreadStarted(target);
        }
        lastSent.current.set(target, { provider, question, contextText, choice, attachments });
        const turnId = await api.turnStart(provider, target, question, contextText, choice, attachments.map((chip) => chip.id));
        mark?.acknowledged(turnId);
        store.begin(target, { turnId, question, attachments: attachments.map(({ name, kind }) => ({ name, kind })) });
        request.onTurnStarted?.(turnId);
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
      if (retrying.current.has(threadId) || store.view(threadId).activeTurn !== null) return; // a second click while a retry or an answer is in flight starts nothing
      retrying.current.add(threadId);
      setPendingKey(threadId, true);
      try {
        const turnId = await api.turnStart(last.provider, threadId, last.question, last.contextText, last.choice, last.attachments.map((chip) => chip.id));
        store.begin(threadId, { turnId, question: last.question, attachments: last.attachments.map(({ name, kind }) => ({ name, kind })) });
      } catch (error) {
        report(threadId, error);
      } finally {
        retrying.current.delete(threadId);
        setPendingKey(threadId, false);
      }
    },
    [api, store, report, setPendingKey],
  );

  return { send, retry, isSending: (threadId) => pending.has(threadId ?? NEW_CHAT_KEY) };
}
