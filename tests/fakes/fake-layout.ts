// Gives jsdom a deterministic layout: each pane's `.view` is 800 px high and its context blocks are stacked 100 px apart, shifted by the pane's scrollTop.
export const VIEW_HEIGHT_PX = 800;
/** The composer and the fade cover the bottom of every pane from this height down. */
export const OVERLAY_TOP_PX = 650;
export const BLOCK_PITCH_PX = 100;
export const BLOCK_HEIGHT_PX = 80;

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

/** Replaces `getBoundingClientRect` on all elements and returns the function that restores it. */
export function installFakeLayout(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    if (this.matches(".view")) return rect(0, VIEW_HEIGHT_PX);
    if (this.hasAttribute("data-context-occluder")) return rect(OVERLAY_TOP_PX, VIEW_HEIGHT_PX);
    const view = this.closest(".view");
    if (view === null || !this.hasAttribute("data-context-block")) return rect(0, 0);
    const index = [...view.querySelectorAll("[data-context-block]")].indexOf(this);
    const top = index * BLOCK_PITCH_PX - view.scrollTop;
    return rect(top, top + BLOCK_HEIGHT_PX);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Scrolls a pane's `.view` the way a user does: wheel input, then the scroll position changes, then the scroll event. */
export function userScroll(view: Element, scrollTop: number): void {
  view.dispatchEvent(new WheelEvent("wheel"));
  view.scrollTop = scrollTop;
  view.dispatchEvent(new Event("scroll"));
}
