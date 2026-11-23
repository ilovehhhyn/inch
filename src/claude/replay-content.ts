// Decides which blocks of a stored assistant turn are sent back to the Messages API, following the documented rule for turns that ended with a fallback.
import type Anthropic from "@anthropic-ai/sdk";

type Block = Anthropic.Beta.BetaContentBlock;

/**
 * Bundled reference, `model-migration.md` "Echoing fallback turns back": after a mid-output fallback, `thinking`,
 * `redacted_thinking`, `tool_use`, an unpaired `server_tool_use` and any unrecognised model-internal block that come
 * before the final `fallback` block are left out. Text, the `fallback` blocks themselves (kept in place) and everything
 * after the final one are sent as they are. Margin sends no tools, so a block before the boundary is kept only when it is
 * text or a `fallback` block.
 */
export function contentForReplay(content: ReadonlyArray<Block>): Array<Block> {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary === -1) return [...content];
  return content.filter((block, index) => index >= boundary || block.type === "text" || block.type === "fallback");
}
