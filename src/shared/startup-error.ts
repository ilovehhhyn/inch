// Describes a failure that stops Margin before any chat can start, in a form the window can show and the user can fix.

export type StartupErrorKind = "codex-missing" | "codex-version" | "codex-crashed" | "codex-protocol" | "signed-out";

/** Plain data that crosses the IPC boundary; `fix` is a command or an instruction the window offers to copy. */
export type StartupErrorInfo = Readonly<{ kind: StartupErrorKind; message: string; fix: string }>;

export class StartupError extends Error {
  readonly info: StartupErrorInfo;

  constructor(info: StartupErrorInfo) {
    super(info.message);
    this.name = "StartupError";
    this.info = info;
  }
}
