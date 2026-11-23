// Reads the blocks of a pane that the user can see, from the pane's own DOM and without any screenshot.

/** A label is one line of at most this many characters, so it cannot crowd out the text in the context budget. */
export const MAX_LABEL_CHARS = 200;

/** Pixel positions are relative to the pane's viewport; a partly visible block keeps its full text but a clipped top and bottom. */
export type VisibleBlock = Readonly<{ text: string; label: string; top: number; bottom: number }>;

const BLOCK_SELECTOR = "[data-context-block]";
const HEADING_SELECTOR = "[data-context-heading]";
const SCOPE_SELECTOR = "[data-context-scope]";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function capLabel(label: string): string {
  const line = oneLine(label);
  return line.length <= MAX_LABEL_CHARS ? line : `${line.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** The nearest heading at or before `block` within its message; a block outside any message has only itself to be a heading. */
function nearestHeading(block: Element): string | null {
  const scope = block.closest(SCOPE_SELECTOR);
  if (scope === null) return block.matches(HEADING_SELECTOR) ? oneLine(block.textContent) : null;
  const preceding = [...scope.querySelectorAll(HEADING_SELECTOR)].filter((heading) => heading === block || (heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const heading = preceding.at(-1);
  return heading === undefined ? null : oneLine(heading.textContent);
}

function labelOf(block: Element): string {
  const base = block.getAttribute("data-context-label");
  if (base === null || oneLine(base) === "") throw new Error("a data-context-block element must carry a data-context-label; add the attribute where the block is rendered");
  const heading = nearestHeading(block);
  return capLabel(heading === null ? base : `${oneLine(base)}, heading "${heading}"`);
}

/** A block inside another block is already part of the outer block's text. */
function isNested(block: Element, container: HTMLElement): boolean {
  const outer = block.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  return outer !== null && container.contains(outer);
}

/** Returns the `data-context-block` elements whose rectangles intersect the container's visible rectangle, in document order. */
export function readVisibleBlocks(container: HTMLElement): ReadonlyArray<VisibleBlock> {
  const view = container.getBoundingClientRect();
  const found: Array<VisibleBlock> = [];
  for (const block of container.querySelectorAll(BLOCK_SELECTOR)) {
    const rectangle = block.getBoundingClientRect();
    if (rectangle.bottom <= view.top || rectangle.top >= view.bottom) continue;
    if (isNested(block, container)) continue;
    found.push({
      text: (block.textContent ?? "").trimEnd(),
      label: labelOf(block),
      top: Math.max(rectangle.top, view.top) - view.top,
      bottom: Math.min(rectangle.bottom, view.bottom) - view.top,
    });
  }
  return found;
}
