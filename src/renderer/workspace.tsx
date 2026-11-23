// Draws the signed-in window: the chat list, the main chat, the right panel of side chats, and sends the user's questions.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { MarginApi } from "../shared/ipc-contract";
import type { Layout } from "../shared/layout";
import type { ThreadId, TurnId } from "../shared/provider-events";
import type { ProviderId } from "../shared/provider-id";
import { messagesAfterTurn, type ThreadSummary } from "../shared/thread-history";
import { ChatPane } from "./components/ChatPane";
import { Composer, type SendMode } from "./components/Composer";
import { DiffPane } from "./components/DiffPane";
import { Sidebar } from "./components/Sidebar";
import { SideChatPane } from "./components/SideChatPane";
import { DIFF_PANE_ID, MAIN_PANE_ID, sidePaneId } from "./context/pane-id";
import { createScrollTracker } from "./context/scroll-tracker";
import { LatencyRecorder } from "./metrics";
import { EMPTY_THREAD } from "./state/thread-reducer";
import { ThreadStore } from "./state/thread-store";
import { useSender } from "./state/use-sender";

export type WorkspaceProps = Readonly<{
  api: MarginApi;
  draft: string;
  onDraftChange: (draft: string) => void;
  onManageAccounts: () => void;
}>;

const NEW_CHAT_TITLE = "New chat";

/** A new chat starts on this provider; the sidebar offers a choice once Claude can sign in. */
const NEW_CHAT_PROVIDER: ProviderId = "codex";

function monotonicClock(): number {
  return performance.now();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Workspace({ api, draft, onDraftChange, onManageAccounts }: WorkspaceProps): ReactElement {
  const store = useMemo(() => new ThreadStore(), []);
  const tracker = useMemo(() => createScrollTracker(monotonicClock), []);
  const recorder = useMemo(() => new LatencyRecorder({ sink: (record) => api.metricsAppend(record), now: monotonicClock, wallClock: () => new Date() }), [api]);
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary>>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [mainThread, setMainThread] = useState<ThreadId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const openingSideChats = useRef(new Set<ThreadId>());
  /** The provider of every chat the window knows: chats belong to one provider for good, and side chats use their parent's. */
  const threadProviders = useRef(new Map<ThreadId, ProviderId>());
  /** The newest layout, and the queue that applies changes to it one at a time, so overlapping saves never start from a stale copy. */
  const latestLayout = useRef<Layout | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mainView = useSyncExternalStore(store.subscribe, () => (mainThread === null ? EMPTY_THREAD : store.view(mainThread)));

  const report = useCallback(
    (threadId: ThreadId | null, error: unknown): void => {
      if (threadId === null) setProblem(messageOf(error));
      else store.reportError(threadId, messageOf(error));
    },
    [store],
  );
  const sender = useSender(api, store, tracker, recorder, report);

  const applyLayout = useCallback((next: Layout): void => {
    latestLayout.current = next;
    setLayout(next);
  }, []);

  const refreshThreads = useCallback(() => {
    api.threadList().then(
      (listed) => {
        for (const thread of listed) threadProviders.current.set(thread.id, thread.provider);
        setThreads(listed);
      },
      (error: unknown) => setProblem(`Could not list chats: ${messageOf(error)}`),
    );
  }, [api]);

  const providerOfThread = useCallback((threadId: ThreadId): ProviderId => {
    const provider = threadProviders.current.get(threadId);
    if (provider === undefined) throw new Error(`the provider of chat ${threadId} is not known; reopen the chat from the list`);
    return provider;
  }, []);

  useEffect(() => {
    refreshThreads();
    api.layoutRead().then(applyLayout, (error: unknown) => setProblem(`Could not read the saved layout: ${messageOf(error)}`));
    return api.onProviderEvent((event) => {
      recorder.observe(event);
      store.apply(event);
      if (event.type === "completed") refreshThreads();
    });
  }, [api, store, recorder, refreshThreads, applyLayout]);

  const mainTurnIds = useMemo(() => new Set(mainView.messages.map((message) => message.turnId)), [mainView.messages]);
  const visibleSideChats = useMemo(() => (layout?.sideChats ?? []).filter((chat) => mainTurnIds.has(chat.forkedFromTurn)), [layout, mainTurnIds]);

  useEffect(() => {
    for (const chat of visibleSideChats) {
      if (store.isLoaded(chat.threadId) || openingSideChats.current.has(chat.threadId)) continue;
      openingSideChats.current.add(chat.threadId);
      threadProviders.current.set(chat.threadId, chat.provider);
      api
        .threadOpen(chat.provider, chat.threadId)
        .then((history) => store.load(chat.threadId, messagesAfterTurn(history, chat.forkedFromTurn)))
        .catch((error: unknown) => store.reportError(chat.threadId, messageOf(error)))
        .finally(() => openingSideChats.current.delete(chat.threadId));
    }
  }, [api, store, visibleSideChats]);

  /** Applies `change` to the newest layout after every earlier save has finished, then writes it; the returned promise carries this save's own failure. */
  function saveLayout(change: (current: Layout) => Layout): Promise<void> {
    const run = saveQueue.current.then(async () => {
      const current = latestLayout.current;
      if (current === null) throw new Error("the saved layout could not be read, so Margin will not overwrite it; fix or delete layout.json in Margin's application support folder");
      const next = change(current);
      await api.layoutWrite(next);
      applyLayout(next);
    });
    saveQueue.current = run.catch(() => undefined); // this save's failure goes to its caller through `run`; the queue itself must keep going
    return run;
  }

  async function openSideChat(turnId: TurnId): Promise<void> {
    if (mainThread === null) return;
    try {
      const provider = providerOfThread(mainThread);
      const forkId = await api.threadFork(provider, mainThread, turnId);
      threadProviders.current.set(forkId, provider);
      store.load(forkId, []);
      await saveLayout((current) => ({ ...current, sideChats: [...current.sideChats, { provider, threadId: forkId, forkedFromTurn: turnId }] }));
    } catch (error) {
      report(mainThread, error);
    }
  }

  const loadDiff = useCallback((folder: string) => api.diffRead(folder), [api]);

  function chooseDiffFolder(): void {
    api
      .chooseDiffFolder()
      .then((folder) => (folder === null ? undefined : saveLayout((current) => ({ ...current, diffFolder: folder }))))
      .catch((error: unknown) => setProblem(messageOf(error)));
  }

  function closeSideChat(threadId: ThreadId): void {
    saveLayout((current) => ({ ...current, sideChats: current.sideChats.filter((chat) => chat.threadId !== threadId) })).catch((error: unknown) => report(mainThread, error));
  }

  function select(threadId: ThreadId): void {
    setMainThread(threadId);
    setProblem(null);
    if (store.isLoaded(threadId)) return;
    api.threadOpen(providerOfThread(threadId), threadId).then(
      (history) => store.load(threadId, history),
      (error: unknown) => report(threadId, error),
    );
  }

  function interrupt(threadId: ThreadId, turnId: TurnId): void {
    api.turnInterrupt(providerOfThread(threadId), threadId, turnId).catch((error: unknown) => report(threadId, error));
  }

  /** Sends in `threadId`, or starts a chat of the new-chat provider when null; the provider is looked up here so a missing one is shown, not thrown. */
  async function sendIn(threadId: ThreadId | null, question: string, mode: SendMode): Promise<boolean> {
    let provider: ProviderId;
    try {
      provider = threadId === null ? NEW_CHAT_PROVIDER : providerOfThread(threadId);
    } catch (error) {
      report(threadId, error);
      return false;
    }
    return sender.send(provider, threadId, question, mode, (started) => {
      threadProviders.current.set(started, provider);
      setMainThread(started);
    });
  }

  const mainTitle = threads.find((thread) => thread.id === mainThread)?.title ?? NEW_CHAT_TITLE;

  return (
    <main className="app" aria-label="Margin">
      <Sidebar
        threads={threads}
        onManageAccounts={onManageAccounts}
        selectedId={mainThread}
        onSelect={select}
        onNewChat={() => {
          setMainThread(null);
          setProblem(null);
        }}
      />
      <div className="main-col">
        <ChatPane paneId={MAIN_PANE_ID} threadId={mainThread} label="Chat" title={mainTitle} store={store} tracker={tracker} onOpenSideChat={(turnId) => void openSideChat(turnId)} {...(mainThread === null ? {} : { onRetry: () => void sender.retry(mainThread) })}>
          {problem === null ? null : <p className="thread-error" role="alert">{problem}</p>}
          <Composer
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={(question, mode) => sendIn(mainThread, question, mode)}
            onInterrupt={() => {
              if (mainThread !== null && mainView.activeTurn !== null) interrupt(mainThread, mainView.activeTurn);
            }}
            busy={sender.isSending(mainThread) || mainView.activeTurn !== null}
          />
        </ChatPane>
      </div>
      <aside className="side" style={{ width: layout?.panelWidthPx }}>
        <DiffPane paneId={DIFF_PANE_ID} tracker={tracker} folder={layout?.diffFolder ?? null} loadDiff={loadDiff} onChooseFolder={chooseDiffFolder} />
        <div className="side-chats">
          {visibleSideChats.map((chat) => (
            <SideChatPane
              key={chat.threadId}
              paneId={sidePaneId(chat.threadId)}
              threadId={chat.threadId}
              title={`Side chat on ${mainTitle}`}
              store={store}
              tracker={tracker}
              isSending={sender.isSending(chat.threadId)}
              onSend={(threadId, question, mode) => sendIn(threadId, question, mode)}
              onInterrupt={interrupt}
              onRetry={(threadId) => void sender.retry(threadId)}
              onClose={closeSideChat}
            />
          ))}
        </div>
      </aside>
    </main>
  );
}
