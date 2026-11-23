// Names the panes of the window: the main chat, each side chat and the code diff.

export type PaneId = string & { readonly brand: "PaneId" };

/** Brands a pane identifier; the window creates every pane id through this function. */
export function asPaneId(value: string): PaneId {
  if (value.trim() === "") throw new Error("pane id must not be empty; use `main`, `diff` or `side:<thread id>`");
  return value as PaneId; // the brand records that the id was checked here
}

export const MAIN_PANE_ID = asPaneId("main");
export const DIFF_PANE_ID = asPaneId("diff");

export function sidePaneId(threadId: string): PaneId {
  return asPaneId(`side:${threadId}`);
}
