// Invariant: the Claude services read the credential fresh on every call, keep an `ant` token for five minutes, and drop it when the account changes.
import { expect, test } from "vitest";

import { AntCliError, type AntCli } from "../../src/claude/ant-cli";
import { ANT_TOKEN_REFRESH_MS, type SecretStore } from "../../src/claude/claude-credentials";
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

function services(overrides: Readonly<{ validate?: (key: string) => Promise<void> }> = {}) {
  const store = memoryStore();
  const ant = fakeAnt();
  const clock = { now: 0 };
  const logs: Array<string> = [];
  const result = createClaudeServices({ store, ant: async () => ant, clock: () => clock.now, clientOptions: {}, log: (line) => logs.push(line), ...overrides });
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

test("console_sign_in_reads_a_fresh_token_afterwards", async () => {
  const { ant, signInConsole, credentials } = services();
  ant.token = null;
  expect(await credentials()).toBeNull();
  ant.token = "token-2";

  await signInConsole();

  expect(await credentials()).toMatchObject({ kind: "antProfile", accessToken: "token-2" });
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
