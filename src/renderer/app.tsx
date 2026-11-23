// Draws the root layout of the window: the startup error, sign-in, or the app, chosen from the account state.
import { useEffect, useState, type ReactElement } from "react";

import type { AccountSummary } from "../shared/auth";
import type { MarginApi, StartupStatus } from "../shared/ipc-contract";
import { Composer } from "./components/Composer";
import { SignIn } from "./components/SignIn";
import { StartupError } from "./components/StartupError";

export type AppProps = Readonly<{ api: MarginApi }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function crashStatus(error: unknown): StartupStatus {
  return { ok: false, error: { kind: "codex-crashed", message: `Margin could not check Codex: ${messageOf(error)}`, fix: "Restart Margin" } };
}

export function App({ api }: AppProps): ReactElement | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.startupStatus().then(setStatus, (error: unknown) => setStatus(crashStatus(error)));
  }, [api]);

  const isReady = status?.ok === true;
  useEffect(() => {
    if (!isReady) return undefined;
    api.authRead().then(setAccount, (error: unknown) => setStatus(crashStatus(error)));
    return api.onAuthChanged((event) => {
      if (event.type === "account") setAccount(event.summary);
      if (event.type === "loginCompleted" && event.success) api.authRead().then(setAccount, (error: unknown) => setStatus(crashStatus(error)));
    });
  }, [api, isReady]);

  if (status === null) return null;
  if (!status.ok) return <StartupError error={status.error} copyText={api.copyText} />;
  if (account === null) return null;
  if (!account.signedIn) return <SignIn api={api} />;
  return (
    <main aria-label="Margin">
      <Composer draft={draft} onDraftChange={setDraft} />
    </main>
  );
}
