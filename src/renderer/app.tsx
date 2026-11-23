// Draws the root layout of the window: the startup error, the sign-in page, or the app, chosen from the account state.
import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { ProviderAccount } from "../shared/chat-provider";
import type { MarginApi, StartupStatus } from "../shared/ipc-contract";
import { PROVIDER_IDS, type ProviderId } from "../shared/provider-id";
import { SignIn } from "./components/SignIn";
import { StartupError } from "./components/StartupError";
import { startWavRecording } from "./voice/wav-recorder";
import { Workspace, type VoiceEnvironment } from "./workspace";

/** The voice parts of the window; the default records the microphone, and tests pass a fake recorder. */
const DEFAULT_VOICE: VoiceEnvironment = { startRecording: startWavRecording };

export type AppProps = Readonly<{ api: MarginApi; voice?: VoiceEnvironment }>;

type Accounts = Readonly<Record<ProviderId, ProviderAccount>>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function crashStatus(error: unknown): StartupStatus {
  return { ok: false, error: { kind: "codex-crashed", message: `Margin could not check Codex: ${messageOf(error)}`, fix: "Restart Margin" } };
}

export function App({ api, voice = DEFAULT_VOICE }: AppProps): ReactElement | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [isManagingAccounts, setManagingAccounts] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    api.startupStatus().then(setStatus, (error: unknown) => setStatus(crashStatus(error)));
  }, [api]);

  useEffect(() => api.onFault((error) => setStatus({ ok: false, error })), [api]);

  const readAccounts = useCallback((): void => {
    Promise.all([api.accountRead("codex"), api.accountRead("claude")]).then(([codex, claude]) => setAccounts({ codex, claude }), (error: unknown) => setStatus(crashStatus(error)));
  }, [api]);

  const isReady = status?.ok === true;
  useEffect(() => {
    if (!isReady) return undefined;
    readAccounts();
    return api.onAuthChanged((event) => {
      const isAccountChange = event.type === "account" || (event.type === "loginCompleted" && event.success);
      if (isAccountChange) readAccounts();
    });
  }, [api, isReady, readAccounts]);

  if (status === null) return null;
  if (!status.ok) return <StartupError error={status.error} copyText={api.copyText} />;
  if (accounts === null) return null;
  const isSignedInAnywhere = accounts.codex.signedIn || accounts.claude.signedIn;
  if (!isSignedInAnywhere || isManagingAccounts) {
    return <SignIn api={api} accounts={accounts} onAccountsChanged={readAccounts} {...(isSignedInAnywhere ? { onClose: () => setManagingAccounts(false) } : {})} />;
  }
  const providers = PROVIDER_IDS.filter((id) => accounts[id].signedIn);
  return <Workspace api={api} draft={draft} onDraftChange={setDraft} onManageAccounts={() => setManagingAccounts(true)} providers={providers} onAccountChanged={readAccounts} voice={voice} />;
}
