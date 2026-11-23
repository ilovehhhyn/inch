// Turns provider events into the messages one thread displays; pure, so tests need no provider.
import type { ProviderEvent, TurnId } from "../../shared/provider-events";

export type DisplayMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "done" | "failed";
}>;

export type ThreadView = Readonly<{
  messages: ReadonlyArray<DisplayMessage>;
  activeTurn: TurnId | null;
  error: string | null;
}>;

export const EMPTY_THREAD: ThreadView = { messages: [], activeTurn: null, error: null };

const NO_REASON = "The turn failed without a reason from the provider";

function assistantId(turnId: TurnId): string {
  return `${turnId}:assistant`;
}

/** Adds the user's message and an empty streaming answer, and makes `turnId` the one turn that may change them. */
export function beginTurn(view: ThreadView, turn: Readonly<{ turnId: TurnId; question: string }>): ThreadView {
  if (view.activeTurn !== null) throw new Error(`turn ${view.activeTurn} is still active; wait for it or interrupt it`);
  return {
    messages: [
      ...view.messages,
      { id: `${turn.turnId}:user`, role: "user", text: turn.question, status: "done" },
      { id: assistantId(turn.turnId), role: "assistant", text: "", status: "streaming" },
    ],
    activeTurn: turn.turnId,
    error: null,
  };
}

function updateAssistant(view: ThreadView, turnId: TurnId, change: (message: DisplayMessage) => DisplayMessage): ThreadView["messages"] {
  const target = assistantId(turnId);
  return view.messages.map((message) => (message.id === target ? change(message) : message));
}

/** Applies one provider event; an event for any turn other than the active one returns `view` unchanged. */
export function reduceThread(view: ThreadView, event: ProviderEvent): ThreadView {
  switch (event.type) {
    case "delta":
      if (event.turnId !== view.activeTurn) return view;
      return { ...view, messages: updateAssistant(view, event.turnId, (message) => ({ ...message, text: message.text + event.text })) };
    case "completed":
      if (event.turnId !== view.activeTurn) return view;
      if (event.status === "completed" || event.status === "interrupted") {
        return { messages: updateAssistant(view, event.turnId, (message) => ({ ...message, status: "done" })), activeTurn: null, error: null };
      }
      return {
        messages: updateAssistant(view, event.turnId, (message) => ({ ...message, status: "failed" })),
        activeTurn: null,
        error: event.error ?? NO_REASON,
      };
    case "accountChanged":
      return view;
    default:
      return assertNever(event);
  }
}

function assertNever(event: never): never {
  throw new Error(`unhandled provider event ${JSON.stringify(event)}`);
}
