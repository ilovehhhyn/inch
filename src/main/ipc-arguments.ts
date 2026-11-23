// Parses the untrusted arguments of IPC calls that carry more structure than a string.
import { parseContextBlock, type ScreenContext } from "../shared/context-format";

/** The renderer keeps context under 12,000 characters (CONTEXT_BUDGET_CHARS); the bound leaves room for escapes and labels and stops a runaway value. */
export const MAX_CONTEXT_TEXT_CHARS = 64 * 1024;

/** Accepts null (a plain message) or a well-formed screen-context block no longer than the bound. */
export function parseContextText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`contextText must be a string or null, got ${typeof value}`);
  if (value.length > MAX_CONTEXT_TEXT_CHARS) throw new Error(`contextText must be at most ${MAX_CONTEXT_TEXT_CHARS} characters, got ${value.length}; the window must trim it to its budget`);
  if (parseContextBlock(value) === null) throw new Error("contextText must be a MARGIN SCREEN CONTEXT block; the window builds it with renderContextBlock");
  return value;
}

/** Accepts null or a well-formed block (see `parseContextText`) and returns the structured context the providers render themselves. */
export function parseScreenContext(value: unknown): ScreenContext | null {
  const text = parseContextText(value);
  if (text === null) return null;
  const context = parseContextBlock(text);
  if (context === null) throw new Error("contextText must be a MARGIN SCREEN CONTEXT block; the window builds it with renderContextBlock");
  return context;
}

/** The window may read the diff only of the folder the user chose and Margin saved. */
export function requireSavedDiffFolder(folder: string, saved: string | null): string {
  if (saved === null) throw new Error("no diff folder has been chosen; choose one with the folder button first");
  if (folder !== saved) throw new Error(`diff folder ${folder} is not the folder chosen in Margin (${saved}); choose it with the folder button`);
  return folder;
}
