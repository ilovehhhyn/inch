// @vitest-environment jsdom
// Invariant: an answer written by another model says so, and a rejected Claude sign-in offers a working "Sign in again" button.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { beginTurn, EMPTY_THREAD, reduceThread } from "../../src/renderer/state/thread-reducer";
import { asThreadId, asTurnId, CLAUDE_SIGN_IN_EXPIRED } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";

const THREAD = asThreadId("thread-1");
const TURN = asTurnId("turn-1");
const CLAUDE_SIGNED_IN = { provider: "claude", signedIn: true, label: "API key" } as const;

test("the_reducer_keeps_the_serving_model_on_the_answer", () => {
  const started = beginTurn(EMPTY_THREAD, { turnId: TURN, question: "q" });

  const done = reduceThread(started, { type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null, servedBy: "claude-opus-4-8" });

  expect(done.messages[1]).toMatchObject({ role: "assistant", status: "done", servedBy: "claude-opus-4-8" });
  expect(reduceThread(started, { type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null }).messages[1]).not.toHaveProperty("servedBy");
});

test("an_answer_from_another_model_has_an_answered_by_line_and_one_from_the_chats_model_has_none", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "hello{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  act(() => {
    api.emitProvider({ type: "delta", threadId: THREAD, turnId: TURN, text: "Hi there" });
    api.emitProvider({ type: "completed", threadId: THREAD, turnId: TURN, status: "completed", error: null, servedBy: "claude-opus-4-8" });
  });

  expect(await screen.findByText("Answered by claude-opus-4-8")).toBeInTheDocument();
});

test("a_reopened_chat_shows_the_answered_by_line_from_its_history", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  api.threads = [{ id: THREAD, provider: "claude", title: "Old", updatedAtSec: 1 }];
  api.histories.set(THREAD, [
    { turnId: TURN, role: "user", text: "q", status: "done" },
    { turnId: TURN, role: "assistant", text: "a", status: "done", servedBy: "claude-opus-4-8" },
  ]);
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Old" }));

  expect(await screen.findByText("Answered by claude-opus-4-8")).toBeInTheDocument();
});

test("a_rejected_sign_in_shows_a_sign_in_again_button_that_opens_the_accounts_page", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  await userEvent.selectOptions(await screen.findByLabelText("Provider"), "claude");
  await userEvent.type(screen.getByLabelText("Message"), "hello{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  api.claudeAccount = { provider: "claude", signedIn: false, label: null };
  act(() => {
    api.emitProvider({ type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: CLAUDE_SIGN_IN_EXPIRED });
    api.emitProvider({ type: "accountChanged", provider: "claude" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Sign in again" }));

  expect(await screen.findByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
});

test("another_failure_has_no_sign_in_again_button", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "hello{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  act(() => api.emitProvider({ type: "completed", threadId: THREAD, turnId: TURN, status: "failed", error: "Codex stopped" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Codex stopped");
  expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
});
