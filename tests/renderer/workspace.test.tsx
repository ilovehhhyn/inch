// @vitest-environment jsdom
// Invariant: Enter sends the question as a plain turn on a thread the window starts when needed, and streamed text appears in that thread.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";

import { App } from "../../src/renderer/app";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import { CODEX_DEFAULT_CHOICE, FakeMarginApi } from "../fakes/fake-margin-api";
import { installFakeLayout } from "../fakes/fake-layout";

const THREAD = asThreadId("thread-1");

async function typeAndSend(text: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText("Message"), `${text}{Enter}`);
}

test("a_plain_enter_message_starts_a_thread_sends_a_context_free_turn_and_streams_the_answer", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await typeAndSend("what is lr?");

  await waitFor(() => expect(api.turnStarts).toEqual([{ threadId: THREAD, question: "what is lr?", contextText: null, choice: CODEX_DEFAULT_CHOICE }]));
  expect(api.calls.filter((call) => call === "threadStart")).toHaveLength(1);
  expect(await screen.findByText("what is lr?")).toBeInTheDocument();
  act(() => api.emitProvider({ type: "delta", threadId: THREAD, turnId: asTurnId("turn-1"), text: "The step size." }));
  expect(await screen.findByText("The step size.")).toBeInTheDocument();
});

test("a_second_message_reuses_the_thread_once_the_answer_is_complete", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await typeAndSend("first");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: THREAD, turnId: asTurnId("turn-1"), status: "completed", error: null }));

  await typeAndSend("second");

  await waitFor(() => expect(api.turnStarts.map((start) => [start.threadId, start.question])).toEqual([[THREAD, "first"], [THREAD, "second"]]));
  expect(api.calls.filter((call) => call === "threadStart")).toHaveLength(1);
});

test("events_that_arrive_before_turn_start_answers_are_not_lost", async () => {
  const api = new FakeMarginApi();
  const original = api.turnStart;
  api.turnStart = async (provider, threadId, question, contextText, choice, attachmentIds) => {
    const turnId = await original(provider, threadId, question, contextText, choice, attachmentIds);
    api.emitProvider({ type: "delta", threadId, turnId, text: "early text" });
    return turnId;
  };
  render(<App api={api} />);

  await typeAndSend("q");

  expect(await screen.findByText("early text")).toBeInTheDocument();
});

test("a_rejected_turn_start_shows_the_error_and_keeps_the_typed_question", async () => {
  const api = new FakeMarginApi();
  api.turnStart = async () => {
    throw new Error("Codex is not running; the app-server has not started or is restarting");
  };
  render(<App api={api} />);

  await typeAndSend("q");

  expect(await screen.findByRole("alert")).toHaveTextContent("Codex is not running");
  expect(screen.getByLabelText("Message")).toHaveValue("q");
});

test("selecting_a_stored_chat_opens_it_and_shows_its_messages", async () => {
  const api = new FakeMarginApi();
  api.threads = [{ id: asThreadId("old-1"), provider: "codex", title: "Fine-tuning plan", updatedAtSec: 5 }];
  api.histories.set(asThreadId("old-1"), [
    { turnId: asTurnId("t1"), role: "user", text: "plan?", status: "done" },
    { turnId: asTurnId("t1"), role: "assistant", text: "Warm up first.", status: "done" },
  ]);
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Fine-tuning plan" }));

  expect(await screen.findByText("Warm up first.")).toBeInTheDocument();
  expect(api.calls).toContain("threadOpen:old-1");
});

test("new_chat_clears_the_main_pane_and_the_next_message_starts_another_thread", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await typeAndSend("first");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: THREAD, turnId: asTurnId("turn-1"), status: "completed", error: null }));

  await userEvent.click(screen.getByRole("button", { name: "+ New chat" }));
  expect(screen.queryByText("first")).toBeNull();
  await typeAndSend("fresh");

  await waitFor(() => expect(api.turnStarts[1]?.threadId).toBe("thread-2"));
});

const CRASH = "Codex stopped unexpectedly. Retry";

test("a_crashed_turn_shows_a_retry_button_that_resends_the_same_question_with_the_same_context", async () => {
  const restoreLayout = installFakeLayout();
  onTestFinished(restoreLayout);
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "what is lr?");
  await userEvent.keyboard("{Meta>}i{/Meta}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: THREAD, turnId: asTurnId("turn-1"), status: "failed", error: CRASH }));
  expect(await screen.findByRole("alert")).toHaveTextContent(CRASH);

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(api.turnStarts).toHaveLength(2));
  expect(api.turnStarts[1]).toEqual(api.turnStarts[0]);
  expect(api.turnStarts[0]?.contextText).toContain("MARGIN SCREEN CONTEXT v1");
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => api.emitProvider({ type: "delta", threadId: THREAD, turnId: asTurnId("turn-2"), text: "The step size." }));
  expect(await screen.findByText("The step size.")).toBeInTheDocument();
});

test("a_chat_with_no_failure_has_no_retry_button", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "q{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("retry_is_refused_while_another_answer_is_streaming", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "q{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: THREAD, turnId: asTurnId("turn-1"), status: "failed", error: CRASH }));
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.turnStarts).toHaveLength(2));

  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("command_i_with_nothing_to_read_fails_visibly_and_keeps_the_typed_question", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await userEvent.type(await screen.findByLabelText("Message"), "what is this?");
  await userEvent.keyboard("{Meta>}i{/Meta}");

  expect(await screen.findByRole("alert")).toHaveTextContent(/viewport height must be positive/);
  expect(screen.getByLabelText("Message")).toHaveValue("what is this?");
  expect(api.turnStarts).toEqual([]);
});

test("a_successful_send_clears_the_draft", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await typeAndSend("hello");

  await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
});

test("a_new_chat_names_its_provider_when_the_thread_starts_and_on_every_turn", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await typeAndSend("what is lr?");

  await waitFor(() => expect(api.providerCalls).toEqual(["threadStart:codex", "turnStart:codex"]));
});

test("a_stored_chat_is_opened_and_continued_with_the_provider_of_its_list_entry", async () => {
  const api = new FakeMarginApi();
  api.threads = [{ id: asThreadId("claude-1"), provider: "claude", title: "A Claude chat", updatedAtSec: 5 }];
  api.histories.set(asThreadId("claude-1"), [
    { turnId: asTurnId("t1"), role: "user", text: "plan?", status: "done" },
    { turnId: asTurnId("t1"), role: "assistant", text: "Warm up first.", status: "done" },
  ]);
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "A Claude chat" }));
  await screen.findByText("Warm up first.");

  await typeAndSend("and then?");

  await waitFor(() => expect(api.providerCalls).toEqual(["threadOpen:claude", "turnStart:claude"]));
});

test("interrupting_a_turn_names_the_provider_of_its_chat", async () => {
  const api = new FakeMarginApi();
  api.threads = [{ id: asThreadId("claude-1"), provider: "claude", title: "A Claude chat", updatedAtSec: 5 }];
  api.histories.set(asThreadId("claude-1"), []);
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "A Claude chat" }));
  await typeAndSend("first");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  await userEvent.type(screen.getByLabelText("Message"), "{Escape}");

  await waitFor(() => expect(api.providerCalls).toContain("turnInterrupt:claude"));
});
