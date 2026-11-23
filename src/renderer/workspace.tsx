// Draws the signed-in window: the chat list, the main chat, the right panel of side chats, and sends the user's questions.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { MarginApi } from "../shared/ipc-contract";
import type { Layout } from "../shared/layout";
import type { ThreadId, TurnId } from "../shared/provider-events";
import { messagesAfterTurn, type ThreadSummary } from "../shared/thread-history";
import { ChatPane } from "./components/ChatPane";
import { Composer } from "./components/Composer";
import { DiffPane } from "./components/DiffPane";
import { Sidebar } from "./components/Sidebar";
import { SideChatPane } from "./components/SideChatPane";
import { DIFF_PANE_ID, MAIN_PANE_ID, sidePaneId } from "./context/pane-id";
import { createScrollTracker } from "./context/scroll-tracker";
import { EMPTY_THREAD } from "./state/thread-reducer";
import { ThreadStore } from "./state/thread-store";
import { useSender } from "./state/use-sender";

export type WorkspaceProps = Readonly<{
  api: MarginApi;
  draft: string;
  onDraftChange: (draft: string) => void;
}>;

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
  const [layout, setLayout] = useState<Layout | null>(null);
  const [mainThread, setMainThread] = useState<ThreadId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const openingSideChats = useRef(new Set<ThreadId>());
  const mainView = useSyncExternalStore(store.subscribe, () => (mainThread === null ? EMPTY_THREAD : store.view(mainThread)));

  const report = useCallback(
    (threadId: ThreadId | null, error: unknown): void => {
      if (threadId === null) setProblem(messageOf(error));
      else store.reportError(threadId, messageOf(error));
    },
    [store],
  );
  const sender = useSender(api, store, tracker, report);

  const refreshThreads = useCallback(() => {
    api.threadList().then(setThreads, (error: unknown) => setProblem(`Could not list chats: ${messageOf(error)}`));
  }, [api]);

  useEffect(() => {
    refreshThreads();
    api.layoutRead().then(setLayout, (error: unknown) => setProblem(`Could not read the saved layout: ${messageOf(error)}`));
    return api.onProviderEvent((event) => {
      store.apply(event);
      if (event.type === "completed") refreshThreads();
    });
  }, [api, store, refreshThreads]);

  const mainTurnIds = useMemo(() => new Set(mainView.messages.map((message) => message.turnId)), [mainView.messages]);
  const visibleSideChats = useMemo(() => (layout?.sideChats ?? []).filter((chat) => mainTurnIds.has(chat.forkedFromTurn)), [layout, mainTurnIds]);

  useEffect(() => {
    for (const chat of visibleSideChats) {
      if (store.isLoaded(chat.threadId) || openingSideChats.current.has(chat.threadId)) continue;
      openingSideChats.current.add(chat.threadId);
      api
        .threadOpen(chat.threadId)
        .then((history) => store.load(chat.threadId, messagesAfterTurn(history, chat.forkedFromTurn)))
        .catch((error: unknown) => store.reportError(chat.threadId, messageOf(error)))
        .finally(() => openingSideChats.current.delete(chat.threadId));
    }
  }, [api, store, visibleSideChats]);

  async function saveLayout(change: (current: Layout) => Layout): Promise<void> {
    if (layout === null) throw new Error("the saved layout could not be read, so Margin will not overwrite it; fix or delete layout.json in Margin's application support folder");
    const next = change(layout);
    await api.layoutWrite(next);
    setLayout(next);
  }

  async function openSideChat(turnId: TurnId): Promise<void> {
    if (mainThread === null) return;
    try {
      const forkId = await api.threadFork(mainThread, turnId);
      store.load(forkId, []);
      await saveLayout((current) => ({ ...current, sideChats: [...current.sideChats, { threadId: forkId, forkedFromTurn: turnId }] }));
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
    api.threadOpen(threadId).then(
      (history) => store.load(threadId, history),
      (error: unknown) => report(threadId, error),
    );
  }

  function interrupt(threadId: ThreadId, turnId: TurnId): void {
    api.turnInterrupt(threadId, turnId).catch((error: unknown) => report(threadId, error));
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
        <ChatPane paneId={MAIN_PANE_ID} threadId={mainThread} label="Chat" title={mainTitle} store={store} tracker={tracker} onOpenSideChat={(turnId) => void openSideChat(turnId)} {...(mainThread === null ? {} : { onRetry: () => void sender.retry(mainThread) })}>
          {problem === null ? null : <p className="thread-error" role="alert">{problem}</p>}
          <Composer
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={(question, mode) => void sender.send(mainThread, question, mode, setMainThread)}
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
              onSend={(threadId, question, mode) => void sender.send(threadId, question, mode, setMainThread)}
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
