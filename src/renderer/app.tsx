// Draws the root layout of the window: the startup error, sign-in, or the app, chosen from the account state.
import { useEffect, useState, type ReactElement } from "react";

import type { ProviderAccount } from "../shared/chat-provider";
import type { MarginApi, StartupStatus } from "../shared/ipc-contract";
import { SignIn } from "./components/SignIn";
import { StartupError } from "./components/StartupError";
import { Workspace } from "./workspace";

export type AppProps = Readonly<{ api: MarginApi }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function crashStatus(error: unknown): StartupStatus {
  return { ok: false, error: { kind: "codex-crashed", message: `Margin could not check Codex: ${messageOf(error)}`, fix: "Restart Margin" } };
}

export function App({ api }: AppProps): ReactElement | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [account, setAccount] = useState<ProviderAccount | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.startupStatus().then(setStatus, (error: unknown) => setStatus(crashStatus(error)));
  }, [api]);

  useEffect(() => api.onFault((error) => setStatus({ ok: false, error })), [api]);

  const isReady = status?.ok === true;
  useEffect(() => {
    if (!isReady) return undefined;
    api.accountRead("codex").then(setAccount, (error: unknown) => setStatus(crashStatus(error)));
    return api.onAuthChanged((event) => {
      const isAccountChange = event.type === "account" || (event.type === "loginCompleted" && event.success);
      if (isAccountChange) api.accountRead("codex").then(setAccount, (error: unknown) => setStatus(crashStatus(error)));
    });
  }, [api, isReady]);

  if (status === null) return null;
  if (!status.ok) return <StartupError error={status.error} copyText={api.copyText} />;
  if (account === null) return null;
  if (!account.signedIn) return <SignIn api={api} />;
  return <Workspace api={api} draft={draft} onDraftChange={setDraft} />;
}
