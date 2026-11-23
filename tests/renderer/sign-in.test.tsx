// @vitest-environment jsdom
// Invariant: the window shows sign-in whenever there is no account, never shows secrets, and keeps the unsent draft.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { FakeMarginApi, SIGNED_IN_CHATGPT } from "../fakes/fake-margin-api";

function signedOutApi(): FakeMarginApi {
  const api = new FakeMarginApi();
  api.account = { signedIn: false };
  return api;
}

test("a_signed_out_account_shows_the_three_ways_to_sign_in", async () => {
  render(<App api={signedOutApi()} />);

  expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in with a device code" })).toBeInTheDocument();
  expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
  expect(screen.queryByLabelText("Message")).toBeNull();
});

test("chatgpt_sign_in_asks_the_app_server_and_waits_for_the_browser", async () => {
  const api = signedOutApi();
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));

  expect(api.calls).toEqual(["start:chatgpt"]);
  expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
});

test("device_code_login_shows_the_user_code", async () => {
  const api = signedOutApi();
  api.loginStarted = { kind: "chatgptDeviceCode", loginId: "login-2", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Sign in with a device code" }));

  expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
  expect(screen.getByText("https://auth.openai.com/codex/device")).toBeInTheDocument();
});

test("cancel_during_a_login_cancels_it_by_login_id_and_returns_to_the_choices", async () => {
  const api = signedOutApi();
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));

  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

  expect(api.calls).toEqual(["start:chatgpt", "cancel:login-1"]);
  expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
});

test("failed_login_shows_the_server_error", async () => {
  const api = signedOutApi();
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));

  act(() => api.emit({ type: "loginCompleted", success: false, error: "denied" }));

  expect(await screen.findByText("Sign-in failed: denied")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
});

test("successful_login_reads_the_account_and_shows_the_app", async () => {
  const api = signedOutApi();
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT" }));

  api.account = SIGNED_IN_CHATGPT;
  act(() => api.emit({ type: "loginCompleted", success: true, error: null }));

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).toBeNull();
});

test("api_key_is_sent_once_cleared_from_the_field_and_never_rendered", async () => {
  const api = signedOutApi();
  render(<App api={api} />);

  await userEvent.type(await screen.findByLabelText("OpenAI API key"), "sk-test-123");
  await userEvent.click(screen.getByRole("button", { name: "Sign in with API key" }));

  expect(api.apiKeys).toEqual(["sk-test-123"]);
  expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
  expect(document.body.textContent).not.toContain("sk-test-123");
});

test("the_api_key_field_hides_what_is_typed", async () => {
  render(<App api={signedOutApi()} />);

  expect(await screen.findByLabelText("OpenAI API key")).toHaveAttribute("type", "password");
});

test("signed_out_mid_session_returns_to_sign_in", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "unsent question");

  api.account = { signedIn: false };
  act(() => api.emit({ type: "account", summary: api.account }));
  expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Message")).toBeNull();
  api.account = SIGNED_IN_CHATGPT;
  act(() => api.emit({ type: "account", summary: SIGNED_IN_CHATGPT }));

  expect(await screen.findByLabelText("Message")).toHaveValue("unsent question");
});

const ANT_MISSING = "ant was not found on PATH; install it with `brew install anthropics/tap/ant` as described in Anthropic's CLI docs, or use an API key instead";
const CLAUDE_ACCOUNT_KEY = { provider: "claude", signedIn: true, label: "API key" } as const;
const CLAUDE_ACCOUNT_CONSOLE = { provider: "claude", signedIn: true, label: "Claude Console" } as const;

test("a_signed_out_window_offers_claude_console_and_an_anthropic_api_key", async () => {
  render(<App api={signedOutApi()} />);

  expect(await screen.findByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use an Anthropic API key" })).toBeInTheDocument();
});

test("missing_ant_names_the_install_step", async () => {
  const api = signedOutApi();
  api.claudeSignInError = new Error(ANT_MISSING);
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Sign in with Claude Console" }));

  expect(await screen.findByText(`Sign-in failed: ${ANT_MISSING}`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
});

test("console_sign_in_waits_for_the_browser_then_reads_the_account_and_shows_the_app", async () => {
  const api = signedOutApi();
  let finish: () => void = () => undefined;
  api.claudeSignInConsole = () => new Promise<void>((resolve) => {
    api.calls.push("claudeSignInConsole");
    finish = resolve;
  });
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Sign in with Claude Console" }));
  expect(await screen.findByText("Finish signing in to Claude in your browser.")).toBeInTheDocument();
  api.claudeAccount = CLAUDE_ACCOUNT_CONSOLE;
  act(() => finish());

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
});

test("anthropic_api_key_is_sent_once_cleared_from_the_field_and_never_rendered", async () => {
  const api = signedOutApi();
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Use an Anthropic API key" }));

  const field = screen.getByLabelText("Anthropic API key");
  expect(field).toHaveAttribute("type", "password");
  await userEvent.type(field, "sk-ant-test-123");
  api.claudeAccount = CLAUDE_ACCOUNT_KEY;
  await userEvent.click(screen.getByRole("button", { name: "Save Anthropic API key" }));

  expect(api.claudeApiKeys).toEqual(["sk-ant-test-123"]);
  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("sk-ant-test-123");
});

test("invalid_key_is_not_saved", async () => {
  const api = signedOutApi();
  api.claudeSignInError = new Error("Anthropic rejected this API key; check that you copied the whole key and that it has not been revoked");
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Use an Anthropic API key" }));
  await userEvent.type(screen.getByLabelText("Anthropic API key"), "sk-ant-bad");

  await userEvent.click(screen.getByRole("button", { name: "Save Anthropic API key" }));

  expect(await screen.findByText(/Anthropic rejected this API key/)).toBeInTheDocument();
  expect(screen.getByLabelText("Anthropic API key")).toHaveValue("");
  expect(screen.queryByLabelText("Message")).toBeNull();
  expect(document.body.textContent).not.toContain("sk-ant-bad");
});

test("no_claude_ai_login_is_offered", async () => {
  render(<App api={signedOutApi()} />);
  await screen.findByRole("button", { name: "Sign in with Claude Console" });
  await userEvent.click(screen.getByRole("button", { name: "Use an Anthropic API key" }));

  const screenText = document.body.textContent ?? "";

  expect(screenText).not.toMatch(/claude\.ai/i);
  expect(screenText).not.toMatch(/\bPro\b/);
  expect(screenText).not.toMatch(/\bMax\b/);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).not.toContain("Sign in with Claude");
});

test("a_window_with_only_a_claude_account_shows_the_app_and_never_the_sign_in_screen", async () => {
  const api = signedOutApi();
  api.claudeAccount = CLAUDE_ACCOUNT_KEY;
  render(<App api={api} />);

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with Claude Console" })).toBeNull();
});

test("the_accounts_page_shows_each_signed_in_provider_with_its_label_and_signs_out_of_claude", async () => {
  const api = new FakeMarginApi();
  api.claudeAccount = CLAUDE_ACCOUNT_KEY;
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Accounts" }));

  expect(await screen.findByText("Signed in with ChatGPT Plus")).toBeInTheDocument();
  expect(screen.getByText("Signed in with API key")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Sign out of Claude" }));

  expect(api.calls).toContain("claudeSignOut");
  expect(await screen.findByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
});

test("closing_the_accounts_page_returns_to_the_chat_with_the_draft_kept", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await userEvent.type(await screen.findByLabelText("Message"), "unsent");
  await userEvent.click(screen.getByRole("button", { name: "Accounts" }));

  await userEvent.click(await screen.findByRole("button", { name: "Close" }));

  expect(await screen.findByLabelText("Message")).toHaveValue("unsent");
});
