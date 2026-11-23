// Draws the root layout of the window: the startup error, the sign-in page, or the app, chosen from the account state.
import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { ProviderAccount } from "../shared/chat-provider";
import type { MarginApi } from "../shared/ipc-contract";
import type { StartupErrorInfo } from "../shared/startup-error";
import { PROVIDER_IDS, type ProviderId } from "../shared/provider-id";
import { SignIn } from "./components/SignIn";
import { StartupError } from "./components/StartupError";
import { createBrowserSpeechEngine, createReadAloudSetting } from "./voice/read-aloud";
import { startWavRecording } from "./voice/wav-recorder";
import { Workspace, type VoiceEnvironment } from "./workspace";

/** The voice parts of the window; the default records the microphone, and tests pass a fake recorder. */
function createBrowserVoice(): VoiceEnvironment {
  return { startRecording: startWavRecording, speech: createBrowserSpeechEngine(), readAloudSetting: createReadAloudSetting(window.localStorage) };
}

export type AppProps = Readonly<{ api: MarginApi; voice?: VoiceEnvironment }>;

type Accounts = Readonly<Record<ProviderId, ProviderAccount>>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed startup check, or a failed read of the Claude account: the window cannot tell what is signed in, so it shows the error in full. */
function fatalError(error: unknown, what: string): StartupErrorInfo {
  return { kind: "codex-crashed", message: `Margin could not check ${what}: ${messageOf(error)}`, fix: "Restart Margin" };
}

/** A Codex failure that is not a start-up error, such as a restarted app-server that did not come back. */
function codexError(error: unknown): StartupErrorInfo {
  return { kind: "codex-crashed", message: messageOf(error), fix: "Press Retry, or restart Margin" };
}

const CODEX_SIGNED_OUT: ProviderAccount = { provider: "codex", signedIn: false, label: null };

export function App({ api, voice: injectedVoice }: AppProps): ReactElement | null {
  const [isStarted, setStarted] = useState(false);
  const [fatal, setFatal] = useState<StartupErrorInfo | null>(null);
  /** Why Codex cannot be used now; Claude chats keep working while it is set. */
  const [codexProblem, setCodexProblem] = useState<StartupErrorInfo | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [isManagingAccounts, setManagingAccounts] = useState(false);
  const [draft, setDraft] = useState("");
  const [voice] = useState<VoiceEnvironment>(() => injectedVoice ?? createBrowserVoice());

  useEffect(() => {
    api.startupStatus().then(
      (status) => {
        setCodexProblem(status.ok ? null : status.error);
        setStarted(true);
      },
      (error: unknown) => setFatal(fatalError(error, "Margin's start-up")),
    );
  }, [api]);

  useEffect(() => api.onFault(setCodexProblem), [api]);

  const retryCodex = useCallback((): void => {
    api.codexRetry().then(
      (status) => setCodexProblem(status.ok ? null : status.error),
      (error: unknown) => setCodexProblem(codexError(error)),
    );
  }, [api]);

  const readAccounts = useCallback((): void => {
    const codex = codexProblem === null ? api.accountRead("codex").catch((error: unknown) => {
      setCodexProblem(codexError(error));
      return CODEX_SIGNED_OUT;
    }) : Promise.resolve(CODEX_SIGNED_OUT);
    Promise.all([codex, api.accountRead("claude")]).then(([codexAccount, claude]) => setAccounts({ codex: codexAccount, claude }), (error: unknown) => setFatal(fatalError(error, "Claude")));
  }, [api, codexProblem]);

  useEffect(() => {
    if (!isStarted) return undefined;
    readAccounts();
    return api.onAuthChanged((event) => {
      const isAccountChange = event.type === "account" || (event.type === "loginCompleted" && event.success);
      if (isAccountChange) readAccounts();
    });
  }, [api, isStarted, readAccounts]);

  if (fatal !== null) return <StartupError error={fatal} copyText={api.copyText} />;
  if (!isStarted || accounts === null) return null;
  const isSignedInAnywhere = accounts.codex.signedIn || accounts.claude.signedIn;
  if (!isSignedInAnywhere || isManagingAccounts) {
    return <SignIn api={api} accounts={accounts} codexProblem={codexProblem} onRetryCodex={retryCodex} onAccountsChanged={readAccounts} {...(isSignedInAnywhere ? { onClose: () => setManagingAccounts(false) } : {})} />;
  }
  const providers = PROVIDER_IDS.filter((id) => accounts[id].signedIn);
  return <Workspace api={api} draft={draft} onDraftChange={setDraft} onManageAccounts={() => setManagingAccounts(true)} providers={providers} onAccountChanged={readAccounts} voice={voice} codexProblem={codexProblem} onRetryCodex={retryCodex} />;
}
