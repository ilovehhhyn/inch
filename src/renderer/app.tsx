// Draws the root layout of the window, or the startup error when Codex cannot be used.
import { useEffect, useState, type ReactElement } from "react";

import type { MarginApi, StartupStatus } from "../shared/ipc-contract";
import { StartupError } from "./components/StartupError";

export type AppProps = Readonly<{ api: MarginApi }>;

export function App({ api }: AppProps): ReactElement | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);
  useEffect(() => {
    api.startupStatus().then(setStatus, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ ok: false, error: { kind: "codex-crashed", message: `Margin could not check Codex: ${message}`, fix: "Restart Margin" } });
    });
  }, [api]);
  if (status === null) return null;
  if (!status.ok) return <StartupError error={status.error} copyText={api.copyText} />;
  return <main aria-label="Margin" />;
}
