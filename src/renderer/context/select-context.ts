// Chooses which visible blocks go into the context: the ones nearest the pane's vertical centre, within a character budget.
import { blockChars } from "../../shared/context-format";
import type { VisibleBlock } from "./visible-blocks";

/** About 3,000 tokens at four characters per token; Task 0 measured that this much context adds about one second to the first token. */
export const CONTEXT_BUDGET_CHARS = 12_000;

const TRUNCATION_MARK = "…[truncated]";

/** w = 1 - |c - h/2| / (h/2), where c is the centre of the block's visible part and h the viewport height; w is 1 at the centre and 0 at an edge. */
function weight(block: VisibleBlock, viewportHeight: number): number {
  const centre = (block.top + block.bottom) / 2;
  return 1 - Math.abs(centre - viewportHeight / 2) / (viewportHeight / 2);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Cuts the text so the block fits in `maxChars` and ends with a visible mark; the label is kept. */
function truncate(block: VisibleBlock, maxChars: number): VisibleBlock {
  const markOnly = { ...block, text: TRUNCATION_MARK };
  if (blockChars(markOnly) >= maxChars) throw new Error(`a budget of ${maxChars} characters cannot hold a block labelled \`${block.label}\`; raise the context budget`);
  let keep = maxChars - blockChars(markOnly);
  for (;;) {
    const head = block.text.slice(0, keep);
    const safeHead = head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;
    const candidate = { ...block, text: safeHead + TRUNCATION_MARK };
    const excess = blockChars(candidate) - maxChars;
    if (excess <= 0) return candidate;
    keep -= excess;
  }
}

/**
 * Blocks are added in order of descending weight until the next one would exceed `budgetChars` (counted as rendered
 * characters, see `blockChars`); the result is in document order. The heaviest block is always included and is
 * truncated when it alone exceeds the budget.
 */
export function selectContext(blocks: ReadonlyArray<VisibleBlock>, viewportHeight: number, budgetChars: number): ReadonlyArray<VisibleBlock> {
  if (!(viewportHeight > 0)) throw new Error(`viewport height must be positive, got ${viewportHeight}; the pane must be laid out before its text is read`);
  const byWeight = blocks.map((block, index) => ({ block, index, weight: weight(block, viewportHeight) })).sort((left, right) => right.weight - left.weight || left.index - right.index);
  const chosen: Array<Readonly<{ block: VisibleBlock; index: number }>> = [];
  let used = 0;
  for (const entry of byWeight) {
    const cost = blockChars(entry.block);
    if (chosen.length === 0 && cost > budgetChars) {
      chosen.push({ block: truncate(entry.block, budgetChars), index: entry.index });
      break;
    }
    if (used + cost > budgetChars) break;
    chosen.push({ block: entry.block, index: entry.index });
    used += cost;
  }
  return chosen.sort((left, right) => left.index - right.index).map((entry) => entry.block);
}
