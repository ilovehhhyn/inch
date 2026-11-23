// Holds the displayed view of every open thread and feeds provider events to the reducer, including events that outrun their turn.
import type { HistoryMessage } from "../../shared/thread-history";
import type { ProviderEvent, ThreadId, TurnId } from "../../shared/provider-events";
import { beginTurn, EMPTY_THREAD, reduceThread, type ThreadView } from "./thread-reducer";

export type TurnStart = Readonly<{ turnId: TurnId; question: string }>;

export class ThreadStore {
  private readonly views = new Map<ThreadId, ThreadView>();
  private readonly loaded = new Set<ThreadId>();
  /** Events for a turn the window has not begun yet: the app-server can stream before `turn/start` has answered the window. */
  private readonly early = new Map<TurnId, Array<ProviderEvent>>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The same object is returned until the thread changes, as `useSyncExternalStore` requires. */
  view(threadId: ThreadId): ThreadView {
    return this.views.get(threadId) ?? EMPTY_THREAD;
  }

  isLoaded(threadId: ThreadId): boolean {
    return this.loaded.has(threadId);
  }

  load(threadId: ThreadId, history: ReadonlyArray<HistoryMessage>): void {
    const messages = history.map((message) => ({ id: `${message.turnId}:${message.role}`, turnId: message.turnId, role: message.role, text: message.text, status: message.status }));
    this.views.set(threadId, { messages, activeTurn: null, error: null });
    this.loaded.add(threadId);
    this.notify();
  }

  /** Adds the question and replays every event that arrived for the turn before this call. */
  begin(threadId: ThreadId, turn: TurnStart): void {
    let view = beginTurn(this.view(threadId), turn);
    for (const event of this.early.get(turn.turnId) ?? []) view = reduceThread(view, event);
    this.early.delete(turn.turnId);
    this.views.set(threadId, view);
    this.loaded.add(threadId);
    this.notify();
  }

  apply(event: ProviderEvent): void {
    if (event.type === "accountChanged") return;
    const view = this.view(event.threadId);
    if (view.activeTurn === null && !view.messages.some((message) => message.turnId === event.turnId)) {
      this.early.set(event.turnId, [...(this.early.get(event.turnId) ?? []), event]);
      return;
    }
    const next = reduceThread(view, event);
    if (next === view) return;
    this.views.set(event.threadId, next);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
