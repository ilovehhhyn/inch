// Lists the user's chats and starts a new one.
import type { ReactElement } from "react";

import type { StartupErrorInfo } from "../../shared/startup-error";
import type { ThreadId } from "../../shared/provider-events";
import type { ThreadSummary } from "../../shared/thread-history";

export type SidebarProps = Readonly<{
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  onNewChat: () => void;
  onManageAccounts: () => void;
  /** Why Codex chats are unavailable, or null; shown above the chats with a Retry, while Claude chats stay usable. */
  codexProblem: StartupErrorInfo | null;
  onRetryCodex: () => void;
  /** The setting that reads the answer to every spoken question aloud. */
  readAloud: Readonly<{ isOn: boolean; onChange: (isOn: boolean) => void }>;
}>;

export function Sidebar({ threads, selectedId, onSelect, onNewChat, onManageAccounts, codexProblem, onRetryCodex, readAloud }: SidebarProps): ReactElement {
  return (
    <nav className="sidebar" aria-label="Chats">
      <button type="button" className="side-item" onClick={onNewChat}>
        + New chat
      </button>
      {codexProblem === null ? null : (
        <div className="side-item problem">
          <span className="side-problem" role="alert">Codex is unavailable: {codexProblem.message}. Fix: {codexProblem.fix}</span>
          <button type="button" className="retry-button" onClick={onRetryCodex}>
            Retry Codex
          </button>
        </div>
      )}
      {threads.map((thread) =>
        thread.problem === undefined ? (
          <button key={thread.id} type="button" className={thread.id === selectedId ? "side-item on" : "side-item"} aria-current={thread.id === selectedId ? "page" : undefined} onClick={() => onSelect(thread.id)}>
            {thread.title}
          </button>
        ) : (
          <div key={thread.id} className="side-item problem">
            <span>{thread.title}</span>
            <span className="side-problem" role="alert">{thread.problem}</span>
          </div>
        ),
      )}
      <label className="read-aloud-setting">
        <input type="checkbox" checked={readAloud.isOn} onChange={(event) => readAloud.onChange(event.target.checked)} />
        Read spoken answers aloud
      </label>
      <button type="button" className="side-item" onClick={onManageAccounts}>
        Accounts
      </button>
    </nav>
  );
}
