// Describes a stored thread in the form the window shows: its messages and its entry in the chat list.
import type { ThreadId, TurnId } from "./provider-events";

/** One stored message; the user's text here is the question only, never the screen context. */
export type HistoryMessage = Readonly<{
  turnId: TurnId;
  role: "user" | "assistant";
  text: string;
  status: "done" | "failed";
}>;

export type ThreadSummary = Readonly<{ id: ThreadId; title: string; updatedAtSec: number }>;
