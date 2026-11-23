// Converts a stored Codex thread into the messages and chat-list entry the window shows, without running anything.
import { asThreadId, asTurnId } from "../shared/provider-events";
import type { HistoryMessage, ThreadSummary } from "../shared/thread-history";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { Turn } from "./generated/v2/Turn";

const TITLE_MAX_CHARS = 60;
const EMPTY_TITLE = "New chat";
/** Answer items of one turn are separate paragraphs. */
const ANSWER_SEPARATOR = "\n\n";

function userText(items: ReadonlyArray<ThreadItem>): string {
  return items.flatMap((item) => (item.type === "userMessage" ? item.content : [])).flatMap((input) => (input.type === "text" ? [input.text] : [])).join("");
}

function answerText(items: ReadonlyArray<ThreadItem>): string {
  return items.flatMap((item) => (item.type === "agentMessage" ? [item.text] : [])).join(ANSWER_SEPARATOR);
}

function turnMessages(turn: Turn): Array<HistoryMessage> {
  if (turn.status === "inProgress") throw new Error(`turn ${turn.id} is still in progress; wait for it to finish before opening the thread`);
  const turnId = asTurnId(turn.id);
  const messages: Array<HistoryMessage> = [{ turnId, role: "user", text: userText(turn.items), status: "done" }];
  const answer = answerText(turn.items);
  if (answer !== "") messages.push({ turnId, role: "assistant", text: answer, status: turn.status === "failed" ? "failed" : "done" });
  return messages;
}

export function toHistory(thread: Thread): Array<HistoryMessage> {
  return thread.turns.flatMap(turnMessages);
}

/** The chat-list entry: the thread's name, else the first line of its first message, else "New chat". */
export function summarizeThread(thread: Thread): ThreadSummary {
  const firstLine = thread.preview.split("\n")[0]?.trim() ?? "";
  const title = thread.name !== null && thread.name.trim() !== "" ? thread.name.trim() : firstLine === "" ? EMPTY_TITLE : firstLine.slice(0, TITLE_MAX_CHARS);
  return { id: asThreadId(thread.id), title, updatedAtSec: thread.updatedAt };
}
