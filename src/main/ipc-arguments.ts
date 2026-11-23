// Parses the untrusted arguments of IPC calls that carry more structure than a string.
import { parseContextBlock } from "../shared/context-format";

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
