// Draws one side chat: a forked thread with its own composer, whose answers stay in it.
import { useState, useSyncExternalStore, type ReactElement } from "react";

import type { AttachmentChip } from "../../shared/attachment";
import type { MarginApi } from "../../shared/ipc-contract";
import type { ThreadId, TurnId } from "../../shared/provider-events";
import type { PaneId } from "../context/pane-id";
import type { ScrollTracker } from "../context/scroll-tracker";
import { useAttachments } from "../state/use-attachments";
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
  onSend: (threadId: ThreadId, question: string, mode: SendMode, chips: ReadonlyArray<AttachmentChip>) => Promise<boolean>;
  api: MarginApi;
  onInterrupt: (threadId: ThreadId, turnId: TurnId) => void;
  onRetry: (threadId: ThreadId) => void;
  onClose: (threadId: ThreadId) => void;
  onSignInAgain: () => void;
  pickers?: ComposerPickers;
}>;

export function SideChatPane({ paneId, threadId, title, store, tracker, isSending, onSend, onInterrupt, onRetry, onClose, onSignInAgain, pickers, api }: SideChatPaneProps): ReactElement {
  const view = useSyncExternalStore(store.subscribe, () => store.view(threadId));
  const [draft, setDraft] = useState("");
  const attachments = useAttachments(api);
  return (
    <ChatPane paneId={paneId} threadId={threadId} label="Side chat" title={title} store={store} tracker={tracker} onRetry={() => onRetry(threadId)} onSignInAgain={onSignInAgain}>
      <button type="button" className="side-chat-close" aria-label="Close side chat" onClick={() => onClose(threadId)}>
        ×
      </button>
      <Composer
        label="Side chat message"
        placeholder="Reply in side chat"
        draft={draft}
        onDraftChange={setDraft}
        onSend={async (question, mode) => {
          const wasSent = await onSend(threadId, question, mode, attachments.chips);
          if (wasSent) attachments.clear();
          return wasSent;
        }}
        attachments={{ chips: attachments.chips, onAdd: attachments.add, onRemove: attachments.remove }}
        onInterrupt={() => {
          if (view.activeTurn !== null) onInterrupt(threadId, view.activeTurn);
        }}
        busy={isSending || view.activeTurn !== null}
        {...(pickers === undefined ? {} : { pickers })}
      />
    </ChatPane>
  );
}
