// Reads the blocks of a pane that the user can see, from the pane's own DOM and without any screenshot.

/** A label is one line of at most this many characters, so it cannot crowd out the text in the context budget. */
export const MAX_LABEL_CHARS = 200;

/** Pixel positions are relative to the pane's viewport; a partly visible block keeps its full text but a clipped top and bottom. */
export type VisibleBlock = Readonly<{ text: string; label: string; top: number; bottom: number }>;

const BLOCK_SELECTOR = "[data-context-block]";
const HEADING_SELECTOR = "[data-context-heading]";
const OCCLUDER_SELECTOR = "[data-context-occluder]";
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

/** Markdown list items carry blank lines around their text; the first line's own indentation is kept because code needs it. */
function textOf(block: Element): string {
  return (block.textContent ?? "").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/** A block inside another block is already part of the outer block's text. */
function isNested(block: Element, container: HTMLElement): boolean {
  const outer = block.parentElement?.closest(BLOCK_SELECTOR) ?? null;
  return outer !== null && container.contains(outer);
}

/**
 * The part of the container the user can see: its scroll view minus the area that overlays (the composer and the fade)
 * cover. Overlays are the `data-context-occluder` elements of the same pane; the first one that reaches into the view
 * cuts everything below its top edge.
 */
function visibleRegion(container: HTMLElement): Readonly<{ top: number; bottom: number }> {
  const view = container.getBoundingClientRect();
  let bottom = view.bottom;
  for (const occluder of container.closest("[data-pane-id]")?.querySelectorAll(OCCLUDER_SELECTOR) ?? []) {
    const rectangle = occluder.getBoundingClientRect();
    const isEmpty = rectangle.bottom <= rectangle.top;
    const reachesIntoView = rectangle.bottom > view.top && rectangle.top < view.bottom;
    if (!isEmpty && reachesIntoView) bottom = Math.min(bottom, Math.max(rectangle.top, view.top));
  }
  return { top: view.top, bottom };
}

/** The height that block positions are weighted against: the unoccluded height of the view. */
export function visibleHeight(container: HTMLElement): number {
  const { top, bottom } = visibleRegion(container);
  return bottom - top;
}

/** Returns the `data-context-block` elements whose rectangles intersect the visible region of the container, in document order. */
export function readVisibleBlocks(container: HTMLElement): ReadonlyArray<VisibleBlock> {
  const view = visibleRegion(container);
  const found: Array<VisibleBlock> = [];
  for (const block of container.querySelectorAll(BLOCK_SELECTOR)) {
    const rectangle = block.getBoundingClientRect();
    if (rectangle.bottom <= view.top || rectangle.top >= view.bottom) continue;
    if (isNested(block, container)) continue;
    found.push({
      text: textOf(block),
      label: labelOf(block),
      top: Math.max(rectangle.top, view.top) - view.top,
      bottom: Math.min(rectangle.bottom, view.bottom) - view.top,
    });
  }
  return found;
}
