// Invariant: every context and added row of a unified diff carries the line number it has in the new file; deleted rows carry none.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { parseUnifiedDiff } from "../../src/renderer/diff/parse-unified-diff";

const WARMUP = readFileSync(new URL("../fixtures/warmup.diff", import.meta.url), "utf8");

test("parses_new_file_line_numbers_from_hunk_headers", () => {
  const rows = parseUnifiedDiff(WARMUP);

  const row = rows.find((candidate) => candidate.text === "        return peak * (step // warmup_steps)");

  expect(row).toEqual({ kind: "add", file: "train.py", newLine: 39, text: "        return peak * (step // warmup_steps)" });
  expect(rows.find((candidate) => candidate.text === "    progress = (step - warmup_steps) / (total_steps - warmup_steps)")).toMatchObject({ kind: "context", newLine: 40 });
  expect(rows.find((candidate) => candidate.text === "        # ramp linearly from 0 to peak")).toMatchObject({ kind: "add", newLine: 38 });
});

test("deleted_rows_have_no_new_line_number", () => {
  const deleted = parseUnifiedDiff(WARMUP).filter((row) => row.kind === "delete");

  expect(deleted.map((row) => [row.file, row.newLine, row.text])).toEqual([
    ["data.py", null, "    return split_by_sequence(rows, holdout)"],
    ["train.py", null, "        return peak"],
  ]);
});

test("the_film_pr_has_three_files_five_additions_and_two_deletions", () => {
  const rows = parseUnifiedDiff(WARMUP);

  expect(rows.filter((row) => row.kind === "file").map((row) => row.file)).toEqual(["data.py", "config.py", "train.py"]);
  expect(rows.filter((row) => row.kind === "add")).toHaveLength(5);
  expect(rows.filter((row) => row.kind === "delete")).toHaveLength(2);
});

test("file_and_hunk_rows_have_no_line_number_and_hunk_rows_keep_their_header", () => {
  const rows = parseUnifiedDiff(WARMUP);

  expect(rows[0]).toEqual({ kind: "file", file: "data.py", newLine: null, text: "data.py" });
  expect(rows[1]).toEqual({ kind: "hunk", file: "data.py", newLine: null, text: "@@ -18,3 +18,4 @@ import random" });
});

test("renamed_and_binary_files_produce_a_file_row_and_no_lines", () => {
  const diff = [
    "diff --git a/old.py b/new.py",
    "similarity index 100%",
    "rename from old.py",
    "rename to new.py",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");

  expect(parseUnifiedDiff(diff)).toEqual([
    { kind: "file", file: "new.py", newLine: null, text: "old.py → new.py" },
    { kind: "file", file: "logo.png", newLine: null, text: "logo.png (binary)" },
  ]);
});

test("a_deleted_file_is_named_by_its_old_path_and_a_new_file_by_its_new_path", () => {
  const diff = [
    "diff --git a/gone.py b/gone.py",
    "deleted file mode 100644",
    "index 3333333..0000000",
    "--- a/gone.py",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/fresh.py b/fresh.py",
    "new file mode 100644",
    "index 0000000..4444444",
    "--- /dev/null",
    "+++ b/fresh.py",
    "@@ -0,0 +1,2 @@",
    "+x",
    "+y",
  ].join("\n");

  const rows = parseUnifiedDiff(diff);

  expect(rows.filter((row) => row.kind === "delete").map((row) => row.file)).toEqual(["gone.py", "gone.py"]);
  expect(rows.filter((row) => row.kind === "add").map((row) => [row.file, row.newLine])).toEqual([["fresh.py", 1], ["fresh.py", 2]]);
});

test("a_deleted_line_that_looks_like_a_file_header_stays_a_deleted_line", () => {
  const diff = ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", "@@ -1,2 +1,1 @@", "--- old rule", " kept"].join("\n");

  const rows = parseUnifiedDiff(diff);

  expect(rows.map((row) => [row.kind, row.text])).toEqual([["file", "notes.md"], ["hunk", "@@ -1,2 +1,1 @@"], ["delete", "-- old rule"], ["context", "kept"]]);
});

test("the_no_newline_marker_is_not_a_row_and_hunk_header_counts_default_to_one", () => {
  const diff = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n");

  expect(parseUnifiedDiff(diff).map((row) => [row.kind, row.newLine])).toEqual([["file", null], ["hunk", null], ["delete", null], ["add", 1]]);
});

test("empty_input_gives_no_rows_and_text_that_is_not_a_diff_is_rejected", () => {
  expect(parseUnifiedDiff("")).toEqual([]);
  expect(() => parseUnifiedDiff("fatal: not a git repository")).toThrow(/line 1 is not part of a unified diff/);
});

test("a_hunk_that_ends_early_is_rejected_with_its_header", () => {
  const diff = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "diff --git a/b.txt b/b.txt"].join("\n");

  expect(() => parseUnifiedDiff(diff)).toThrow(/hunk `@@ -1,3 \+1,3 @@` of a\.txt ended early/);
});

test("quoted_paths_with_octal_escapes_are_decoded", () => {
  const diff = [
    'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"',
    'index 1111111..2222222 100644',
    '--- "a/caf\\303\\251.py"',
    '+++ "b/caf\\303\\251.py"',
    "@@ -1 +1 @@",
    "-one",
    "+two",
    'diff --git "a/tab\\there.py" "b/tab\\there.py"',
    'rename from "old\\"q.py"',
    'rename to "new\\\\q.py"',
  ].join("\n");

  const rows = parseUnifiedDiff(diff);

  expect(rows.filter((row) => row.kind === "file").map((row) => row.file)).toEqual(["café.py", "new\\q.py"]);
  expect(rows.find((row) => row.kind === "add")?.file).toBe("café.py");
  expect(rows.at(-1)?.text).toBe('old"q.py → new\\q.py');
});

test("a_quoted_header_with_an_unterminated_quote_is_rejected", () => {
  expect(() => parseUnifiedDiff('diff --git "a/x b/x')).toThrow(/diff header .* is not in/);
});
