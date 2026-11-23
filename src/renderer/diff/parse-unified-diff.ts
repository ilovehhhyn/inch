// Parses `git diff` output into rows that carry the line number each row has in the new file.

export type DiffRow = Readonly<{
  kind: "file" | "hunk" | "context" | "add" | "delete";
  file: string;
  /** The row's line number in the new file; null for file, hunk and deleted rows. */
  newLine: number | null;
  text: string;
}>;

const DIFF_START = "diff --git ";
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = "\\";

/** Splits `a/<path> b/<path>`; when both paths are equal the split is exact even if the path contains spaces. */
function pathsOfDiffLine(line: string): string {
  const rest = line.slice(DIFF_START.length);
  const length = (rest.length - 5) / 2;
  if (Number.isInteger(length) && length > 0) {
    const path = rest.slice(2, 2 + length);
    if (rest === `a/${path} b/${path}`) return path;
  }
  const match = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (match === null) throw new Error(`diff header ${JSON.stringify(line.slice(0, 80))} is not in \`diff --git a/<path> b/<path>\` form; run git with \`--no-ext-diff\` and without \`--word-diff\``);
  return match[2] ?? "";
}

function pathOfMarker(line: string, prefix: string): string | null {
  const text = line.slice(prefix.length).split("\t")[0] ?? "";
  return text === "/dev/null" ? null : text.replace(/^[ab]\//, "");
}

type Cursor = { file: string; fileRow: number; oldPath: string | null; renamedFrom: string | null; header: string; oldLeft: number; newLeft: number; newLine: number };

function endedEarly(cursor: Cursor): Error {
  return new Error(`hunk \`${cursor.header}\` of ${cursor.file} ended early; the diff text is cut off or corrupt`);
}

/** Returns one row per file, hunk header and diff line, in order. Throws for text that is not a unified diff. */
export function parseUnifiedDiff(text: string): ReadonlyArray<DiffRow> {
  if (text === "") return [];
  const rows: Array<DiffRow> = [];
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let cursor: Cursor | null = null;
  const setFileRow = (current: Cursor, rowText: string): void => {
    rows[current.fileRow] = { kind: "file", file: current.file, newLine: null, text: rowText };
  };

  for (const [index, line] of lines.entries()) {
    if (line.startsWith(DIFF_START)) {
      if (cursor !== null && (cursor.oldLeft > 0 || cursor.newLeft > 0)) throw endedEarly(cursor);
      const file = pathsOfDiffLine(line);
      cursor = { file, fileRow: rows.length, oldPath: null, renamedFrom: null, header: "", oldLeft: 0, newLeft: 0, newLine: 0 };
      rows.push({ kind: "file", file, newLine: null, text: file });
      continue;
    }
    if (cursor === null) throw new Error(`line ${index + 1} is not part of a unified diff: ${JSON.stringify(line.slice(0, 60))}; the input must be \`git diff\` output`);
    const inHunk = cursor.oldLeft > 0 || cursor.newLeft > 0;
    if (line.startsWith(NO_NEWLINE_MARKER)) continue;
    if (inHunk) {
      const sign = line === "" ? " " : line[0];
      const body = line.slice(1);
      if (sign === " ") rows.push({ kind: "context", file: cursor.file, newLine: cursor.newLine++, text: body });
      else if (sign === "+") rows.push({ kind: "add", file: cursor.file, newLine: cursor.newLine++, text: body });
      else if (sign === "-") rows.push({ kind: "delete", file: cursor.file, newLine: null, text: body });
      else throw new Error(`line ${index + 1} is not a diff line inside hunk \`${cursor.header}\` of ${cursor.file}: ${JSON.stringify(line.slice(0, 60))}`);
      if (sign !== "+") cursor.oldLeft -= 1;
      if (sign !== "-") cursor.newLeft -= 1;
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      cursor.header = line.slice(0, line.indexOf(" @@", 2) + 3);
      cursor.oldLeft = Number(hunk[1] ?? 1);
      cursor.newLeft = Number(hunk[3] ?? 1);
      cursor.newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", file: cursor.file, newLine: null, text: line });
      continue;
    }
    if (line.startsWith("--- ")) cursor.oldPath = pathOfMarker(line, "--- ");
    else if (line.startsWith("+++ ")) {
      cursor.file = pathOfMarker(line, "+++ ") ?? cursor.oldPath ?? cursor.file;
      setFileRow(cursor, cursor.file);
    } else if (line.startsWith("rename from ")) cursor.renamedFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ")) {
      cursor.file = line.slice("rename to ".length);
      setFileRow(cursor, `${cursor.renamedFrom ?? "?"} → ${cursor.file}`);
    } else if (line.startsWith("Binary files ")) setFileRow(cursor, `${cursor.file} (binary)`);
  }
  if (cursor !== null && (cursor.oldLeft > 0 || cursor.newLeft > 0)) throw endedEarly(cursor);
  return rows;
}
