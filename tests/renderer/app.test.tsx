// @vitest-environment jsdom
// Invariant: a Codex problem disables only Codex, with its message and a Retry, while Claude chats keep working; only a failed startup check fills the window.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import type { StartupStatus } from "../../src/shared/ipc-contract";
import { FakeMarginApi } from "../fakes/fake-margin-api";

function apiWith(status: StartupStatus): FakeMarginApi {
  const api = new FakeMarginApi();
  api.startup = status;
  return api;
}

const CODEX_ERROR = { kind: "codex-version", message: "codex 0.150.1 is not supported", fix: "npm install -g @openai/codex@0.146.0" } as const;

function claudeSignedIn(api: FakeMarginApi): void {
  api.claudeAccount = { provider: "claude", signedIn: true, label: "API key" };
}

test("a_codex_startup_error_keeps_the_app_for_a_claude_user_and_shows_the_error_with_retry_beside_the_chats", async () => {
  const api = apiWith({ ok: false, error: CODEX_ERROR });
  claudeSignedIn(api);

  render(<App api={api} />);

  expect(await screen.findByRole("main", { name: "Margin" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("codex 0.150.1 is not supported");
  expect(screen.getByRole("button", { name: "Retry Codex" })).toBeInTheDocument();
  expect(api.accountReads).not.toContain("codex");
});

test("a_codex_startup_error_with_nobody_signed_in_shows_the_error_on_the_sign_in_page_beside_claude_sign_in", async () => {
  render(<App api={apiWith({ ok: false, error: CODEX_ERROR })} />);

  const openAi = await screen.findByRole("region", { name: "OpenAI" });
  expect(openAi).toHaveTextContent("codex 0.150.1 is not supported");
  expect(openAi).toHaveTextContent(CODEX_ERROR.fix);
  expect(screen.getByRole("button", { name: "Retry Codex" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with Claude Console" })).toBeInTheDocument();
});

test("retry_asks_main_to_start_codex_again_and_clears_the_error_when_it_starts", async () => {
  const api = apiWith({ ok: false, error: CODEX_ERROR });
  claudeSignedIn(api);
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry Codex" }));

  await waitFor(() => expect(api.calls).toContain("codexRetry"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("main", { name: "Margin" })).toBeInTheDocument();
});

test("a_failed_retry_keeps_the_error_with_the_new_message", async () => {
  const api = apiWith({ ok: false, error: CODEX_ERROR });
  claudeSignedIn(api);
  api.retryResult = { ok: false, error: { kind: "codex-missing", message: "codex was not found", fix: "npm install -g @openai/codex@0.146.0" } };
  render(<App api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry Codex" }));

  expect(await screen.findByText(/codex was not found/)).toBeInTheDocument();
});

test("a_codex_account_check_that_fails_disables_codex_and_keeps_claude", async () => {
  const api = new FakeMarginApi();
  claudeSignedIn(api);
  const original = api.accountRead;
  api.accountRead = async (provider) => {
    if (provider === "codex") throw new Error("Codex is not running; the app-server has not started or is restarting");
    return original(provider);
  };

  render(<App api={api} />);

  expect(await screen.findByRole("main", { name: "Margin" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Codex is not running");
});

test("a_supported_codex_shows_the_app", async () => {
  render(<App api={apiWith({ ok: true, codexVersion: "0.146.0" })} />);

  expect(await screen.findByRole("main", { name: "Margin" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a_failing_startup_check_is_shown_not_left_as_a_blank_window", async () => {
  const api = new FakeMarginApi();
  api.startupStatus = async () => {
    throw new Error("ipc closed");
  };

  render(<App api={api} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("ipc closed");
});

test("a_fault_reported_after_start_up_shows_its_message_and_fix_beside_the_chats_and_keeps_the_window", async () => {
  const api = new FakeMarginApi();
  claudeSignedIn(api);
  render(<App api={api} />);
  await screen.findByRole("main", { name: "Margin" });

  act(() => api.emitFault({ kind: "codex-protocol", message: "unsupported account type `chatgptAuthTokens`", fix: "sign out of Codex and sign in with ChatGPT" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("unsupported account type `chatgptAuthTokens`");
  expect(screen.getByRole("main", { name: "Margin" })).toBeInTheDocument();
});
