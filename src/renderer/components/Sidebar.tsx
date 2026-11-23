// Lists the user's chats and starts a new one.
import type { ReactElement } from "react";

import type { ThreadId } from "../../shared/provider-events";
import type { ThreadSummary } from "../../shared/thread-history";

export type SidebarProps = Readonly<{
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  onNewChat: () => void;
  onManageAccounts: () => void;
}>;

export function Sidebar({ threads, selectedId, onSelect, onNewChat, onManageAccounts }: SidebarProps): ReactElement {
  return (
    <nav className="sidebar" aria-label="Chats">
      <button type="button" className="side-item" onClick={onNewChat}>
        + New chat
      </button>
      {threads.map((thread) => (
        <button key={thread.id} type="button" className={thread.id === selectedId ? "side-item on" : "side-item"} aria-current={thread.id === selectedId ? "page" : undefined} onClick={() => onSelect(thread.id)}>
          {thread.title}
        </button>
      ))}
      <button type="button" className="side-item" onClick={onManageAccounts}>
        Accounts
      </button>
    </nav>
  );
}
