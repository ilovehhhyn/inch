// Maps pane ids to the readers that report what each pane shows, so the window can read the pane the user chose.
import type { PaneId } from "./pane-id";
import type { VisibleBlock } from "./visible-blocks";

export type PaneKind = "chat" | "diff";
export type Unregister = () => void;

/** What a context needs to know about a pane besides its blocks. */
export type PaneDetails = Readonly<{ title: () => string; viewportHeight: () => number }>;

type Registered = Readonly<{ reader: () => ReadonlyArray<VisibleBlock>; kind: PaneKind; details: PaneDetails }>;

const panes = new Map<PaneId, Registered>();

export function registerPane(paneId: PaneId, reader: () => ReadonlyArray<VisibleBlock>, kind: PaneKind, details: PaneDetails): Unregister {
  if (panes.has(paneId)) throw new Error(`pane \`${paneId}\` is already registered; unregister it before registering another reader`);
  const entry: Registered = { reader, kind, details };
  panes.set(paneId, entry);
  return () => {
    if (panes.get(paneId) === entry) panes.delete(paneId);
  };
}

function require(paneId: PaneId): Registered {
  const entry = panes.get(paneId);
  if (entry === undefined) throw new Error(`no pane registered as \`${paneId}\`; the pane must register itself when it mounts`);
  return entry;
}

export function readPane(paneId: PaneId): ReadonlyArray<VisibleBlock> {
  return require(paneId).reader();
}

export function describePane(paneId: PaneId): Readonly<{ kind: PaneKind; title: string; viewportHeight: number }> {
  const { kind, details } = require(paneId);
  return { kind, title: details.title(), viewportHeight: details.viewportHeight() };
}
