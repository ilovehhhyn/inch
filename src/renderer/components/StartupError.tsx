// Fills the window with a startup failure and its fix, so a missing or wrong Codex never leaves a blank window.
import { useState, type ReactElement } from "react";

import type { StartupErrorInfo } from "../../shared/startup-error";

type CopyState = "idle" | "copied" | "failed";

export type StartupErrorProps = Readonly<{
  error: StartupErrorInfo;
  copyText: (text: string) => Promise<void>;
}>;

export function StartupError({ error, copyText }: StartupErrorProps): ReactElement {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copy = async (): Promise<void> => {
    try {
      await copyText(error.fix);
      setCopyState("copied");
    } catch {
      setCopyState("failed"); // the clipboard refused; the visible command can still be copied by hand
    }
  };
  return (
    <main role="alert">
      <h1>Margin cannot start</h1>
      <p>{error.message}</p>
      <code>{error.fix}</code>
      <button type="button" onClick={() => void copy()}>
        Copy command
      </button>
      {copyState === "copied" ? <p>Copied</p> : null}
      {copyState === "failed" ? <p>Could not copy; select the command and copy it by hand.</p> : null}
    </main>
  );
}
