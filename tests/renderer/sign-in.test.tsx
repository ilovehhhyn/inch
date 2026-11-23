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
