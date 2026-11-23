// Invariant: a stored API key wins over the `ant` profile, the environment never supplies a credential, and a key is saved only after Anthropic accepts it and never leaves the main process.
import Anthropic from "@anthropic-ai/sdk";
import { expect, onTestFinished, test } from "vitest";

import { AntCliError, ANT_INSTALL_MESSAGE, type AntCli } from "../../src/claude/ant-cli";
import {
  ANT_TOKEN_NEEDS_OAUTH_BETA,
  ANT_TOKEN_REFRESH_MS,
  OAUTH_BETA,
  betasFor,
  claudeAccountOf,
  createClaudeClient,
  readClaudeCredential,
  signInWithApiKey,
  signInWithConsole,
  signOut,
  type ClaudeCredential,
  type SecretStore,
} from "../../src/claude/claude-credentials";
import type { ProviderId } from "../../src/shared/provider-id";

const KEY = "sk-ant-test-123";

class FakeSecretStore implements SecretStore {
  readonly keys = new Map<ProviderId, string>();
  readonly writes: Array<string> = [];
  saveApiKey = async (provider: ProviderId, key: string): Promise<void> => {
    this.writes.push(`save:${provider}`);
    this.keys.set(provider, key);
  };
  readApiKey = async (provider: ProviderId): Promise<string | null> => this.keys.get(provider) ?? null;
  deleteApiKey = async (provider: ProviderId): Promise<void> => {
    this.writes.push(`delete:${provider}`);
    this.keys.delete(provider);
  };
}

class FakeAnt implements AntCli {
  readonly calls: Array<string> = [];
  token: string | AntCliError = "token-1";
  installed = true;
  version = async (): Promise<string> => {
    this.calls.push("version");
    if (!this.installed) throw new AntCliError("not-installed", ANT_INSTALL_MESSAGE);
    return "ant 2.9.0";
  };
  login = async (profile: "margin"): Promise<void> => {
    this.calls.push(`login:${profile}`);
  };
  accessToken = async (profile: "margin"): Promise<string> => {
    this.calls.push(`accessToken:${profile}`);
    if (this.token instanceof Error) throw this.token;
    return this.token;
  };
  logout = async (profile: "margin"): Promise<void> => {
    this.calls.push(`logout:${profile}`);
    if (!this.installed) throw new AntCliError("not-installed", ANT_INSTALL_MESSAGE);
  };
}

test("stored_api_key_wins_over_the_ant_profile", async () => {
  const store = new FakeSecretStore();
  store.keys.set("claude", KEY);
  const ant = new FakeAnt();

  const credential = await readClaudeCredential(store, ant, () => 0);

  expect(credential).toEqual({ kind: "apiKey", apiKey: KEY });
  expect(ant.calls).toEqual([]);
});

test("without_a_key_the_margin_profile_token_is_used_and_stamped_with_the_clock", async () => {
  const ant = new FakeAnt();

  const credential = await readClaudeCredential(new FakeSecretStore(), ant, () => 1234);

  expect(credential).toEqual({ kind: "antProfile", profile: "margin", accessToken: "token-1", fetchedAtMs: 1234 });
});

test("ant_token_is_refetched_after_five_minutes", async () => {
  const ant = new FakeAnt();
  const store = new FakeSecretStore();
  let now = 0;
  const first = await readClaudeCredential(store, ant, () => now);
  ant.token = "token-2";

  now = ANT_TOKEN_REFRESH_MS - 1;
  const reused = await readClaudeCredential(store, ant, () => now, first);
  now = ANT_TOKEN_REFRESH_MS;
  const refetched = await readClaudeCredential(store, ant, () => now, first);

  expect(ANT_TOKEN_REFRESH_MS).toBe(5 * 60 * 1000);
  expect(reused).toBe(first);
  expect(refetched).toEqual({ kind: "antProfile", profile: "margin", accessToken: "token-2", fetchedAtMs: ANT_TOKEN_REFRESH_MS });
  expect(ant.calls).toEqual(["accessToken:margin", "accessToken:margin"]);
});

test("a_key_saved_after_an_ant_token_was_cached_takes_over", async () => {
  const store = new FakeSecretStore();
  const ant = new FakeAnt();
  const cached = await readClaudeCredential(store, ant, () => 0);
  store.keys.set("claude", KEY);

  expect(await readClaudeCredential(store, ant, () => 1, cached)).toEqual({ kind: "apiKey", apiKey: KEY });
});

test.each([
  ["ant is not installed", new AntCliError("not-installed", ANT_INSTALL_MESSAGE)],
  ["the margin profile is not signed in", new AntCliError("not-signed-in", "ant has no credentials for the margin profile")],
])("no_key_and_%s_means_signed_out", async (_name, error) => {
  const ant = new FakeAnt();
  ant.token = error;

  expect(await readClaudeCredential(new FakeSecretStore(), ant, () => 0)).toBeNull();
});

test("an_ant_failure_that_is_not_a_missing_login_is_raised_not_read_as_signed_out", async () => {
  const ant = new FakeAnt();
  ant.token = new AntCliError("timeout", "`ant auth print-credentials` did not finish within 10 s; run it in a terminal to see what it is waiting for");

  await expect(readClaudeCredential(new FakeSecretStore(), ant, () => 0)).rejects.toThrow("did not finish within 10 s");
});

type Captured = Readonly<{ url: string; headers: Headers }>;

function capturingFetch(): Readonly<{ fetch: typeof fetch; requests: Array<Captured> }> {
  const requests: Array<Captured> = [];
  const capture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: capture, requests };
}

function withEnvironment(values: Readonly<Record<string, string>>): void {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  onTestFinished(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("environment_credentials_are_ignored", async () => {
  withEnvironment({ ANTHROPIC_API_KEY: "stale", ANTHROPIC_AUTH_TOKEN: "stale-token", ANTHROPIC_BASE_URL: "http://elsewhere.invalid", ANTHROPIC_PROFILE: "other" });
  const { fetch: fakeFetch, requests } = capturingFetch();

  await createClaudeClient({ kind: "apiKey", apiKey: KEY }, { fetch: fakeFetch }).models.list();

  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(requests[0]?.headers.get("anthropic-beta")).toBeNull();
  expect(new URL(requests[0]?.url ?? "").host).toBe("api.anthropic.com");
});

test("an_ant_token_is_sent_as_a_bearer_token_with_the_oauth_beta_and_not_the_stale_environment_key", async () => {
  withEnvironment({ ANTHROPIC_API_KEY: "stale" });
  const { fetch: fakeFetch, requests } = capturingFetch();
  const credential: ClaudeCredential = { kind: "antProfile", profile: "margin", accessToken: "tok-1", fetchedAtMs: 0 };

  await createClaudeClient(credential, { fetch: fakeFetch }).models.list();

  expect(ANT_TOKEN_NEEDS_OAUTH_BETA).toBe(true);
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer tok-1");
  expect(requests[0]?.headers.get("anthropic-beta")).toContain(OAUTH_BETA);
});

test("the_oauth_beta_survives_a_request_that_names_its_own_betas", async () => {
  const { fetch: fakeFetch, requests } = capturingFetch();
  const credential: ClaudeCredential = { kind: "antProfile", profile: "margin", accessToken: "tok-1", fetchedAtMs: 0 };
  const client = createClaudeClient(credential, { fetch: fakeFetch });

  await client.beta.models.list({ betas: betasFor(credential, ["server-side-fallback-2026-07-01"]) });

  const sent = (requests[0]?.headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim());
  expect(sent).toContain(OAUTH_BETA);
  expect(sent).toContain("server-side-fallback-2026-07-01");
});

test("an_api_key_request_adds_no_oauth_beta", () => {
  expect(betasFor({ kind: "apiKey", apiKey: KEY }, ["server-side-fallback-2026-07-01"])).toEqual(["server-side-fallback-2026-07-01"]);
});

test("invalid_key_is_not_saved", async () => {
  const store = new FakeSecretStore();
  const rejection = Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "401 invalid x-api-key", new Headers());

  const error = await signInWithApiKey(store, KEY, async () => {
    throw rejection;
  }).then(() => null, (caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Anthropic rejected this API key; check that you copied the whole key and that it has not been revoked");
  expect(store.keys.size).toBe(0);
  expect(store.writes).toEqual([]);
});

test("an_unreachable_service_is_reported_as_such_and_the_key_is_not_saved", async () => {
  const store = new FakeSecretStore();

  await expect(
    signInWithApiKey(store, KEY, async () => {
      throw new Anthropic.APIConnectionError({ message: "fetch failed" });
    }),
  ).rejects.toThrow("Cannot reach Anthropic. Check the connection");

  expect(store.keys.size).toBe(0);
});

test("a_blank_key_is_rejected_before_any_request", async () => {
  let asked = false;

  await expect(signInWithApiKey(new FakeSecretStore(), "   ", async () => void (asked = true))).rejects.toThrow("API key must not be empty; paste the key from the Anthropic Console");

  expect(asked).toBe(false);
});

test("a_valid_key_is_checked_once_with_the_trimmed_value_and_then_saved", async () => {
  const store = new FakeSecretStore();
  const checked: Array<string> = [];

  await signInWithApiKey(store, `  ${KEY}\n`, async (key) => void checked.push(key));

  expect(checked).toEqual([KEY]);
  expect(store.keys.get("claude")).toBe(KEY);
});

test("api_key_never_reaches_the_renderer_or_logs", async () => {
  const store = new FakeSecretStore();
  const logs: Array<string> = [];
  const failing = async (key: string): Promise<void> => {
    throw new Error(`the service said the key ${key} is not valid`);
  };

  const error = await signInWithApiKey(store, KEY, failing, (line) => logs.push(line)).then(() => null, (caught: unknown) => caught);
  await signInWithApiKey(store, KEY, async () => undefined, (line) => logs.push(line));
  const account = claudeAccountOf(await readClaudeCredential(store, new FakeAnt(), () => 0));

  expect((error as Error).message).not.toContain(KEY);
  expect((error as Error).message).toContain("[redacted]");
  expect(logs.join("\n")).not.toContain(KEY);
  expect(logs.length).toBeGreaterThan(0);
  expect(JSON.stringify(account)).not.toContain(KEY);
  expect(account).toEqual({ provider: "claude", signedIn: true, label: "API key" });
});

test("the_account_label_names_the_method_and_signed_out_has_none", () => {
  expect(claudeAccountOf({ kind: "antProfile", profile: "margin", accessToken: "t", fetchedAtMs: 0 })).toEqual({ provider: "claude", signedIn: true, label: "Claude Console" });
  expect(claudeAccountOf(null)).toEqual({ provider: "claude", signedIn: false, label: null });
});

test("console_sign_in_without_ant_stops_with_the_install_message_and_never_logs_in", async () => {
  const ant = new FakeAnt();
  ant.installed = false;

  await expect(signInWithConsole(ant)).rejects.toThrow(ANT_INSTALL_MESSAGE);

  expect(ant.calls).toEqual(["version"]);
});

test("console_sign_in_logs_in_to_the_margin_profile_and_checks_that_a_token_exists", async () => {
  const ant = new FakeAnt();

  await signInWithConsole(ant);

  expect(ant.calls).toEqual(["version", "login:margin", "accessToken:margin"]);
});

test("sign_out_deletes_the_key_and_logs_out_of_the_margin_profile_only", async () => {
  const store = new FakeSecretStore();
  store.keys.set("claude", KEY);
  const ant = new FakeAnt();

  await signOut(store, ant);

  expect(store.keys.size).toBe(0);
  expect(ant.calls).toEqual(["logout:margin"]);
});

test("sign_out_without_ant_still_deletes_the_key", async () => {
  const store = new FakeSecretStore();
  store.keys.set("claude", KEY);
  const ant = new FakeAnt();
  ant.installed = false;

  await signOut(store, ant);

  expect(store.keys.size).toBe(0);
});
