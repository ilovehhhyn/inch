// @vitest-environment jsdom
// Invariant: a startup failure fills the window with its message and offers the fix command for copying.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { StartupError } from "../../src/renderer/components/StartupError";
import type { StartupErrorInfo } from "../../src/shared/startup-error";

const ERROR: StartupErrorInfo = {
  kind: "codex-missing",
  message: "codex was not found on PATH; install it with `npm install -g @openai/codex@0.146.0`",
  fix: "npm install -g @openai/codex@0.146.0",
};

test("the_message_and_fix_are_shown_in_the_window", () => {
  render(<StartupError error={ERROR} copyText={async () => undefined} />);

  expect(screen.getByRole("alert")).toHaveTextContent(ERROR.message);
  expect(screen.getByText(ERROR.fix, { selector: "code" })).toBeInTheDocument();
});

test("copy_command_copies_exactly_the_fix", async () => {
  const copied: Array<string> = [];
  render(<StartupError error={ERROR} copyText={async (text) => void copied.push(text)} />);

  await userEvent.click(screen.getByRole("button", { name: "Copy command" }));

  expect(copied).toEqual([ERROR.fix]);
  expect(await screen.findByText("Copied")).toBeInTheDocument();
});

test("a_failed_copy_tells_the_user_to_copy_by_hand", async () => {
  render(
    <StartupError
      error={ERROR}
      copyText={async () => {
        throw new Error("denied");
      }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Copy command" }));

  expect(await screen.findByText(/select the command and copy it by hand/)).toBeInTheDocument();
  expect(screen.queryByText("Copied")).toBeNull();
});
