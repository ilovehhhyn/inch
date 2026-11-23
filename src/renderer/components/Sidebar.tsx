// Lists the user's chats and starts a new one.
import type { ReactElement } from "react";

import type { ThreadId } from "../../shared/provider-events";
import { PROVIDER_NAMES, type ProviderId } from "../../shared/provider-id";
import type { ThreadSummary } from "../../shared/thread-history";

export type SidebarProps = Readonly<{
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  onNewChat: () => void;
  onManageAccounts: () => void;
  /** The providers that are signed in; the choice below shows only when there are two. */
  providers: ReadonlyArray<ProviderId>;
  newChatProvider: ProviderId;
  onNewChatProviderChange: (provider: ProviderId) => void;
}>;

export function Sidebar({ threads, selectedId, onSelect, onNewChat, onManageAccounts, providers, newChatProvider, onNewChatProviderChange }: SidebarProps): ReactElement {
  return (
    <nav className="sidebar" aria-label="Chats">
      {providers.length < 2 ? null : (
        <label className="side-choice">
          New chats use
          <select value={newChatProvider} onChange={(event) => onNewChatProviderChange(providers.find((provider) => provider === event.target.value) ?? newChatProvider)}>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_NAMES[provider]}
              </option>
            ))}
          </select>
        </label>
      )}
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
