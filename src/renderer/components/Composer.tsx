// Holds the text the user is typing and turns Enter, Command-I and Escape into send and interrupt requests; the draft lives in the parent.
import { useState, type KeyboardEvent, type ReactElement } from "react";

export type SendMode = "plain" | "withContext";

export const BUSY_HINT = "Wait for the answer, or press Esc to stop it";
export const EMPTY_HINT = "Type a question first";

export type ComposerProps = Readonly<{
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: (question: string, mode: SendMode) => void;
  onInterrupt: () => void;
  /** True while an answer streams: every send is refused and nothing is queued. */
  busy: boolean;
  placeholder?: string;
  /** The accessible name of the text box; the main composer and each side chat composer need different ones. */
  label?: string;
}>;

function sendModeOf(event: KeyboardEvent<HTMLTextAreaElement>): SendMode | null {
  const isComposing = event.nativeEvent.isComposing;
  if (isComposing) return null;
  const isCommandI = event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "i";
  if (isCommandI) return "withContext";
  if (event.key === "Enter" && !event.shiftKey) return "plain";
  return null;
}

export function Composer({ draft, onDraftChange, onSend, onInterrupt, busy, placeholder = "Ask anything", label = "Message" }: ComposerProps): ReactElement {
  const [hint, setHint] = useState<string | null>(null);

  function trySend(mode: SendMode): void {
    const question = draft.trim();
    if (busy) return setHint(BUSY_HINT);
    if (question === "") return setHint(EMPTY_HINT);
    setHint(null);
    onDraftChange("");
    onSend(question, mode);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      onInterrupt();
      return;
    }
    const mode = sendModeOf(event);
    if (mode === null) return;
    event.preventDefault();
    trySend(mode);
  }

  return (
    <div className="composer">
      <textarea
        aria-label={label}
        className="composer-input"
        rows={1}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setHint(null);
          onDraftChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
      />
      <button type="button" className="send" aria-label="Send" onClick={() => trySend("plain")}>
        ↑
      </button>
      {hint === null ? null : (
        <p className="composer-hint" role="status">
          {hint}
        </p>
      )}
    </div>
  );
}
