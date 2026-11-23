// @vitest-environment jsdom
// Invariant: the diff folder is chosen and saved, and Command-I reads the diff pane when it was scrolled last.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { DEFAULT_LAYOUT } from "../../src/shared/layout";
import { FakeMarginApi } from "../fakes/fake-margin-api";
import { BLOCK_PITCH_PX, installFakeLayout, userScroll } from "../fakes/fake-layout";

const WARMUP = readFileSync(join(import.meta.dirname, "../fixtures/warmup.diff"), "utf8");
const FOLDER = "/Users/example/code/repo";
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

function apiWithDiff(): FakeMarginApi {
  const api = new FakeMarginApi();
  api.diffs.set(FOLDER, WARMUP);
  return api;
}

test("choosing_a_folder_saves_it_and_shows_its_diff", async () => {
  const api = apiWithDiff();
  api.chosenFolder = FOLDER;
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Choose a folder" }));

  expect(await screen.findByText("3 files +5 −2")).toBeInTheDocument();
  expect(api.layoutWrites.at(-1)).toEqual({ ...DEFAULT_LAYOUT, diffFolder: FOLDER });
  expect(api.diffReads).toEqual([FOLDER]);
});

test("cancelling_the_folder_dialog_changes_nothing", async () => {
  const api = apiWithDiff();
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Choose a folder" }));

  expect(api.layoutWrites).toEqual([]);
  expect(screen.getByRole("button", { name: "Choose a folder" })).toBeInTheDocument();
});

test("a_saved_folder_is_shown_when_the_window_opens", async () => {
  const api = apiWithDiff();
  api.layout = { ...DEFAULT_LAYOUT, diffFolder: FOLDER };

  render(<App api={api} />);

  expect(await screen.findByText("3 files +5 −2")).toBeInTheDocument();
});

test("command_i_after_scrolling_the_diff_sends_diff_context_with_file_and_line", async () => {
  const api = apiWithDiff();
  api.layout = { ...DEFAULT_LAYOUT, diffFolder: FOLDER };
  const { container } = render(<App api={api} />);
  await screen.findByText("3 files +5 −2");
  const diffView = container.querySelector(".diff-pane .view");
  if (diffView === null) throw new Error("the diff pane has no scroll container");
  const blocks = [...diffView.querySelectorAll("[data-context-block]")];
  const index = blocks.findIndex((element) => element.getAttribute("data-context-label") === "train.py line 39");
  act(() => userScroll(diffView, index * BLOCK_PITCH_PX - 200));

  await userEvent.type(screen.getByLabelText("Message"), "is line 39 right?");
  await userEvent.keyboard("{Meta>}i{/Meta}");

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  const context = api.turnStarts[0]?.contextText ?? "";
  expect(context.split("\n").slice(0, 2)).toEqual(["MARGIN SCREEN CONTEXT v1", "pane: diff · repo"]);
  expect(context).toContain("--- train.py line 39\n        return peak * (step // warmup_steps)\n");
  expect(context).not.toContain("--- data.py");
});

test("a_diff_that_cannot_be_read_is_shown_in_the_pane_not_the_chat", async () => {
  const api = new FakeMarginApi();
  api.layout = { ...DEFAULT_LAYOUT, diffFolder: FOLDER };
  render(<App api={api} />);

  expect(await screen.findByRole("alert")).toHaveTextContent(`no diff for ${FOLDER}`);
  expect(screen.getByRole("region", { name: "Code diff" })).toContainElement(screen.getByRole("alert"));
});
