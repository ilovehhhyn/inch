// @vitest-environment jsdom
// Invariant: Command-I sends the text visible in the pane scrolled last, Enter sends none, and nothing on screen reveals the difference.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { BUSY_HINT } from "../../src/renderer/components/Composer";
import { renderContextBlock } from "../../src/shared/context-format";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import type { HistoryMessage } from "../../src/shared/thread-history";
import { FakeMarginApi } from "../fakes/fake-margin-api";
import { installFakeLayout, userScroll } from "../fakes/fake-layout";

const OLD = asThreadId("old-1");
let restoreLayout = (): void => undefined;

beforeEach(() => {
  restoreLayout = installFakeLayout();
});
afterEach(() => restoreLayout());

/** Three question-and-answer pairs: six blocks, `message 1 (user)` to `message 6 (assistant)`. */
function threeExchanges(): Array<HistoryMessage> {
  return [1, 2, 3].flatMap((n) => [
    { turnId: asTurnId(`t${n}`), role: "user" as const, text: `question ${n}`, status: "done" as const },
    { turnId: asTurnId(`t${n}`), role: "assistant" as const, text: `answer ${n}`, status: "done" as const },
  ]);
}

async function openOldChat(api: FakeMarginApi): Promise<HTMLElement> {
  api.threads = [{ id: OLD, title: "Fine-tuning plan", updatedAtSec: 5 }];
  api.histories.set(OLD, threeExchanges());
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Fine-tuning plan" }));
  await screen.findByText("answer 3");
  const view = document.querySelector(".chat-pane .view");
  if (!(view instanceof HTMLElement)) throw new Error("the main pane did not render");
  return view;
}

const COMMAND_I = "{Meta>}i{/Meta}";

function context(blocks: Array<[string, string]>): string {
  return renderContextBlock({ paneKind: "chat", paneTitle: "Fine-tuning plan", blocks: blocks.map(([label, text]) => ({ label, text })) });
}

test("command_i_sends_the_context_of_the_pane_scrolled_last_before_the_question", async () => {
  const api = new FakeMarginApi();
  const view = await openOldChat(api);
  act(() => userScroll(view, 300));

  await userEvent.type(screen.getByLabelText("Message"), "what is this?");
  await userEvent.keyboard(COMMAND_I);

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.turnStarts[0]).toEqual({
    threadId: OLD,
    question: "what is this?",
    contextText: context([["message 4 (assistant)", "answer 2"], ["message 5 (user)", "question 3"], ["message 6 (assistant)", "answer 3"]]),
  });
});

test("without_a_scroll_command_i_reads_the_pane_that_has_keyboard_focus", async () => {
  const api = new FakeMarginApi();
  await openOldChat(api);

  await userEvent.type(screen.getByLabelText("Message"), "what is this?");
  await userEvent.keyboard(COMMAND_I);

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.turnStarts[0]?.contextText).toBe(
    context([["message 1 (user)", "question 1"], ["message 2 (assistant)", "answer 1"], ["message 3 (user)", "question 2"], ["message 4 (assistant)", "answer 2"], ["message 5 (user)", "question 3"], ["message 6 (assistant)", "answer 3"]]),
  );
});

test("enter_sends_without_context", async () => {
  const api = new FakeMarginApi();
  const view = await openOldChat(api);
  act(() => userScroll(view, 300));

  await userEvent.type(screen.getByLabelText("Message"), "plain question{Enter}");

  await waitFor(() => expect(api.turnStarts).toEqual([{ threadId: OLD, question: "plain question", contextText: null }]));
});

test("command_i_changes_nothing_on_screen", async () => {
  const api = new FakeMarginApi();
  const view = await openOldChat(api);
  const outsideThread = (): string => {
    const copy = document.body.cloneNode(true) as HTMLElement; // a detached copy, so removing the thread leaves the live page alone
    copy.querySelector(".thread")?.remove();
    return copy.innerHTML;
  };
  const before = outsideThread();
  act(() => userScroll(view, 300));

  await userEvent.type(screen.getByLabelText("Message"), "what is this?");
  await userEvent.keyboard(COMMAND_I);
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  expect(screen.getByLabelText("Message")).toHaveValue("");
  expect(outsideThread()).toBe(before);
  expect(document.body.textContent).not.toMatch(/context|attached|screen/i);
  expect(document.querySelectorAll("img, svg, [role='img']")).toHaveLength(0);
});

test("command_i_during_streaming_is_refused_with_a_hint", async () => {
  const api = new FakeMarginApi();
  await openOldChat(api);
  await userEvent.type(screen.getByLabelText("Message"), "first{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));

  await userEvent.type(screen.getByLabelText("Message"), "second");
  await userEvent.keyboard(COMMAND_I);

  expect(await screen.findByText(BUSY_HINT)).toBeInTheDocument();
  expect(api.turnStarts).toHaveLength(1);
  expect(screen.getByLabelText("Message")).toHaveValue("second");
});

test("escape_interrupts_the_active_turn", async () => {
  const api = new FakeMarginApi();
  await openOldChat(api);
  await userEvent.type(screen.getByLabelText("Message"), "first{Enter}");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  await screen.findByRole("status", { name: "Thinking" });

  await userEvent.type(screen.getByLabelText("Message"), "{Escape}");

  await waitFor(() => expect(api.interrupts).toEqual([{ threadId: OLD, turnId: asTurnId("turn-1") }]));
});

test("a_message_sent_with_context_resets_the_scrolled_pane_for_the_next_message", async () => {
  const api = new FakeMarginApi();
  const view = await openOldChat(api);
  act(() => userScroll(view, 300));
  await userEvent.type(screen.getByLabelText("Message"), "one");
  await userEvent.keyboard(COMMAND_I);
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: OLD, turnId: asTurnId("turn-1"), status: "completed", error: null }));
  act(() => {
    view.scrollTop = 0;
  });

  await userEvent.type(screen.getByLabelText("Message"), "two");
  await userEvent.keyboard(COMMAND_I);

  await waitFor(() => expect(api.turnStarts).toHaveLength(2));
  expect(api.turnStarts[1]?.contextText).toContain("--- message 1 (user)\nquestion 1");
});
