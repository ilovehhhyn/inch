// @vitest-environment jsdom
// Invariant: a new chat starts on the provider the person chose, a window with one signed-in provider uses it, and an account change read from a provider event shows the sign-in page.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";

const CLAUDE_SIGNED_IN = { provider: "claude", signedIn: true, label: "API key" } as const;

async function send(text: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText("Message"), `${text}{Enter}`);
}

test("with_both_providers_signed_in_a_new_chat_starts_on_the_chosen_one", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);

  await userEvent.selectOptions(await screen.findByLabelText("New chats use"), "claude");
  await send("hello");

  await waitFor(() => expect(api.providerCalls).toEqual(["threadStart:claude", "turnStart:claude"]));
});

test("with_both_signed_in_a_new_chat_defaults_to_openai", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);

  await send("hello");

  await waitFor(() => expect(api.providerCalls).toEqual(["threadStart:codex", "turnStart:codex"]));
});

test("with_only_claude_signed_in_there_is_no_choice_and_a_new_chat_uses_claude", async () => {
  const api = new FakeMarginApi();
  api.account = { signedIn: false };
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);

  await send("hello");

  expect(screen.queryByLabelText("New chats use")).toBeNull();
  await waitFor(() => expect(api.providerCalls).toEqual(["threadStart:claude", "turnStart:claude"]));
});

test("a_chat_keeps_its_provider_when_the_choice_for_new_chats_changes", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  await send("first");
  await waitFor(() => expect(api.turnStarts).toHaveLength(1));
  act(() => api.emitProvider({ type: "completed", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-1"), status: "completed", error: null }));

  await userEvent.selectOptions(screen.getByLabelText("New chats use"), "claude");
  await send("second");

  await waitFor(() => expect(api.providerCalls).toEqual(["threadStart:codex", "turnStart:codex", "turnStart:codex"]));
});

test("an_account_change_event_from_a_provider_reads_the_accounts_again", async () => {
  const api = new FakeMarginApi();
  api.account = { signedIn: false };
  api.claudeAccount = CLAUDE_SIGNED_IN;
  render(<App api={api} />);
  await screen.findByLabelText("Message");

  api.claudeAccount = { provider: "claude", signedIn: false, label: null };
  act(() => api.emitProvider({ type: "accountChanged", provider: "claude" }));

  expect(await screen.findByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
});
