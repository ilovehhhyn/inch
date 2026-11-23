// @vitest-environment jsdom
// Invariant: Enter sends a plain message and clears the box, Shift+Enter adds a line, and a send is refused while an answer streams.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { expect, test } from "vitest";

import { Composer, BUSY_HINT, type SendMode } from "../../src/renderer/components/Composer";

type Sent = Readonly<{ question: string; mode: SendMode }>;

function Harness(props: Readonly<{ sent: Array<Sent>; interrupts?: Array<true>; busy?: boolean }>): ReactElement {
  const [draft, setDraft] = useState("");
  return (
    <Composer
      draft={draft}
      onDraftChange={setDraft}
      onSend={(question, mode) => props.sent.push({ question, mode })}
      onInterrupt={() => props.interrupts?.push(true)}
      busy={props.busy ?? false}
    />
  );
}

test("enter_sends_plain_and_clears_the_composer", async () => {
  const sent: Array<Sent> = [];
  render(<Harness sent={sent} />);

  await userEvent.type(screen.getByLabelText("Message"), "what is lr?{Enter}");

  expect(sent).toEqual([{ question: "what is lr?", mode: "plain" }]);
  expect(screen.getByLabelText("Message")).toHaveValue("");
});

test("shift_enter_inserts_a_newline", async () => {
  const sent: Array<Sent> = [];
  render(<Harness sent={sent} />);

  await userEvent.type(screen.getByLabelText("Message"), "line one{Shift>}{Enter}{/Shift}line two");

  expect(screen.getByLabelText("Message")).toHaveValue("line one\nline two");
  expect(sent).toEqual([]);
});

test("an_empty_or_blank_message_is_not_sent_and_the_box_says_why", async () => {
  const sent: Array<Sent> = [];
  render(<Harness sent={sent} />);

  await userEvent.type(screen.getByLabelText("Message"), "   {Enter}");

  expect(sent).toEqual([]);
  expect(screen.getByRole("status")).toHaveTextContent("Type a question first");
});

test("enter_while_an_answer_streams_is_refused_with_the_hint_and_keeps_the_draft", async () => {
  const sent: Array<Sent> = [];
  render(<Harness sent={sent} busy />);

  await userEvent.type(screen.getByLabelText("Message"), "next{Enter}");

  expect(sent).toEqual([]);
  expect(screen.getByRole("status")).toHaveTextContent(BUSY_HINT);
  expect(screen.getByLabelText("Message")).toHaveValue("next");
});

test("escape_asks_to_interrupt_only_while_an_answer_streams", async () => {
  const interrupts: Array<true> = [];
  const { rerender } = render(<Harness sent={[]} interrupts={interrupts} />);

  await userEvent.type(screen.getByLabelText("Message"), "{Escape}");
  expect(interrupts).toEqual([]);

  rerender(<Harness sent={[]} interrupts={interrupts} busy />);
  await userEvent.type(screen.getByLabelText("Message"), "{Escape}");
  expect(interrupts).toEqual([true]);
});

test("the_send_button_sends_plain", async () => {
  const sent: Array<Sent> = [];
  render(<Harness sent={sent} />);

  await userEvent.type(screen.getByLabelText("Message"), "hi");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(sent).toEqual([{ question: "hi", mode: "plain" }]);
});
