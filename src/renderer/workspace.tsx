// Draws the signed-in window: the chat list, the main chat, the right panel of side chats, and sends the user's questions.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import type { AttachmentChip } from "../shared/attachment";
import type { MarginApi } from "../shared/ipc-contract";
import type { Layout } from "../shared/layout";
import { firstChoice, type ModelChoice, type ModelOption } from "../shared/models";
import type { ThreadId, TurnId } from "../shared/provider-events";
import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from "../shared/provider-id";
import { messagesAfterTurn, type ThreadSummary } from "../shared/thread-history";
import { ChatPane } from "./components/ChatPane";
import { Composer, type ComposerPickers, type SendMode } from "./components/Composer";
import { DiffPane } from "./components/DiffPane";
import { Sidebar } from "./components/Sidebar";
import { SideChatPane } from "./components/SideChatPane";
import { DIFF_PANE_ID, MAIN_PANE_ID, sidePaneId } from "./context/pane-id";
import { createScrollTracker } from "./context/scroll-tracker";
import { LatencyRecorder } from "./metrics";
import { EMPTY_THREAD } from "./state/thread-reducer";
import { ThreadStore } from "./state/thread-store";
import { useAttachments } from "./state/use-attachments";
import { useSender } from "./state/use-sender";

export type WorkspaceProps = Readonly<{
  api: MarginApi;
  draft: string;
  onDraftChange: (draft: string) => void;
  onManageAccounts: () => void;
  /** The providers that are signed in, in the order the window lists them; never empty. */
  providers: ReadonlyArray<ProviderId>;
  /** A provider reported that its account changed, such as an expired Claude sign-in; the window reads the accounts again. */
  onAccountChanged: () => void;
}>;

const NEW_CHAT_TITLE = "New chat";

function monotonicClock(): number {
  return performance.now();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickerProps(pickers: ComposerPickers | undefined): { pickers?: ComposerPickers } {
  return pickers === undefined ? {} : { pickers };
}

export function Workspace({ api, draft, onDraftChange, onManageAccounts, providers, onAccountChanged }: WorkspaceProps): ReactElement {
  const store = useMemo(() => new ThreadStore(), []);
  const tracker = useMemo(() => createScrollTracker(monotonicClock), []);
  const recorder = useMemo(() => new LatencyRecorder({ sink: (record) => api.metricsAppend(record), now: monotonicClock, wallClock: () => new Date() }), [api]);
  const [threads, setThreads] = useState<ReadonlyArray<ThreadSummary>>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [mainThread, setMainThread] = useState<ThreadId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosenProvider, setChosenProvider] = useState<ProviderId | null>(null);
  const [models, setModels] = useState<ReadonlyMap<ProviderId, ReadonlyArray<ModelOption>>>(new Map());
  /** The last choice of every chat the window knows, read from the chat's saved choice or set by the pickers. */
  const [choices, setChoices] = useState<ReadonlyMap<ThreadId, ModelChoice>>(new Map());
  /** The choice for the next new chat; null means the default of the new-chat provider. */
  /** Chats started in this window, with their provider, until the chat list reports them. */
  const [startedChats, setStartedChats] = useState<ReadonlyMap<ThreadId, ProviderId>>(new Map());
  const [newChatChoice, setNewChatChoice] = useState<ModelChoice | null>(null);
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
  const mainAttachments = useAttachments(api);
  const sender = useSender(api, store, tracker, recorder, report);
  const firstProvider = providers[0];
  if (firstProvider === undefined) throw new Error("no provider is signed in; the window shows the sign-in page then");
  /** A chosen provider that has since signed out gives way to the first one that is still signed in. */
  const newChatProvider = chosenProvider !== null && providers.includes(chosenProvider) ? chosenProvider : firstProvider;

  const rememberChoice = useCallback((threadId: ThreadId, choice: ModelChoice): void => {
    setChoices((previous) => new Map(previous).set(threadId, choice));
  }, []);

  const providerKey = providers.join(",");
  useEffect(() => {
    for (const provider of providerKey.split(",").filter((id): id is ProviderId => PROVIDER_IDS.some((known) => known === id))) {
      api.modelsList(provider).then(
        (listed) => setModels((previous) => new Map(previous).set(provider, listed)),
        (error: unknown) => setProblem(`Could not list ${PROVIDER_NAMES[provider]} models: ${messageOf(error)}`),
      );
    }
  }, [api, providerKey]);

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
      if (event.type === "accountChanged") onAccountChanged();
      recorder.observe(event);
      store.apply(event);
      if (event.type === "completed") refreshThreads();
    });
  }, [api, store, recorder, refreshThreads, applyLayout, onAccountChanged]);

  const mainTurnIds = useMemo(() => new Set(mainView.messages.map((message) => message.turnId)), [mainView.messages]);
  const visibleSideChats = useMemo(() => (layout?.sideChats ?? []).filter((chat) => mainTurnIds.has(chat.forkedFromTurn)), [layout, mainTurnIds]);

  useEffect(() => {
    for (const chat of visibleSideChats) {
      if (store.isLoaded(chat.threadId) || openingSideChats.current.has(chat.threadId)) continue;
      openingSideChats.current.add(chat.threadId);
      threadProviders.current.set(chat.threadId, chat.provider);
      api.choiceRead(chat.threadId).then(
        (stored) => (stored === null ? undefined : rememberChoice(chat.threadId, stored)),
        (error: unknown) => store.reportError(chat.threadId, `Could not read the saved model choice: ${messageOf(error)}`),
      );
      api
        .threadOpen(chat.provider, chat.threadId)
        .then((history) => store.load(chat.threadId, messagesAfterTurn(history, chat.forkedFromTurn)))
        .catch((error: unknown) => store.reportError(chat.threadId, messageOf(error)))
        .finally(() => openingSideChats.current.delete(chat.threadId));
    }
  }, [api, store, visibleSideChats, rememberChoice]);

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

  function readStoredChoice(threadId: ThreadId): void {
    api.choiceRead(threadId).then(
      (stored) => (stored === null ? undefined : rememberChoice(threadId, stored)),
      (error: unknown) => report(threadId, new Error(`Could not read the saved model choice: ${messageOf(error)}`)),
    );
  }

  function select(threadId: ThreadId): void {
    setMainThread(threadId);
    setProblem(null);
    readStoredChoice(threadId);
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
  async function sendIn(threadId: ThreadId | null, question: string, mode: SendMode, chips: ReadonlyArray<AttachmentChip>): Promise<boolean> {
    let provider: ProviderId;
    try {
      provider = threadId === null ? newChatProvider : providerOfThread(threadId);
    } catch (error) {
      report(threadId, error);
      return false;
    }
    let choice = choiceOf(threadId);
    if (choice === null) {
      try {
        choice = choiceOf(threadId, await api.modelsList(provider)); // the list is still loading: wait for it instead of sending without a model
      } catch (error) {
        report(threadId, new Error(`Could not list ${PROVIDER_NAMES[provider]} models: ${messageOf(error)}`));
        return false;
      }
    }
    if (choice === null) {
      report(threadId, new Error(`${PROVIDER_NAMES[provider]} offers no models; sign in again, or restart Margin if this stays`));
      return false;
    }
    const chosen = choice;
    return sender.send(provider, threadId, question, mode, chosen, chips, (started) => {
      threadProviders.current.set(started, provider);
      setStartedChats((previous) => new Map(previous).set(started, provider));
      rememberChoice(started, chosen);
      setMainThread(started);
    });
  }

  /** The provider of a chat on screen, read from state only (not the ref map, which render must not read); null when the chat is not known yet. */
  function providerOfShown(threadId: ThreadId | null): ProviderId | null {
    if (threadId === null) return newChatProvider;
    return visibleSideChats.find((chat) => chat.threadId === threadId)?.provider ?? threads.find((thread) => thread.id === threadId)?.provider ?? startedChats.get(threadId) ?? null;
  }

  function modelsOfShown(threadId: ThreadId | null): ReadonlyArray<ModelOption> {
    const provider = providerOfShown(threadId);
    return provider === null ? [] : (models.get(provider) ?? []);
  }

  /** The chat's own choice, else (for a side chat) the main chat's, else the provider's default; null while the model list is loading. */
  function choiceOf(threadId: ThreadId | null, list: ReadonlyArray<ModelOption> = modelsOfShown(threadId)): ModelChoice | null {
    if (threadId === null) return firstChoice(list, [newChatChoice]);
    const isSideChat = visibleSideChats.some((chat) => chat.threadId === threadId);
    const mainChoice = mainThread === null ? newChatChoice : (choices.get(mainThread) ?? null);
    return firstChoice(list, [choices.get(threadId) ?? null, isSideChat ? mainChoice : null]);
  }

  function pickersFor(threadId: ThreadId | null): ComposerPickers | undefined {
    const provider = providerOfShown(threadId);
    const list = provider === null ? undefined : models.get(provider);
    const choice = choiceOf(threadId);
    if (list === undefined || choice === null) return undefined;
    const onChoiceChange = (next: ModelChoice): void => (threadId === null ? setNewChatChoice(next) : rememberChoice(threadId, next));
    const providerChoice = threadId === null && providers.length > 1 ? { providers, selected: newChatProvider, onChange: (next: ProviderId) => { setChosenProvider(next); setNewChatChoice(null); } } : undefined;
    return { models: list, choice, onChoiceChange, ...(providerChoice === undefined ? {} : { provider: providerChoice }) };
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
            onSend={async (question, mode) => {
              const wasSent = await sendIn(mainThread, question, mode, mainAttachments.chips);
              if (wasSent) mainAttachments.clear();
              return wasSent;
            }}
            attachments={{ chips: mainAttachments.chips, onAdd: mainAttachments.add, onRemove: mainAttachments.remove }}
            onInterrupt={() => {
              if (mainThread !== null && mainView.activeTurn !== null) interrupt(mainThread, mainView.activeTurn);
            }}
            busy={sender.isSending(mainThread) || mainView.activeTurn !== null}
            {...pickerProps(pickersFor(mainThread))}
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
              {...pickerProps(pickersFor(chat.threadId))}
              onSend={(threadId, question, mode, chips) => sendIn(threadId, question, mode, chips)}
              api={api}
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
