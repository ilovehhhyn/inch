// Offers the ways to sign in to OpenAI (through Codex) and to Claude (Console account or API key), shows each provider's state and sign-out.
import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { LoginKind, LoginStarted } from "../../shared/auth";
import type { ProviderAccount } from "../../shared/chat-provider";
import type { MarginApi } from "../../shared/ipc-contract";
import type { ProviderId } from "../../shared/provider-id";
import type { StartupErrorInfo } from "../../shared/startup-error";

export type SignInApi = Pick<MarginApi, "authStart" | "authApiKey" | "authCancel" | "authLogout" | "onAuthChanged" | "claudeSignInConsole" | "claudeSignInApiKey" | "claudeSignOut">;

export type SignInProps = Readonly<{
  api: SignInApi;
  accounts: Readonly<Record<ProviderId, ProviderAccount>>;
  /** Why Codex cannot be used, or null; the OpenAI section then shows it with a Retry instead of the sign-in choices. */
  codexProblem: StartupErrorInfo | null;
  onRetryCodex: () => void;
  /** Called after a sign-in or sign-out finished, so the window reads the accounts again. */
  onAccountsChanged: () => void;
  /** Present when the page was opened from the chat; the page then offers a way back. */
  onClose?: () => void;
}>;

type OpenAiProgress = Readonly<{ kind: "idle" }> | Readonly<{ kind: "waiting"; login: LoginStarted }>;
type ClaudeProgress = "idle" | "waiting-for-browser" | "checking-key";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SignIn({ api, accounts, codexProblem, onRetryCodex, onAccountsChanged, onClose }: SignInProps): ReactElement {
  const [openAi, setOpenAi] = useState<OpenAiProgress>({ kind: "idle" });
  const [claude, setClaude] = useState<ClaudeProgress>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [claudeKey, setClaudeKey] = useState("");
  const [isClaudeKeyShown, setClaudeKeyShown] = useState(false);

  useEffect(
    () =>
      api.onAuthChanged((event) => {
        if (event.type !== "loginCompleted" || event.success) return;
        setOpenAi({ kind: "idle" });
        setFailure(event.error ?? "the app-server gave no reason");
      }),
    [api],
  );

  const startOpenAi = async (kind: LoginKind): Promise<void> => {
    setFailure(null);
    try {
      setOpenAi({ kind: "waiting", login: await api.authStart(kind) });
    } catch (error) {
      setFailure(messageOf(error));
    }
  };

  const cancelOpenAi = async (login: LoginStarted): Promise<void> => {
    setOpenAi({ kind: "idle" });
    try {
      await api.authCancel(login.loginId);
    } catch (error) {
      setFailure(messageOf(error));
    }
  };

  const submitOpenAiKey = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const key = apiKey;
    setApiKey("");
    setFailure(null);
    try {
      await api.authApiKey(key);
    } catch (error) {
      setFailure(messageOf(error));
    }
  };

  /** Runs one Claude or sign-out call, shows its failure, and asks the window to read the accounts again either way. */
  const runClaude = async (progress: ClaudeProgress, call: () => Promise<void>): Promise<void> => {
    setFailure(null);
    setClaude(progress);
    try {
      await call();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setClaude("idle");
      onAccountsChanged();
    }
  };

  const submitClaudeKey = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const key = claudeKey;
    setClaudeKey("");
    await runClaude("checking-key", () => api.claudeSignInApiKey(key));
  };

  const openAiAccount = accounts.codex;
  const claudeAccount = accounts.claude;
  return (
    <main aria-label="Sign in">
      <h1>{onClose === undefined ? "Sign in to continue" : "Accounts"}</h1>
      {onClose === undefined ? null : (
        <button type="button" onClick={onClose}>
          Close
        </button>
      )}
      {failure === null ? null : <p role="status">Sign-in failed: {failure}</p>}
      <section aria-label="OpenAI">
        <h2>OpenAI</h2>
        {codexProblem !== null ? (
          <>
            <p role="alert">{codexProblem.message}</p>
            <p>
              Fix: <code>{codexProblem.fix}</code>
            </p>
            <button type="button" onClick={onRetryCodex}>
              Retry Codex
            </button>
          </>
        ) : openAiAccount.signedIn ? (
          <>
            <p>Signed in with {openAiAccount.label}</p>
            <button type="button" onClick={() => void api.authLogout().then(onAccountsChanged, (error: unknown) => setFailure(messageOf(error)))}>
              Sign out of OpenAI
            </button>
          </>
        ) : openAi.kind === "waiting" ? (
          <Waiting login={openAi.login} onCancel={() => void cancelOpenAi(openAi.login)} />
        ) : (
          <>
            <button type="button" onClick={() => void startOpenAi("chatgpt")}>
              Sign in with ChatGPT
            </button>
            <button type="button" onClick={() => void startOpenAi("chatgptDeviceCode")}>
              Sign in with a device code
            </button>
            <form onSubmit={(event) => void submitOpenAiKey(event)}>
              <label>
                OpenAI API key
                <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              </label>
              <button type="submit">Sign in with API key</button>
            </form>
          </>
        )}
      </section>
      <section aria-label="Claude">
        <h2>Claude</h2>
        {claudeAccount.signedIn ? (
          <>
            <p>Signed in with {claudeAccount.label}</p>
            <button type="button" onClick={() => void runClaude("idle", () => api.claudeSignOut())}>
              Sign out of Claude
            </button>
          </>
        ) : claude === "waiting-for-browser" ? (
          <p>Finish signing in to Claude in your browser.</p>
        ) : claude === "checking-key" ? (
          <p>Checking the key with Anthropic.</p>
        ) : (
          <>
            <button type="button" onClick={() => void runClaude("waiting-for-browser", () => api.claudeSignInConsole())}>
              Sign in with Claude Console
            </button>
            {isClaudeKeyShown ? (
              <form onSubmit={(event) => void submitClaudeKey(event)}>
                <label>
                  Anthropic API key
                  <input type="password" autoComplete="off" value={claudeKey} onChange={(event) => setClaudeKey(event.target.value)} />
                </label>
                <button type="submit">Save Anthropic API key</button>
              </form>
            ) : (
              <button type="button" onClick={() => setClaudeKeyShown(true)}>
                Use an Anthropic API key
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function Waiting({ login, onCancel }: Readonly<{ login: LoginStarted; onCancel: () => void }>): ReactElement {
  return (
    <section>
      {login.kind === "chatgpt" ? (
        <p>Finish signing in in your browser.</p>
      ) : (
        <>
          <p>Open this address and enter the code:</p>
          <p>{login.verificationUrl}</p>
          <p>{login.userCode}</p>
        </>
      )}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
