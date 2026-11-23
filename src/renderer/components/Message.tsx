// Draws one message: the user's text as a bubble, the assistant's answer as markdown with no logo and no name.
import { useContext, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import type { TurnId } from "../../shared/provider-events";
import type { DisplayMessage } from "../state/thread-reducer";
import { AnswerReaderContext } from "../voice/read-aloud-context";
import { AttachmentChips } from "./AttachmentChips";

export type MessageProps = Readonly<{
  message: DisplayMessage;
  /** The message's 1-based position in its thread; it names the message in the context label. */
  position: number;
  onOpenSideChat?: (turnId: TurnId) => void;
}>;

type BlockProps = Readonly<{ children?: ReactNode }>;

/** Markdown elements that count as one readable block in the context; `label` names the message they belong to. */
function markdownComponents(label: string): Components {
  const marks = { "data-context-block": "", "data-context-label": label };
  const heading = { ...marks, "data-context-heading": "" };
  return {
    p: ({ children }: BlockProps) => <p {...marks}>{children}</p>,
    li: ({ children }: BlockProps) => <li {...marks}>{children}</li>,
    pre: ({ children }: BlockProps) => <pre {...marks}>{children}</pre>,
    h1: ({ children }: BlockProps) => <h1 {...heading}>{children}</h1>,
    h2: ({ children }: BlockProps) => <h2 {...heading}>{children}</h2>,
    h3: ({ children }: BlockProps) => <h3 {...heading}>{children}</h3>,
    h4: ({ children }: BlockProps) => <h4 {...heading}>{children}</h4>,
    h5: ({ children }: BlockProps) => <h5 {...heading}>{children}</h5>,
    h6: ({ children }: BlockProps) => <h6 {...heading}>{children}</h6>,
  };
}

export function Message({ message, position, onOpenSideChat }: MessageProps): ReactElement {
  const reader = useContext(AnswerReaderContext);
  const label = `message ${position} (${message.role})`;
  if (message.role === "user") {
    return (
      <div className="u" data-context-block="" data-context-label={label}>
        {message.attachments === undefined ? null : <AttachmentChips chips={message.attachments} />}
        {message.text}
      </div>
    );
  }
  const canOpenSideChat = onOpenSideChat !== undefined && message.status === "done";
  return (
    <article className="a" data-context-scope="">
      {message.status === "streaming" && message.text === "" ? <span className="pending" role="status" aria-label="Thinking" /> : null}
      <ReactMarkdown components={markdownComponents(label)}>{message.text}</ReactMarkdown>
      {reader === null || message.status !== "done" || message.text === "" ? null : (
        <button type="button" className="speaker-button" onClick={() => reader.toggle(message.id, message.text)}>
          {reader.speakingId === message.id ? "Stop reading" : "Read answer aloud"}
        </button>
      )}
      {canOpenSideChat ? (
        <button type="button" className="side-chat-button" onClick={() => onOpenSideChat(message.turnId)}>
          Open side chat
        </button>
      ) : null}
    </article>
  );
}
