// Draws the git diff of a chosen folder as numbered rows, each one a labelled block the context can read.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import { DIFF_MAX_BYTES } from "../../shared/diff-limits";
import type { PaneId } from "../context/pane-id";
import { registerPane } from "../context/pane-registry";
import type { ScrollTracker } from "../context/scroll-tracker";
import { readVisibleBlocks, visibleHeight } from "../context/visible-blocks";
import { parseUnifiedDiff, type DiffRow } from "../diff/parse-unified-diff";

export type DiffPaneProps = Readonly<{
  paneId: PaneId;
  tracker: ScrollTracker;
  /** The chosen folder, or null before the user chooses one. */
  folder: string | null;
  loadDiff: (folder: string) => Promise<string>;
  onChooseFolder: () => void;
}>;

type Loaded =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "too-large"; bytes: number }>
  | Readonly<{ state: "ready"; rows: ReadonlyArray<DiffRow> }>;

const BYTES_PER_MB = 1024 * 1024;

function folderName(folder: string): string {
  return folder.split("/").filter((part) => part !== "").at(-1) ?? folder;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function load(text: string): Loaded {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > DIFF_MAX_BYTES) return { state: "too-large", bytes };
  return { state: "ready", rows: parseUnifiedDiff(text) };
}

function statOf(rows: ReadonlyArray<DiffRow>): string {
  const files = rows.filter((row) => row.kind === "file").length;
  const added = rows.filter((row) => row.kind === "add").length;
  const deleted = rows.filter((row) => row.kind === "delete").length;
  return `${files} ${files === 1 ? "file" : "files"} +${added} −${deleted}`;
}

function DiffRowView({ row }: Readonly<{ row: DiffRow }>): ReactElement {
  if (row.kind === "file") return <div className="file" data-context-block="" data-context-label={row.file}>{row.text}</div>;
  if (row.kind === "hunk") return <div className="dl hunk"><span className="code">{row.text}</span></div>;
  const label = row.kind === "delete" ? `${row.file} deleted line` : `${row.file} line ${row.newLine}`;
  const sign = row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " ";
  return (
    <div className={row.kind === "context" ? "dl" : `dl ${row.kind === "add" ? "add" : "del"}`} data-line={row.newLine ?? ""} data-context-block="" data-context-label={label}>
      <span className="code" data-sign={sign}>{row.text}</span>
    </div>
  );
}

export function DiffPane({ paneId, tracker, folder, loadDiff, onChooseFolder }: DiffPaneProps): ReactElement {
  /** The outcome is stored with the folder it belongs to, so a folder that is still loading never shows the previous folder's diff. */
  const [result, setResult] = useState<Readonly<{ folder: string; loaded: Loaded }> | null>(null);
  const loaded: Loaded = result !== null && result.folder === folder ? result.loaded : { state: "loading" };
  const element = useRef<HTMLDivElement | null>(null);
  const folderRef = useRef(folder);

  useLayoutEffect(() => {
    folderRef.current = folder;
  }, [folder]);

  useLayoutEffect(() => {
    const container = element.current;
    if (container === null) throw new Error("the scroll container must be mounted before the pane registers");
    const unregister = registerPane(paneId, () => readVisibleBlocks(container), "diff", {
      title: () => (folderRef.current === null ? "no folder chosen" : folderName(folderRef.current)),
      viewportHeight: () => visibleHeight(container),
    });
    const detach = tracker.attach(paneId, container);
    return () => {
      detach();
      unregister();
    };
  }, [paneId, tracker]);

  useEffect(() => {
    if (folder === null) return undefined;
    let isCurrent = true;
    loadDiff(folder).then(
      (text) => {
        if (!isCurrent) return;
        try {
          setResult({ folder, loaded: load(text) });
        } catch (error) {
          setResult({ folder, loaded: { state: "failed", message: messageOf(error) } });
        }
      },
      (error: unknown) => {
        if (isCurrent) setResult({ folder, loaded: { state: "failed", message: messageOf(error) } });
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [folder, loadDiff]);

  const rows = loaded.state === "ready" && folder !== null ? loaded.rows : [];
  return (
    <section className="diff-pane" data-pane-id={paneId} aria-label="Code diff">
      <header className="pane-head">
        <span>Code diff{folder === null ? "" : ` · ${folderName(folder)}`}</span>
        {rows.length > 0 ? <span className="stat">{statOf(rows)}</span> : null}
        <button type="button" className="pane-button" onClick={onChooseFolder}>
          {folder === null ? "Choose a folder" : "Change folder"}
        </button>
      </header>
      <div className="view" ref={element} tabIndex={0}>
        {folder === null || loaded.state === "loading" ? null : (
          <div className="diff">
            {loaded.state === "failed" ? <p className="thread-error" role="alert">{loaded.message}</p> : null}
            {loaded.state === "too-large" ? <p className="diff-note">{`This diff is too large to show (${(loaded.bytes / BYTES_PER_MB).toFixed(1)} MB). Narrow it to fewer files.`}</p> : null}
            {loaded.state === "ready" && loaded.rows.length === 0 ? <p className="diff-note">No changes in this folder.</p> : null}
            {rows.map((row, index) => <DiffRowView key={index} row={row} />)}
          </div>
        )}
      </div>
    </section>
  );
}
