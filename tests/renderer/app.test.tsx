// @vitest-environment jsdom
// Invariant: the window shows the startup error when Codex cannot start, and the app when it can.
import { act, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import type { StartupStatus } from "../../src/shared/ipc-contract";
import { FakeMarginApi } from "../fakes/fake-margin-api";

function apiWith(status: StartupStatus): FakeMarginApi {
  const api = new FakeMarginApi();
  api.startup = status;
  return api;
}

test("a_startup_error_replaces_the_whole_window", async () => {
  const error = { kind: "codex-version", message: "codex 0.150.1 is not supported", fix: "npm install -g @openai/codex@0.146.0" } as const;

  render(<App api={apiWith({ ok: false, error })} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("codex 0.150.1 is not supported");
  expect(screen.queryByRole("main", { name: "Margin" })).toBeNull();
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

test("a_fault_reported_after_start_up_replaces_the_window_with_its_message_and_fix", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await screen.findByRole("main", { name: "Margin" });

  act(() => api.emitFault({ kind: "codex-protocol", message: "unsupported account type `chatgptAuthTokens`", fix: "sign out of Codex and sign in with ChatGPT" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("unsupported account type `chatgptAuthTokens`");
  expect(screen.queryByRole("main", { name: "Margin" })).toBeNull();
});
