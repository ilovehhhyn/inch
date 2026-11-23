// Decides whether the installed Codex is the one version Margin's generated bindings were built for.
import { StartupError } from "../shared/startup-error";

/** The generated bindings in src/codex/generated match this version only; upgrading means regenerating them. */
export const SUPPORTED_CODEX_VERSION = "0.146.0";

export const INSTALL_COMMAND = `npm install -g @openai/codex@${SUPPORTED_CODEX_VERSION}`;

const VERSION_LINE = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

/** Returns the version from the single line `codex --version` prints, for example "codex-cli 0.146.0". */
export function parseCodexVersion(output: string): string {
  const match = VERSION_LINE.exec(output.trim());
  const version = match?.[1];
  if (version === undefined) {
    throw new Error(`output is not a codex version line (expected \`codex-cli X.Y.Z\`): ${JSON.stringify(output.slice(0, 80))}`);
  }
  return version;
}

export function codexMissingError(): StartupError {
  return new StartupError({ kind: "codex-missing", message: `codex was not found on PATH; install it with \`${INSTALL_COMMAND}\``, fix: INSTALL_COMMAND });
}

/** Throws a StartupError unless `found` is exactly SUPPORTED_CODEX_VERSION; `undefined` means codex was not found. */
export function requireSupportedCodex(found: string | undefined): void {
  if (found === undefined) {
    throw codexMissingError();
  }
  if (found !== SUPPORTED_CODEX_VERSION) {
    throw new StartupError({
      kind: "codex-version",
      message: `codex ${found} is not supported; Margin requires exactly ${SUPPORTED_CODEX_VERSION}; install it with \`${INSTALL_COMMAND}\``,
      fix: INSTALL_COMMAND,
    });
  }
}
