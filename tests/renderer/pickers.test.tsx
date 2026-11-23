// @vitest-environment jsdom
// Invariant: the composer offers the model and reasoning level of the chosen provider, keeps a level only when the model has it, shows the provider choice only on a new chat, and sends the choice it shows.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { Composer } from "../../src/renderer/components/Composer";
import type { ModelChoice, ModelOption } from "../../src/shared/models";
import { asThreadId } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";

const WIDE: ModelOption = { provider: "codex", id: "wide", label: "Wide", reasoningLevels: ["low", "medium", "high"], defaultReasoning: "medium", acceptsImages: true, acceptsPdfs: false };
const NARROW: ModelOption = { provider: "codex", id: "narrow", label: "Narrow", reasoningLevels: ["medium", "high"], defaultReasoning: "medium", acceptsImages: false, acceptsPdfs: false };
const CLAUDE_SIGNED_IN = { provider: "claude", signedIn: true, label: "API key" } as const;

function Harness(props: Readonly<{ start: ModelChoice; changes: Array<ModelChoice> }>): ReactElement {
  const [draft, setDraft] = useState("");
  const [choice, setChoice] = useState(props.start);
  return (
    <Composer
      draft={draft}
      onDraftChange={setDraft}
      onSend={async () => true}
      onInterrupt={() => undefined}
      busy={false}
      pickers={{
        models: [WIDE, NARROW],
        choice,
        onChoiceChange: (next) => {
          props.changes.push(next);
          setChoice(next);
        },
      }}
    />
  );
}

test("reasoning_choices_follow_the_chosen_model", async () => {
  const changes: Array<ModelChoice> = [];
  render(<Harness start={{ model: "wide", reasoning: "low" }} changes={changes} />);
  expect([...screen.getByLabelText("Reasoning").querySelectorAll("option")].map((option) => option.value)).toEqual(["low", "medium", "high"]);

  await userEvent.selectOptions(screen.getByLabelText("Model"), "narrow");

  expect(changes).toEqual([{ model: "narrow", reasoning: "medium" }]);
  expect(screen.getByLabelText("Reasoning")).toHaveValue("medium");
  expect([...screen.getByLabelText("Reasoning").querySelectorAll("option")].map((option) => option.value)).toEqual(["medium", "high"]);
  expect(screen.getByRole("status")).toHaveTextContent("Reasoning set to medium; this model has no low");
});

test("a_level_the_new_model_has_is_kept_without_a_note", async () => {
  const changes: Array<ModelChoice> = [];
  render(<Harness start={{ model: "wide", reasoning: "high" }} changes={changes} />);

  await userEvent.selectOptions(screen.getByLabelText("Model"), "narrow");

  expect(changes).toEqual([{ model: "narrow", reasoning: "high" }]);
  expect(screen.queryByRole("status")).toBeNull();
});

test("a_stored_level_the_model_does_not_offer_is_shown_as_unavailable_not_replaced", () => {
  render(<Harness start={{ model: "wide", reasoning: "turbo" }} changes={[]} />);

  const option = screen.getByRole("option", { name: "turbo (not offered)" });
  expect(option).toBeDisabled();
  expect(screen.getByLabelText("Reasoning")).toHaveValue("turbo");
});

test("a_stored_model_that_is_not_offered_is_shown_as_unavailable_not_replaced", () => {
  render(<Harness start={{ model: "retired", reasoning: "low" }} changes={[]} />);

  expect(screen.getByRole("option", { name: "retired (not offered)" })).toBeDisabled();
  expect(screen.getByLabelText("Model")).toHaveValue("retired");
});

test("provider_picker_is_only_on_a_new_chat", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  expect(await screen.findByLabelText("Provider")).toBeInTheDocument();
  expect([...screen.getByLabelText("Provider").querySelectorAll("option")].map((option) => [option.value, option.textContent])).toEqual([["codex", "OpenAI"], ["claude", "Claude"]]);

  await userEvent.type(screen.getByLabelText("Message"), "hello{Enter}");

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(screen.queryByLabelText("Provider")).toBeNull();
});

test("the_provider_picker_is_absent_when_only_one_provider_is_signed_in", async () => {
  render(<App api={new FakeMarginApi()} />);

  await screen.findByLabelText("Message");

  expect(screen.queryByLabelText("Provider")).toBeNull();
});

test("switching_the_new_chat_provider_shows_that_providers_models_and_default_level", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-sol"));

  await userEvent.selectOptions(screen.getByLabelText("Provider"), "claude");

  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-5-5"));
  expect(screen.getByLabelText("Reasoning")).toHaveValue("low");
});

test("the_choice_shown_is_the_choice_sent_and_the_chat_keeps_it", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await waitFor(() => expect(screen.getByLabelText("Reasoning")).toHaveValue("medium"));

  await userEvent.selectOptions(screen.getByLabelText("Reasoning"), "high");
  await userEvent.type(screen.getByLabelText("Message"), "first{Enter}");

  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  expect(api.turnStarts[0]?.choice).toEqual({ model: "gpt-5.6-sol", reasoning: "high" });
  expect(screen.getByLabelText("Reasoning")).toHaveValue("high");
});

test("a_chats_last_choice_is_preselected_when_the_chat_is_opened", async () => {
  const api = new FakeMarginApi();
  api.threads = [{ id: asThreadId("thread-9"), provider: "codex", title: "Old chat", updatedAtSec: 1 }];
  api.choices.set(asThreadId("thread-9"), { model: "gpt-5.6-sol", reasoning: "low" });
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Old chat" }));

  await waitFor(() => expect(screen.getByLabelText("Reasoning")).toHaveValue("low"));
});
