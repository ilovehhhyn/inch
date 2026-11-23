// Draws one side chat: a forked thread with its own composer, whose answers stay in it.
import { useState, useSyncExternalStore, type ReactElement } from "react";

import type { ThreadId, TurnId } from "../../shared/provider-events";
import type { PaneId } from "../context/pane-id";
import type { ScrollTracker } from "../context/scroll-tracker";
import type { ThreadStore } from "../state/thread-store";
import { ChatPane } from "./ChatPane";
import { Composer, type ComposerPickers, type SendMode } from "./Composer";

export type SideChatPaneProps = Readonly<{
  paneId: PaneId;
  threadId: ThreadId;
  title: string;
  store: ThreadStore;
  tracker: ScrollTracker;
  isSending: boolean;
  onSend: (threadId: ThreadId, question: string, mode: SendMode) => Promise<boolean>;
  onInterrupt: (threadId: ThreadId, turnId: TurnId) => void;
  onRetry: (threadId: ThreadId) => void;
  onClose: (threadId: ThreadId) => void;
  pickers?: ComposerPickers;
}>;

export function SideChatPane({ paneId, threadId, title, store, tracker, isSending, onSend, onInterrupt, onRetry, onClose, pickers }: SideChatPaneProps): ReactElement {
  const view = useSyncExternalStore(store.subscribe, () => store.view(threadId));
  const [draft, setDraft] = useState("");
  return (
    <ChatPane paneId={paneId} threadId={threadId} label="Side chat" title={title} store={store} tracker={tracker} onRetry={() => onRetry(threadId)}>
      <button type="button" className="side-chat-close" aria-label="Close side chat" onClick={() => onClose(threadId)}>
        ×
      </button>
      <Composer
        label="Side chat message"
        placeholder="Reply in side chat"
        draft={draft}
        onDraftChange={setDraft}
        onSend={(question, mode) => onSend(threadId, question, mode)}
        onInterrupt={() => {
          if (view.activeTurn !== null) onInterrupt(threadId, view.activeTurn);
        }}
        busy={isSending || view.activeTurn !== null}
        {...(pickers === undefined ? {} : { pickers })}
      />
    </ChatPane>
  );
}
