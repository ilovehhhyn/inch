// Draws one message: the user's text as a bubble, the assistant's answer as markdown with no logo and no name.
import type { ReactElement } from "react";
import ReactMarkdown from "react-markdown";

import type { TurnId } from "../../shared/provider-events";
import type { DisplayMessage } from "../state/thread-reducer";

export type MessageProps = Readonly<{
  message: DisplayMessage;
  onOpenSideChat?: (turnId: TurnId) => void;
}>;

export function Message({ message, onOpenSideChat }: MessageProps): ReactElement {
  if (message.role === "user") return <div className="u">{message.text}</div>;
  const canOpenSideChat = onOpenSideChat !== undefined && message.status === "done";
  return (
    <article className="a">
      {message.status === "streaming" && message.text === "" ? <span className="pending" role="status" aria-label="Thinking" /> : null}
      <ReactMarkdown>{message.text}</ReactMarkdown>
      {canOpenSideChat ? (
        <button type="button" className="side-chat-button" onClick={() => onOpenSideChat(message.turnId)}>
          Open side chat
        </button>
      ) : null}
    </article>
  );
}
