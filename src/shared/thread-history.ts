// Describes a stored thread in the form the window shows: its messages and its entry in the chat list.
import type { ProviderId } from "./provider-id";
import type { ThreadId, TurnId } from "./provider-events";

/** One stored message; the user's text here is the question only, never the screen context. */
export type DisplayMessage = Readonly<{
  turnId: TurnId;
  role: "user" | "assistant";
  text: string;
  status: "done" | "failed";
}>;

export type ThreadSummary = Readonly<{ id: ThreadId; provider: ProviderId; title: string; updatedAtSec: number }>;

/** The messages of a forked thread that came after `forkedFromTurn`; the earlier ones are copies of the parent's turns. */
export function messagesAfterTurn(history: ReadonlyArray<DisplayMessage>, forkedFromTurn: TurnId): ReadonlyArray<DisplayMessage> {
  const lastInherited = history.findLastIndex((message) => message.turnId === forkedFromTurn);
  if (lastInherited === -1) throw new Error(`the side chat history does not contain turn ${forkedFromTurn}; open the chat it was forked from or close this side chat`);
  return history.slice(lastInherited + 1);
}
