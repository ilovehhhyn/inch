// Draws the signed-in window: the chat list, the main chat and its composer, and sends the user's questions.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";

import type { MarginApi } from "../shared/ipc-contract";
import type { ThreadId } from "../shared/provider-events";
import type { ThreadSummary } from "../shared/thread-history";
import { ChatPane } from "./components/ChatPane";
import { Composer, type SendMode } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { captureContext, CAPTURE_BUDGET_MS } from "./context/capture-context";
import { asPaneId, MAIN_PANE_ID, type PaneId } from "./context/pane-id";
import { createScrollTracker } from "./context/scroll-tracker";
import { EMPTY_THREAD } from "./state/thread-reducer";
import { ThreadStore } from "./state/thread-store";

export type WorkspaceProps = Readonly<{
  api: MarginApi;
  draft: string;
  onDraftChange: (draft: string) => void;
}>;

/** The pane that holds keyboard focus: the nearest ancestor of the focused element that names a pane. */
function focusedPaneId(): PaneId | null {
  const id = document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id");
  return id === null || id === undefined ? null : asPaneId(id);
}

const NEW_CHAT_TITLE = "New chat";

function monotonicClock(): number {
  return performance.now();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Workspace({ api, draft, onDraftChange }: WorkspaceProps): ReactElement {
  const store = useMemo(() => new ThreadStore(), []);
  const tracker = useMemo(() => createScrollTracker(monotonicClock), []);
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary>>([]);
  const [mainThread, setMainThread] = useState<ThreadId | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const view = useSyncExternalStore(store.subscribe, () => (mainThread === null ? EMPTY_THREAD : store.view(mainThread)));

  const refreshThreads = useCallback(() => {
    api.threadList().then(setThreads, (error: unknown) => setProblem(`Could not list chats: ${messageOf(error)}`));
  }, [api]);

  useEffect(() => {
    refreshThreads();
    return api.onProviderEvent((event) => {
      store.apply(event);
      if (event.type === "completed") refreshThreads();
    });
  }, [api, store, refreshThreads]);

  function report(threadId: ThreadId | null, error: unknown): void {
    if (threadId === null) setProblem(messageOf(error));
    else store.reportError(threadId, messageOf(error));
  }

  /** Reads the pane scrolled last (else the focused pane) for Command-I; Enter reads nothing. Either send starts a new scroll window. */
  function contextFor(mode: SendMode): string | null {
    const paneId = tracker.choosePane(focusedPaneId());
    tracker.markMessageSent();
    if (mode === "plain") return null;
    if (paneId === null) throw new Error("no pane to read: scroll a pane or click into one, then press Command-I");
    const capture = captureContext(paneId);
    if (capture.elapsedMs > CAPTURE_BUDGET_MS) console.warn(`reading ${paneId} took ${capture.elapsedMs.toFixed(1)} ms, over the ${CAPTURE_BUDGET_MS} ms budget`);
    return capture.text;
  }

  async function send(question: string, mode: SendMode): Promise<void> {
    setProblem(null);
    setIsSending(true);
    let threadId = mainThread;
    try {
      const contextText = contextFor(mode);
      if (threadId === null) {
        threadId = await api.threadStart();
        setMainThread(threadId);
      }
      const turnId = await api.turnStart(threadId, question, contextText);
      store.begin(threadId, { turnId, question });
    } catch (error) {
      report(threadId, error);
    } finally {
      setIsSending(false);
    }
  }

  function select(threadId: ThreadId): void {
    setMainThread(threadId);
    setProblem(null);
    if (store.isLoaded(threadId)) return;
    api.threadOpen(threadId).then(
      (history) => store.load(threadId, history),
      (error: unknown) => report(threadId, error),
    );
  }

  function interrupt(): void {
    if (mainThread !== null && view.activeTurn !== null) void api.turnInterrupt(mainThread, view.activeTurn).catch((error: unknown) => report(mainThread, error));
  }

  const mainTitle = threads.find((thread) => thread.id === mainThread)?.title ?? NEW_CHAT_TITLE;

  return (
    <main className="app" aria-label="Margin">
      <Sidebar
        threads={threads}
        selectedId={mainThread}
        onSelect={select}
        onNewChat={() => {
          setMainThread(null);
          setProblem(null);
        }}
      />
      <div className="main-col">
        <ChatPane paneId={MAIN_PANE_ID} threadId={mainThread} title={mainTitle} store={store} tracker={tracker}>
          {problem === null ? null : <p className="thread-error" role="alert">{problem}</p>}
          <Composer draft={draft} onDraftChange={onDraftChange} onSend={(question, mode) => void send(question, mode)} onInterrupt={interrupt} busy={isSending || view.activeTurn !== null} />
        </ChatPane>
      </div>
    </main>
  );
}
