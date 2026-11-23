// Converts a stored Codex thread into the messages and chat-list entry the window shows, without running anything.
import { basename } from "node:path";

import { splitAttachmentBlocks, type AttachmentSummary } from "../shared/attachment";
import { CONTEXT_HEADER_LINE, splitContextBlock } from "../shared/context-format";
import { asThreadId, asTurnId } from "../shared/provider-events";
import type { DisplayMessage, ThreadSummary } from "../shared/thread-history";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { Turn } from "./generated/v2/Turn";
import type { UserInput } from "./generated/v2/UserInput";

const TITLE_MAX_CHARS = 60;
const EMPTY_TITLE = "New chat";
/** Answer items of one turn are separate paragraphs. */
const ANSWER_SEPARATOR = "\n\n";

function userInputs(items: ReadonlyArray<ThreadItem>): ReadonlyArray<UserInput> {
  return items.flatMap((item) => (item.type === "userMessage" ? item.content : []));
}

function userText(inputs: ReadonlyArray<UserInput>): string {
  return inputs.flatMap((input) => (input.type === "text" ? [input.text] : [])).join("");
}

/** Images are items of their own; a stored image path ends with the file's own name. */
function imageSummaries(inputs: ReadonlyArray<UserInput>): Array<AttachmentSummary> {
  return inputs.flatMap((input): Array<AttachmentSummary> => (input.type === "localImage" ? [{ kind: "image", name: basename(input.path) }] : []));
}

function answerText(items: ReadonlyArray<ThreadItem>): string {
  return items.flatMap((item) => (item.type === "agentMessage" ? [item.text] : [])).join(ANSWER_SEPARATOR);
}

/** The question the user typed: stored user text is the context block, a blank line, then the question. */
function questionOf(storedText: string): string {
  return splitContextBlock(storedText)?.question ?? storedText;
}

function turnMessages(turn: Turn): Array<DisplayMessage> {
  if (turn.status === "inProgress") throw new Error(`turn ${turn.id} is still in progress; wait for it to finish before opening the thread`);
  const turnId = asTurnId(turn.id);
  const inputs = userInputs(turn.items);
  const { attachments: textAttachments, rest } = splitAttachmentBlocks(userText(inputs));
  const attachments = [...imageSummaries(inputs), ...textAttachments];
  const messages: Array<DisplayMessage> = [{ turnId, role: "user", text: questionOf(rest), status: "done", ...(attachments.length === 0 ? {} : { attachments }) }];
  const answer = answerText(turn.items);
  if (answer !== "") messages.push({ turnId, role: "assistant", text: answer, status: turn.status === "failed" ? "failed" : "done" });
  return messages;
}

export function toHistory(thread: Thread): Array<DisplayMessage> {
  return thread.turns.flatMap(turnMessages);
}

/** The first line of the user's first question; a preview that starts a context block but is cut short has no question to show. */
function previewTitle(preview: string): string {
  const stored = splitContextBlock(preview);
  if (stored === null && preview.startsWith(CONTEXT_HEADER_LINE)) return "";
  return (stored?.question ?? preview).split("\n")[0]?.trim().slice(0, TITLE_MAX_CHARS) ?? "";
}

/** The chat-list entry: the thread's name, else the first line of its first question, else "New chat". */
export function summarizeThread(thread: Thread): ThreadSummary {
  const name = thread.name?.trim() ?? "";
  const title = [name, previewTitle(thread.preview)].find((candidate) => candidate !== "") ?? EMPTY_TITLE;
  return { id: asThreadId(thread.id), provider: "codex", title, updatedAtSec: thread.updatedAt };
}

/** The threads that belong in the chat list: forked side chats are left out, and the newest chat comes first. */
export function listChats(threads: ReadonlyArray<Thread>): Array<Thread> {
  return threads.filter((thread) => thread.forkedFromId === null).sort((left, right) => right.updatedAt - left.updatedAt);
}
