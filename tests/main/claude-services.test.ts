// Invariant: the Claude services read the credential fresh on every call, keep an `ant` token for five minutes, and drop it when the account changes.
import { expect, test } from "vitest";

import { AntCliError, type AntCli } from "../../src/claude/ant-cli";
import { ANT_TOKEN_REFRESH_MS, type ClaudeCredential, type SecretStore } from "../../src/claude/claude-credentials";
import { createClaudeServices } from "../../src/main/claude-services";
import type { ProviderId } from "../../src/shared/provider-id";

function memoryStore(): SecretStore & { keys: Map<ProviderId, string> } {
  const keys = new Map<ProviderId, string>();
  return {
    keys,
    saveApiKey: async (provider, key) => void keys.set(provider, key),
    readApiKey: async (provider) => keys.get(provider) ?? null,
    deleteApiKey: async (provider) => void keys.delete(provider),
  };
}

function fakeAnt(): AntCli & { calls: Array<string>; token: string | null } {
  const ant = {
    calls: [] as Array<string>,
    token: "token-1" as string | null,
    version: async () => "ant 2.9.0",
    login: async () => void ant.calls.push("login"),
    accessToken: async () => {
      ant.calls.push("accessToken");
      if (ant.token === null) throw new AntCliError("not-signed-in", "no login");
      return ant.token;
    },
    logout: async () => void ant.calls.push("logout"),
  };
  return ant;
}

function services(overrides: Readonly<{ validate?: (key: string) => Promise<void>; checkModels?: (credential: ClaudeCredential) => Promise<void>; ant?: () => Promise<AntCli> }> = {}) {
  const store = memoryStore();
  const ant = fakeAnt();
  const clock = { now: 0 };
  const logs: Array<string> = [];
  const result = createClaudeServices({ store, ant: async () => ant, clock: () => clock.now, clientOptions: {}, log: (line) => logs.push(line), checkModels: async () => undefined, ...overrides });
  return { store, ant, clock, logs, ...result };
}

test("the_ant_token_is_kept_for_five_minutes_and_then_fetched_again", async () => {
  const { ant, clock, credentials } = services();

  await credentials();
  clock.now = ANT_TOKEN_REFRESH_MS - 1;
  await credentials();
  clock.now = ANT_TOKEN_REFRESH_MS;
  await credentials();

  expect(ant.calls).toEqual(["accessToken", "accessToken"]);
});

test("signing_in_with_a_key_makes_the_key_the_credential_at_once", async () => {
  const { credentials, signInApiKey, readAccount } = services({ validate: async () => undefined });
  expect((await readAccount()).signedIn).toBe(true);

  await signInApiKey("sk-ant-test-123");

  expect(await credentials()).toEqual({ kind: "apiKey", apiKey: "sk-ant-test-123" });
  expect(await readAccount()).toEqual({ provider: "claude", signedIn: true, label: "API key" });
});

test("signing_out_clears_the_cached_token_so_the_account_reads_signed_out", async () => {
  const { ant, credentials, signOut, readAccount } = services();
  await credentials();
  ant.token = null;

  await signOut();

  expect(await readAccount()).toEqual({ provider: "claude", signedIn: false, label: null });
  expect(ant.calls).toContain("logout");
});

test("an_api_key_user_signs_out_even_when_ant_cannot_be_found", async () => {
  const lookupFailure = new Error("could not read the login-shell PATH");
  const { store, signOut, signInApiKey } = services({ validate: async () => undefined, ant: async () => Promise.reject(lookupFailure) });
  await signInApiKey("sk-ant-test-123");

  await signOut();

  expect(store.keys.has("claude")).toBe(false);
});

test("a_sign_out_with_no_stored_key_still_reports_a_failed_ant_lookup", async () => {
  const lookupFailure = new Error("could not read the login-shell PATH");
  const { signOut } = services({ ant: async () => Promise.reject(lookupFailure) });

  await expect(signOut()).rejects.toThrow("could not read the login-shell PATH");
});

test("console_sign_in_reads_a_fresh_token_afterwards", async () => {
  const { ant, signInConsole, credentials } = services();
  ant.token = null;
  expect(await credentials()).toBeNull();
  ant.token = "token-2";

  await signInConsole();

  expect(await credentials()).toMatchObject({ kind: "antProfile", accessToken: "token-2" });
});

test("console_sign_in_checks_the_offered_models_with_the_new_token", async () => {
  const checked: Array<ClaudeCredential> = [];
  const { signInConsole } = services({ checkModels: async (credential) => void checked.push(credential) });

  await signInConsole();

  expect(checked).toEqual([{ kind: "antProfile", profile: "margin", accessToken: "token-1", fetchedAtMs: 0 }]);
});

test("console_sign_in_fails_when_the_account_cannot_use_an_offered_model", async () => {
  const { signInConsole } = services({
    checkModels: async () => {
      throw new Error("Claude model `claude-opus-5-5` is not available to this account; sign in with an account that can use it, or remove it from CLAUDE_MODELS");
    },
  });

  await expect(signInConsole()).rejects.toThrow("not available to this account");
});

test("a_rejected_key_is_not_stored_and_the_credential_stays_signed_out", async () => {
  const { store, ant, signInApiKey, credentials } = services({
    validate: async () => {
      throw new Error("rejected");
    },
  });
  ant.token = null;

  await expect(signInApiKey("sk-ant-bad")).rejects.toThrow("rejected");

  expect(store.keys.size).toBe(0);
  expect(await credentials()).toBeNull();
});

test("a_stored_key_makes_the_account_signed_in_without_resolving_ant", async () => {
  let lookups = 0;
  const { store, readAccount } = services({
    ant: async () => {
      lookups += 1;
      throw new Error("the login shell did not answer");
    },
  });
  store.keys.set("claude", "sk-ant-test-123");

  expect(await readAccount()).toEqual({ provider: "claude", signedIn: true, label: "API key" });
  expect(lookups).toBe(0);
});

test("a_rejected_stored_key_reads_as_signed_out_until_a_key_is_typed_again", async () => {
  const { store, markRejected, readAccount, signInApiKey } = services({ validate: async () => undefined });
  store.keys.set("claude", "sk-ant-old");

  markRejected();

  expect(await readAccount()).toEqual({ provider: "claude", signedIn: false, label: null });
  await signInApiKey("sk-ant-new");
  expect(await readAccount()).toEqual({ provider: "claude", signedIn: true, label: "API key" });
});

test("a_rejected_ant_token_is_dropped_and_the_next_read_fetches_a_new_one", async () => {
  const { ant, credentials, markRejected } = services();
  expect(await credentials()).toMatchObject({ accessToken: "token-1" });
  ant.token = "token-2";

  markRejected();

  expect(await credentials()).toMatchObject({ accessToken: "token-2" });
  expect(ant.calls).toEqual(["accessToken", "accessToken"]);
});

test("a_rejected_ant_account_whose_token_cannot_be_fetched_reads_as_signed_out", async () => {
  const { ant, readAccount, markRejected, credentials } = services();
  await credentials();
  ant.token = null;

  markRejected();

  expect((await readAccount()).signedIn).toBe(false);
});

test("signing_in_through_the_console_clears_a_rejection_for_a_stored_key_route", async () => {
  const { store, markRejected, readAccount, signInConsole } = services();
  store.keys.set("claude", "sk-ant-old");
  markRejected();

  await signInConsole();

  expect((await readAccount()).signedIn).toBe(true);
});
