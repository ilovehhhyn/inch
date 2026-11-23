// Defines the saved window layout and parses it from untrusted data, rejecting unknown keys and other versions.
import { isAbsolute } from "node:path";

import { asThreadId, asTurnId, type ThreadId, type TurnId } from "./provider-events";

/** The right panel must stay wide enough to read a diff and narrow enough to leave the thread column (720 px) visible. */
export const MIN_PANEL_WIDTH_PX = 320;
export const MAX_PANEL_WIDTH_PX = 1200;
export const DEFAULT_PANEL_WIDTH_PX = 600;

export type SideChatEntry = Readonly<{ threadId: ThreadId; forkedFromTurn: TurnId }>;

export type Layout = Readonly<{
  version: 1;
  diffFolder: string | null;
  sideChats: ReadonlyArray<SideChatEntry>;
  panelWidthPx: number;
}>;

export const DEFAULT_LAYOUT: Layout = { version: 1, diffFolder: null, sideChats: [], panelWidthPx: DEFAULT_PANEL_WIDTH_PX };

const LAYOUT_KEYS: ReadonlyArray<string> = ["version", "diffFolder", "sideChats", "panelWidthPx"];
const SIDE_CHAT_KEYS: ReadonlyArray<string> = ["threadId", "forkedFromTurn"];

function invalid(source: string, problem: string): Error {
  return new Error(`layout ${source} ${problem}`);
}

function requireRecord(value: unknown, source: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(source, `${what} must be an object; delete the file to reset the layout`);
  return value as Record<string, unknown>; // checked above: a non-null, non-array object
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, source: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(source, `has unknown key \`${unknown[0]}\`; delete the file to reset the layout`);
}

function requireText(value: unknown, source: string, name: string): string {
  if (typeof value !== "string" || value === "") throw invalid(source, `${name} must be a non-empty string; delete the file to reset the layout`);
  return value;
}

function parseSideChat(value: unknown, source: string): SideChatEntry {
  const record = requireRecord(value, source, "a side chat entry");
  rejectUnknownKeys(record, SIDE_CHAT_KEYS, source);
  return { threadId: asThreadId(requireText(record["threadId"], source, "threadId")), forkedFromTurn: asTurnId(requireText(record["forkedFromTurn"], source, "forkedFromTurn")) };
}

/** Parses `value` into a Layout; `source` names the file so every message says where the bad data came from. */
export function parseLayout(value: unknown, source: string): Layout {
  const record = requireRecord(value, source, "the layout");
  rejectUnknownKeys(record, LAYOUT_KEYS, source);
  if (record["version"] !== 1) throw invalid(source, `has version ${JSON.stringify(record["version"])}; this Margin reads version 1, so delete the file to reset the layout`);
  const folder = record["diffFolder"];
  if (folder !== null && (typeof folder !== "string" || !isAbsolute(folder))) throw invalid(source, "diffFolder must be an absolute path or null; delete the file to reset the layout");
  const sideChats = record["sideChats"];
  if (!Array.isArray(sideChats)) throw invalid(source, "sideChats must be a list; delete the file to reset the layout");
  const width = record["panelWidthPx"];
  const isWidthValid = typeof width === "number" && Number.isInteger(width) && width >= MIN_PANEL_WIDTH_PX && width <= MAX_PANEL_WIDTH_PX;
  if (!isWidthValid) throw invalid(source, `panelWidthPx must be a whole number from ${MIN_PANEL_WIDTH_PX} to ${MAX_PANEL_WIDTH_PX}; delete the file to reset the layout`);
  return { version: 1, diffFolder: folder, sideChats: sideChats.map((entry) => parseSideChat(entry, source)), panelWidthPx: width };
}
