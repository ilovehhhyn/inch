// @vitest-environment jsdom
// Invariant: the sidebar lists the chats it is given, marks the open one, and refreshes when an answer completes.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { DEFAULT_LAYOUT } from "../../src/shared/layout";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";

const A = asThreadId("a");
const B = asThreadId("b");

test("the_sidebar_lists_every_chat_marks_the_open_one_and_reports_clicks", async () => {
  const selected: Array<string> = [];
  let newChats = 0;
  render(
    <Sidebar
      threads={[{ id: A, provider: "codex", title: "Fine-tuning plan", updatedAtSec: 2 }, { id: B, provider: "codex", title: "Notes on attention", updatedAtSec: 1 }]}
      selectedId={B}
      onSelect={(id) => selected.push(id)}
      onNewChat={() => {
        newChats += 1;
      }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Fine-tuning plan" }));
  await userEvent.click(screen.getByRole("button", { name: "+ New chat" }));

  expect(selected).toEqual(["a"]);
  expect(newChats).toBe(1);
  expect(screen.getByRole("button", { name: "Notes on attention" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Fine-tuning plan" })).not.toHaveAttribute("aria-current");
});

test("the_chat_list_is_read_when_the_window_opens_and_again_when_an_answer_completes", async () => {
  const api = new FakeMarginApi();
  api.threads = [{ id: A, provider: "codex", title: "Fine-tuning plan", updatedAtSec: 2 }];
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Fine-tuning plan" });
  await userEvent.type(screen.getByLabelText("Message"), "hello{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  api.threads = [{ id: asThreadId("thread-1"), provider: "codex", title: "hello", updatedAtSec: 9 }, ...api.threads];
  act(() => api.emitProvider({ type: "completed", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-1"), status: "completed", error: null }));

  expect(await screen.findByRole("button", { name: "hello" })).toHaveAttribute("aria-current", "page");
});

test("a_list_that_cannot_be_read_is_shown_as_an_alert", async () => {
  const api = new FakeMarginApi();
  api.threadList = async () => {
    throw new Error("thread/list failed");
  };

  render(<App api={api} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not list chats: thread/list failed");
});

test("the_saved_panel_width_is_applied_to_the_right_panel", async () => {
  const api = new FakeMarginApi();
  api.layout = { ...DEFAULT_LAYOUT, panelWidthPx: 700 };

  const { container } = render(<App api={api} />);

  await waitFor(() => expect(container.querySelector("aside.side")).toHaveStyle({ width: "700px" }));
});

test("a_layout_that_cannot_be_read_is_shown_and_is_not_overwritten_by_choosing_a_folder", async () => {
  const api = new FakeMarginApi();
  api.layoutRead = async () => {
    throw new Error("layout /x/layout.json has unknown key `theme`; delete the file to reset the layout");
  };
  api.chosenFolder = "/Users/example/code/repo";
  render(<App api={api} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the saved layout: layout /x/layout.json has unknown key `theme`");

  await userEvent.click(screen.getByRole("button", { name: "Choose a folder" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("will not overwrite it"));
  expect(api.layoutWrites).toEqual([]);
});
