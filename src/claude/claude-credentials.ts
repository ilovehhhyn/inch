// Resolves, creates and ends Claude credentials: a stored API key, or a short-lived token from Margin's own `ant` profile.
import Anthropic from "@anthropic-ai/sdk";

import type { ProviderAccount } from "../shared/chat-provider";
import type { Logger } from "../shared/log";
import type { ProviderId } from "../shared/provider-id";
import { AntCliError, type AntCli } from "./ant-cli";

export type ClaudeCredential =
  | Readonly<{ kind: "apiKey"; apiKey: string }>
  | Readonly<{ kind: "antProfile"; profile: "margin"; accessToken: string; fetchedAtMs: number }>;

/** Keeps API keys encrypted at rest; the one implementation wraps Electron `safeStorage`. */
export type SecretStore = Readonly<{
  saveApiKey: (provider: ProviderId, key: string) => Promise<void>;
  readApiKey: (provider: ProviderId) => Promise<string | null>;
  deleteApiKey: (provider: ProviderId) => Promise<void>;
}>;

/** An `ant` token is short-lived; one older than this is fetched again, and `print-credentials` refreshes it when needed. */
export const ANT_TOKEN_REFRESH_MS = 5 * 60 * 1000;

export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * True: the API refuses an OAuth token on `/v1/messages` without `anthropic-beta: oauth-2025-04-20` (bundled Claude API
 * reference, `shared/anthropic-cli.md`). Not measured: no request has been sent, because `ant` is not installed here and
 * no dollar cap was approved (docs/spikes/claude.md). The SDK adds the header itself only for credential providers, not
 * for a plain `authToken`, so Margin sends it.
 */
export const ANT_TOKEN_NEEDS_OAUTH_BETA = true;

const API_BASE_URL = "https://api.anthropic.com";
const MISSING_KEY = "API key must not be empty; paste the key from the Anthropic Console";
const REJECTED_KEY = "Anthropic rejected this API key; check that you copied the whole key and that it has not been revoked";
const UNREACHABLE = "Cannot reach Anthropic. Check the connection";

/** Only the stored key and the `margin` profile are credentials; `ANTHROPIC_*` variables are not read (see `createClaudeClient`). */
export async function readClaudeCredential(store: SecretStore, ant: AntCli, clock: () => number, previous: ClaudeCredential | null = null): Promise<ClaudeCredential | null> {
  const key = await store.readApiKey("claude");
  if (key !== null) return { kind: "apiKey", apiKey: key };
  if (previous?.kind === "antProfile" && clock() - previous.fetchedAtMs < ANT_TOKEN_REFRESH_MS) return previous;
  try {
    return { kind: "antProfile", profile: "margin", accessToken: await ant.accessToken("margin"), fetchedAtMs: clock() };
  } catch (error) {
    if (error instanceof AntCliError && (error.kind === "not-installed" || error.kind === "not-signed-in")) return null;
    throw error;
  }
}

export function claudeAccountOf(credential: ClaudeCredential | null): ProviderAccount {
  if (credential === null) return { provider: "claude", signedIn: false, label: null };
  return { provider: "claude", signedIn: true, label: credential.kind === "apiKey" ? "API key" : "Claude Console" };
}

export type ClaudeClientOptions = Readonly<{ fetch?: typeof fetch; baseURL?: string }>;

/**
 * The client for `credential`. Each option is passed explicitly, `null` where it does not apply, so the SDK reads no
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` from the environment and finds no profile on disk.
 */
export function createClaudeClient(credential: ClaudeCredential, options: ClaudeClientOptions = {}): Anthropic {
  const shared = { baseURL: options.baseURL ?? API_BASE_URL, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) };
  if (credential.kind === "apiKey") return new Anthropic({ ...shared, apiKey: credential.apiKey, authToken: null });
  const defaultHeaders = ANT_TOKEN_NEEDS_OAUTH_BETA ? { "anthropic-beta": OAUTH_BETA } : {};
  return new Anthropic({ ...shared, apiKey: null, authToken: credential.accessToken, defaultHeaders });
}

/** The betas of one request; a request that names its own `betas` replaces the client's default header, so the OAuth beta is added here too. */
export function betasFor(credential: ClaudeCredential, requested: ReadonlyArray<string>): Array<string> {
  return credential.kind === "antProfile" && ANT_TOKEN_NEEDS_OAUTH_BETA ? [...requested, OAUTH_BETA] : [...requested];
}

/** Asks Anthropic for the model list, which uses no tokens, to find out whether `apiKey` is accepted. */
export async function checkApiKey(apiKey: string, options: ClaudeClientOptions = {}): Promise<void> {
  await createClaudeClient({ kind: "apiKey", apiKey }, options).models.list();
}

function describeKeyCheckFailure(error: unknown, apiKey: string): Error {
  if (error instanceof Anthropic.AuthenticationError) return new Error(REJECTED_KEY);
  if (error instanceof Anthropic.APIConnectionError) return new Error(UNREACHABLE);
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replaceAll(apiKey, "[redacted]"));
}

/** Saves `apiKey` only after `validate` accepts it, and never lets the key into an error or a log line. */
export async function signInWithApiKey(store: SecretStore, apiKey: string, validate: (apiKey: string) => Promise<void>, log: Logger = () => undefined): Promise<void> {
  const key = apiKey.trim();
  if (key === "") throw new Error(MISSING_KEY);
  log("claude sign-in: checking the API key with the model list");
  try {
    await validate(key);
  } catch (error) {
    throw describeKeyCheckFailure(error, key);
  }
  await store.saveApiKey("claude", key);
  log("claude sign-in: API key saved");
}

/** Signs in through the browser with `ant`; `ant` missing is a hard error that names the install step. */
export async function signInWithConsole(ant: AntCli): Promise<void> {
  await ant.version();
  await ant.login("margin");
  await ant.accessToken("margin");
}

/** Deletes the stored key and logs the `margin` profile out; other `ant` profiles and Claude Code's login are never touched. */
export async function signOut(store: SecretStore, ant: AntCli): Promise<void> {
  await store.deleteApiKey("claude");
  try {
    await ant.logout("margin");
  } catch (error) {
    if (!(error instanceof AntCliError && error.kind === "not-installed")) throw error; // without `ant` there is no profile to log out of
  }
}
