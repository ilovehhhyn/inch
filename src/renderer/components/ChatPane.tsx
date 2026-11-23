// Draws one thread in a scrolling pane and follows the newest text only while the reader is at the bottom.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactElement, type ReactNode, type Ref } from "react";

import type { ThreadId, TurnId } from "../../shared/provider-events";
import type { PaneId } from "../context/pane-id";
import { registerPane } from "../context/pane-registry";
import type { ScrollTracker } from "../context/scroll-tracker";
import { readVisibleBlocks } from "../context/visible-blocks";
import type { ThreadStore } from "../state/thread-store";
import { Message } from "./Message";

/** A view within this distance of the end counts as "at the bottom", so a rounding gap does not stop the follow. */
export const BOTTOM_TOLERANCE_PX = 24;

export type ChatPaneProps = Readonly<{
  paneId: PaneId;
  threadId: ThreadId | null;
  /** Names the pane in the context block, for example the chat's title. */
  title: string;
  store: ThreadStore;
  tracker: ScrollTracker;
  onOpenSideChat?: (turnId: TurnId) => void;
  /** The composer of this pane: it sits inside the pane so keyboard focus there names the pane. */
  children?: ReactNode;
  /** Receives the scroll container, which the last-scrolled tracking reads. */
  ref?: Ref<HTMLDivElement>;
}>;

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_TOLERANCE_PX;
}

function assignRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement | null): void {
  if (typeof ref === "function") ref(element);
  else if (ref !== undefined && ref !== null) ref.current = element;
}

const NO_THREAD_VIEW = { messages: [], activeTurn: null, error: null } as const;

export function ChatPane({ paneId, threadId, title, store, tracker, onOpenSideChat, children, ref }: ChatPaneProps): ReactElement {
  const view = useSyncExternalStore(store.subscribe, () => (threadId === null ? NO_THREAD_VIEW : store.view(threadId)));
  const element = useRef<HTMLDivElement | null>(null);
  const followsBottom = useRef(true);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const titleRef = useRef(title);
  useLayoutEffect(() => {
    titleRef.current = title;
  }, [title]);

  useLayoutEffect(() => {
    const container = element.current;
    if (container === null) throw new Error("the scroll container must be mounted before the pane registers");
    const unregister = registerPane(paneId, () => readVisibleBlocks(container), "chat", { title: () => titleRef.current, viewportHeight: () => container.getBoundingClientRect().height });
    const detach = tracker.attach(paneId, container);
    return () => {
      detach();
      unregister();
    };
  }, [paneId, tracker]);

  useLayoutEffect(() => {
    followsBottom.current = true;
  }, [threadId]);

  useLayoutEffect(() => {
    const container = element.current;
    if (container !== null && followsBottom.current) container.scrollTop = container.scrollHeight;
  }, [view.messages, threadId]);

  return (
    <section className="chat-pane" data-pane-id={paneId} aria-label="Chat">
      <div
        className="view"
        ref={attach}
        tabIndex={0}
        onScroll={(event) => {
          followsBottom.current = isAtBottom(event.currentTarget);
        }}
      >
        <div className="thread">
          {view.messages.map((message, index) => (
            <Message key={message.id} message={message} position={index + 1} {...(onOpenSideChat === undefined ? {} : { onOpenSideChat })} />
          ))}
          {view.error === null ? null : <p className="thread-error" role="alert">{view.error}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}
