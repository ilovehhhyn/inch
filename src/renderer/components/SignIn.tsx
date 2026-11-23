// Offers the three ways to sign in through the Codex app-server and shows progress and failures.
import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { LoginKind, LoginStarted } from "../../shared/auth";
import type { MarginApi } from "../../shared/ipc-contract";

export type SignInProps = Readonly<{ api: Pick<MarginApi, "authStart" | "authApiKey" | "authCancel" | "onAuthChanged"> }>;

type Progress = Readonly<{ kind: "idle" }> | Readonly<{ kind: "waiting"; login: LoginStarted }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SignIn({ api }: SignInProps): ReactElement {
  const [progress, setProgress] = useState<Progress>({ kind: "idle" });
  const [failure, setFailure] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");

  useEffect(
    () =>
      api.onAuthChanged((event) => {
        if (event.type !== "loginCompleted" || event.success) return;
        setProgress({ kind: "idle" });
        setFailure(event.error ?? "the app-server gave no reason");
      }),
    [api],
  );

  const start = async (kind: LoginKind): Promise<void> => {
    setFailure(null);
    try {
      setProgress({ kind: "waiting", login: await api.authStart(kind) });
    } catch (error) {
      setFailure(messageOf(error));
    }
  };

  const cancel = async (login: LoginStarted): Promise<void> => {
    setProgress({ kind: "idle" });
    try {
      await api.authCancel(login.loginId);
    } catch (error) {
      setFailure(messageOf(error));
    }
  };

  const submitApiKey = async (event: FormEvent): Promise<void> => {
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

  return (
    <main aria-label="Sign in">
      <h1>Sign in to continue</h1>
      {failure === null ? null : <p role="status">Sign-in failed: {failure}</p>}
      {progress.kind === "waiting" ? <Waiting login={progress.login} onCancel={() => void cancel(progress.login)} /> : null}
      {progress.kind === "idle" ? (
        <>
          <button type="button" onClick={() => void start("chatgpt")}>
            Sign in with ChatGPT
          </button>
          <button type="button" onClick={() => void start("chatgptDeviceCode")}>
            Sign in with a device code
          </button>
          <form onSubmit={(event) => void submitApiKey(event)}>
            <label>
              OpenAI API key
              <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </label>
            <button type="submit">Sign in with API key</button>
          </form>
        </>
      ) : null}
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
