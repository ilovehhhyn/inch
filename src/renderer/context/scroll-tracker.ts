// Records which pane the user scrolled last, counting only scrolls caused by the user's wheel, keys or scrollbar.
import type { PaneId } from "./pane-id";

/** A scroll event counts as the user's when it follows wheel or key input by at most this long; browsers deliver the scroll within a frame or two. */
export const USER_SCROLL_WINDOW_MS = 300;

/** A press this close to the right edge of the pane is treated as a press on its scrollbar (overlay scrollbars take no layout width). */
export const SCROLLBAR_HIT_PX = 16;

const SCROLL_KEYS: ReadonlySet<string> = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

export type Detach = () => void;

export type ScrollTracker = Readonly<{
  attach: (paneId: PaneId, element: HTMLElement) => Detach;
  markMessageSent: () => void;
  /** The pane with the latest user scroll since the last message, else `focusedPaneId`. */
  choosePane: (focusedPaneId: PaneId | null) => PaneId | null;
}>;

type Mark = Readonly<{ time: number; sequence: number }>;

export function createScrollTracker(clock: () => number): ScrollTracker {
  const attached = new Set<PaneId>();
  const scrolled = new Map<PaneId, Mark>();
  let sequence = 0;

  function attach(paneId: PaneId, element: HTMLElement): Detach {
    if (attached.has(paneId)) throw new Error(`pane \`${paneId}\` is already attached to the scroll tracker; detach it first`);
    attached.add(paneId);
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let isPointerHeld = false;
    const noteInput = (): void => {
      lastInputAt = clock();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(event.key)) noteInput();
    };
    const onPointerDown = (event: MouseEvent): void => {
      const isOnScrollbar = event.target === element && event.offsetX >= element.clientWidth - SCROLLBAR_HIT_PX;
      if (isOnScrollbar) isPointerHeld = true;
    };
    const onPointerUp = (): void => {
      isPointerHeld = false;
    };
    const onScroll = (): void => {
      const now = clock();
      const isCausedByUser = isPointerHeld || now - lastInputAt <= USER_SCROLL_WINDOW_MS;
      if (!isCausedByUser) return;
      sequence += 1;
      scrolled.set(paneId, { time: now, sequence });
    };
    element.addEventListener("wheel", noteInput, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("scroll", onScroll, { passive: true });
    element.ownerDocument.addEventListener("pointerup", onPointerUp);
    return () => {
      element.removeEventListener("wheel", noteInput);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("scroll", onScroll);
      element.ownerDocument.removeEventListener("pointerup", onPointerUp);
      attached.delete(paneId);
      scrolled.delete(paneId);
    };
  }

  function choosePane(focusedPaneId: PaneId | null): PaneId | null {
    let best: PaneId | null = null;
    let bestMark: Mark | null = null;
    for (const [paneId, mark] of scrolled) {
      const isLater = bestMark === null || mark.time > bestMark.time || (mark.time === bestMark.time && mark.sequence > bestMark.sequence);
      if (isLater) {
        best = paneId;
        bestMark = mark;
      }
    }
    return best ?? focusedPaneId;
  }

  return { attach, markMessageSent: () => scrolled.clear(), choosePane };
}
