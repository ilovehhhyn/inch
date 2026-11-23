// @vitest-environment jsdom
// Invariant: the diff pane shows rows with new-file line numbers, reads as labelled context blocks, and says so when it cannot show a diff.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { DiffPane } from "../../src/renderer/components/DiffPane";
import { DIFF_PANE_ID } from "../../src/renderer/context/pane-id";
import { readPane } from "../../src/renderer/context/pane-registry";
import { createScrollTracker } from "../../src/renderer/context/scroll-tracker";
import { DIFF_MAX_BYTES } from "../../src/shared/diff-limits";
import { BLOCK_PITCH_PX, installFakeLayout } from "../fakes/fake-layout";

const WARMUP = readFileSync(join(import.meta.dirname, "../fixtures/warmup.diff"), "utf8");
const FOLDER = "/Users/example/code/repo";
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

function pane(loadDiff: (folder: string) => Promise<string>, folder: string | null = FOLDER, onChooseFolder: () => void = () => undefined) {
  return <DiffPane paneId={DIFF_PANE_ID} tracker={createScrollTracker(() => 0)} folder={folder} loadDiff={loadDiff} onChooseFolder={onChooseFolder} />;
}

test("rows_show_their_new_file_line_numbers_and_the_header_counts_files_and_lines", async () => {
  const { container } = render(pane(async () => WARMUP));

  await screen.findByText("return peak * (step // warmup_steps)", { exact: false });

  const row = [...container.querySelectorAll(".dl")].find((element) => element.textContent === "        return peak * (step // warmup_steps)");
  expect(row?.getAttribute("data-line")).toBe("39");
  expect(row?.classList.contains("add")).toBe(true);
  expect(screen.getByText("3 files +5 −2")).toBeInTheDocument();
  expect(screen.getByText("Code diff · repo")).toBeInTheDocument();
});

test("diff_over_the_limit_shows_the_size_message", async () => {
  const huge = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,1 @@\n+${"x".repeat(DIFF_MAX_BYTES + 1024 * 1024)}\n`;

  const { container } = render(pane(async () => huge));

  expect(await screen.findByText("This diff is too large to show (3.0 MB). Narrow it to fewer files.")).toBeInTheDocument();
  expect(container.querySelector(".dl")).toBeNull();
});

test("a_diff_exactly_at_the_limit_is_shown", async () => {
  const header = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+";
  const text = `${header}${"x".repeat(DIFF_MAX_BYTES - header.length - 1)}\n`;
  expect(new TextEncoder().encode(text).length).toBe(DIFF_MAX_BYTES);

  const { container } = render(pane(async () => text));

  await waitFor(() => expect(container.querySelector(".dl")).not.toBeNull());
});

test("git_failure_message_is_shown_as_an_alert_with_the_folder", async () => {
  render(pane(async () => {
    throw new Error(`git diff failed in ${FOLDER}: fatal: not a git repository`);
  }));

  expect(await screen.findByRole("alert")).toHaveTextContent(`git diff failed in ${FOLDER}: fatal: not a git repository`);
});

test("text_that_is_not_a_diff_is_shown_as_an_alert", async () => {
  render(pane(async () => "fatal: something else"));

  expect(await screen.findByRole("alert")).toHaveTextContent("line 1 is not part of a unified diff");
});

test("no_folder_asks_for_one_and_the_button_chooses_it", async () => {
  let chosen = 0;
  render(pane(async () => WARMUP, null, () => {
    chosen += 1;
  }));

  await userEvent.click(screen.getByRole("button", { name: "Choose a folder" }));

  expect(chosen).toBe(1);
  expect(screen.queryByText(/files/)).toBeNull();
});

test("an_empty_diff_says_there_are_no_changes", async () => {
  render(pane(async () => ""));

  expect(await screen.findByText("No changes in this folder.")).toBeInTheDocument();
});

test("visible_diff_context_labels_carry_file_and_line", async () => {
  const { container } = render(pane(async () => WARMUP));
  await screen.findByText("3 files +5 −2");
  const blocks = [...container.querySelectorAll("[data-context-block]")];
  const index = blocks.findIndex((element) => element.getAttribute("data-context-label") === "train.py line 39");
  expect(index).toBeGreaterThan(8);
  expect(readPane(DIFF_PANE_ID).map((block) => block.label)).not.toContain("train.py line 39");

  const view = container.querySelector(".view");
  if (view === null) throw new Error("the diff pane has no scroll container");
  act(() => {
    view.scrollTop = index * BLOCK_PITCH_PX - 200;
  });

  const visible = readPane(DIFF_PANE_ID);
  expect(visible.map((block) => block.label)).toContain("train.py line 39");
  expect(visible.find((block) => block.label === "train.py line 39")?.text).toBe("        return peak * (step // warmup_steps)");
  expect(visible.find((block) => block.label === "train.py line 38")?.text).toBe("        # ramp linearly from 0 to peak");
  expect(visible.some((block) => block.label === "train.py deleted line" && block.text === "        return peak")).toBe(true);
});

test("a_slow_answer_for_an_old_folder_does_not_replace_the_newer_folder", async () => {
  let release: (text: string) => void = () => undefined;
  const slow = new Promise<string>((resolve) => {
    release = resolve;
  });
  const loadDiff = (folder: string): Promise<string> => (folder === "/old/repo" ? slow : Promise.resolve(WARMUP));
  const { rerender } = render(pane(loadDiff, "/old/repo"));

  rerender(pane(loadDiff, "/new/repo"));
  await screen.findByText("3 files +5 −2");
  await act(async () => release("diff --git a/zzz.py b/zzz.py\n--- a/zzz.py\n+++ b/zzz.py\n@@ -0,0 +1,1 @@\n+old\n"));

  expect(screen.queryByText("zzz.py")).toBeNull();
  expect(screen.getByText("Code diff · repo")).toBeInTheDocument();
});
