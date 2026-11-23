// @vitest-environment jsdom
// Invariant: a side chat forks the main chat through the chosen answer, keeps its own answers, and is read by Command-I when it was scrolled last.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { DEFAULT_LAYOUT } from "../../src/shared/layout";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import type { DisplayMessage } from "../../src/shared/thread-history";
import { CODEX_DEFAULT_CHOICE, FakeMarginApi } from "../fakes/fake-margin-api";
import { installFakeLayout, userScroll } from "../fakes/fake-layout";

const OLD = asThreadId("old-1");
const SIDE = asThreadId("side-1");
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

function pair(turn: string): Array<DisplayMessage> {
  return [
    { turnId: asTurnId(turn), role: "user", text: `question ${turn}`, status: "done" },
    { turnId: asTurnId(turn), role: "assistant", text: `answer ${turn}`, status: "done" },
  ];
}

function apiWithOldChat(): FakeMarginApi {
  const api = new FakeMarginApi();
  api.threads = [
    { id: OLD, provider: "codex", title: "Fine-tuning plan", updatedAtSec: 5 },
    { id: asThreadId("other-1"), provider: "codex", title: "Other chat", updatedAtSec: 4 },
  ];
  api.histories.set(OLD, [...pair("t1"), ...pair("t2"), ...pair("t3")]);
  api.histories.set(asThreadId("other-1"), pair("u1"));
  return api;
}

async function openOldChat(api: FakeMarginApi): Promise<void> {
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Fine-tuning plan" }));
  await screen.findByText("answer t3");
}

function mainPane(): HTMLElement {
  return screen.getByRole("region", { name: "Chat" });
}

async function sidePane(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Side chat" });
}

async function openSideChatOn(answerIndex: number): Promise<void> {
  await userEvent.click(screen.getAllByRole("button", { name: "Open side chat" })[answerIndex] as HTMLElement);
  await sidePane();
}

test("open_side_chat_forks_through_the_chosen_turn", async () => {
  const api = apiWithOldChat();
  await openOldChat(api);

  await openSideChatOn(1);

  expect(api.forks).toEqual([{ threadId: OLD, lastTurnId: "t2" }]);
  await waitFor(() => expect(api.layoutWrites.at(-1)?.sideChats).toEqual([{ provider: "codex", threadId: SIDE, forkedFromTurn: "t2" }]));
});

test("side_chat_answers_stay_in_the_side_chat", async () => {
  const api = apiWithOldChat();
  await openOldChat(api);
  await openSideChatOn(1);

  await userEvent.type(within(await sidePane()).getByLabelText("Side chat message"), "what about wd?{Enter}");
  await waitFor(() => expect(api.turnStarts).toEqual([{ threadId: SIDE, question: "what about wd?", contextText: null, choice: CODEX_DEFAULT_CHOICE }]));
  act(() => api.emitProvider({ type: "delta", threadId: SIDE, turnId: asTurnId("turn-1"), text: "Weight decay is separate." }));

  expect(await within(await sidePane()).findByText("Weight decay is separate.")).toBeInTheDocument();
  expect(within(mainPane()).queryByText("Weight decay is separate.")).toBeNull();
  expect(within(mainPane()).queryByText("what about wd?")).toBeNull();
});

test("main_composer_command_i_after_scrolling_the_side_chat_uses_side_chat_context", async () => {
  const api = apiWithOldChat();
  await openOldChat(api);
  await openSideChatOn(1);
  await userEvent.type(within(await sidePane()).getByLabelText("Side chat message"), "side question{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "delta", threadId: SIDE, turnId: asTurnId("turn-1"), text: "side answer" }));
  act(() => api.emitProvider({ type: "completed", threadId: SIDE, turnId: asTurnId("turn-1"), status: "completed", error: null }));
  await within(await sidePane()).findByText("side answer");
  const sideView = (await sidePane()).querySelector(".view");
  if (sideView === null) throw new Error("the side chat has no scroll container");
  act(() => userScroll(sideView, 0));

  await userEvent.type(within(mainPane()).getByLabelText("Message"), "explain this");
  await userEvent.keyboard("{Meta>}i{/Meta}");

  await waitFor(() => expect(api.turnStarts).toHaveLength(2));
  expect(api.turnStarts[1]).toMatchObject({ threadId: OLD, question: "explain this" });
  expect(api.turnStarts[1]?.contextText).toBe(
    ["MARGIN SCREEN CONTEXT v1", "pane: chat · Side chat on Fine-tuning plan", "--- message 1 (user)", "side question", "--- message 2 (assistant)", "side answer", "END MARGIN SCREEN CONTEXT"].join("\n"),
  );
  act(() => api.emitProvider({ type: "delta", threadId: OLD, turnId: asTurnId("turn-2"), text: "main answer" }));
  expect(await within(mainPane()).findByText("main answer")).toBeInTheDocument();
  expect(within(await sidePane()).queryByText("main answer")).toBeNull();
});

test("saved_side_chats_reopen_with_only_their_own_messages_and_only_beside_their_main_chat", async () => {
  const api = apiWithOldChat();
  api.layout = { ...DEFAULT_LAYOUT, sideChats: [{ provider: "codex", threadId: SIDE, forkedFromTurn: asTurnId("t2") }] };
  api.histories.set(SIDE, [...pair("t1"), ...pair("t2"), ...pair("s1")]);
  await openOldChat(api);

  const side = await sidePane();

  expect(await within(side).findByText("answer s1")).toBeInTheDocument();
  expect(within(side).queryByText("answer t1")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Other chat" }));
  await screen.findByText("answer u1");
  expect(screen.queryByRole("region", { name: "Side chat" })).toBeNull();
});

test("a_failed_fork_is_shown_and_no_side_chat_is_saved", async () => {
  const api = apiWithOldChat();
  api.threadFork = async () => {
    throw new Error("thread/fork failed: no rollout found");
  };
  await openOldChat(api);

  await userEvent.click(screen.getAllByRole("button", { name: "Open side chat" })[0] as HTMLElement);

  expect(await screen.findByRole("alert")).toHaveTextContent("no rollout found");
  expect(api.layoutWrites).toEqual([]);
});

test("closing_a_side_chat_removes_it_from_the_saved_layout", async () => {
  const api = apiWithOldChat();
  await openOldChat(api);
  await openSideChatOn(0);

  await userEvent.click(within(await sidePane()).getByRole("button", { name: "Close side chat" }));

  expect(screen.queryByRole("region", { name: "Side chat" })).toBeNull();
  await waitFor(() => expect(api.layoutWrites.at(-1)?.sideChats).toEqual([]));
});

test("two_side_chats_opened_back_to_back_are_both_saved", async () => {
  const api = apiWithOldChat();
  const releases: Array<() => void> = [];
  const forkIds = ["side-1", "side-2"];
  api.threadFork = (_provider, threadId, lastTurnId) =>
    new Promise((resolve) => {
      const index = api.forks.length;
      api.forks.push({ threadId, lastTurnId });
      releases.push(() => resolve(asThreadId(forkIds[index] ?? "side-x")));
    });
  await openOldChat(api);
  const buttons = screen.getAllByRole("button", { name: "Open side chat" });

  await userEvent.click(buttons[0] as HTMLElement);
  await userEvent.click(buttons[2] as HTMLElement);
  await waitFor(() => expect(releases).toHaveLength(2));
  await act(async () => releases.forEach((release) => release()));

  await waitFor(() => expect(api.layoutWrites.at(-1)?.sideChats.map((chat) => chat.threadId)).toEqual(["side-1", "side-2"]));
  expect(api.layoutWrites).toHaveLength(2);
});

test("a_side_chat_uses_the_provider_of_the_chat_it_was_forked_from", async () => {
  const api = apiWithOldChat();
  api.threads = [{ id: OLD, provider: "claude", title: "Fine-tuning plan", updatedAtSec: 5 }];
  await openOldChat(api);

  await openSideChatOn(1);
  await userEvent.type(within(await sidePane()).getByLabelText("Side chat message"), "what about wd?{Enter}");

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.providerCalls).toEqual(["threadOpen:claude", "threadFork:claude", "turnStart:claude"]);
  expect(api.layoutWrites.at(-1)?.sideChats).toEqual([{ provider: "claude", threadId: SIDE, forkedFromTurn: "t2" }]);
});

test("a_saved_side_chat_reopens_with_the_provider_saved_in_the_layout", async () => {
  const api = apiWithOldChat();
  api.layout = { ...DEFAULT_LAYOUT, sideChats: [{ provider: "claude", threadId: SIDE, forkedFromTurn: asTurnId("t2") }] };
  api.histories.set(SIDE, [...pair("t1"), ...pair("t2"), ...pair("s1")]);
  await openOldChat(api);

  await within(await sidePane()).findByText("answer s1");

  expect(api.providerCalls).toContain("threadOpen:claude");
});
