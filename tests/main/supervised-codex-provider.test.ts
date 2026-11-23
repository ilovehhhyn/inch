// Invariant: the supervised Codex provider sends every call to the client that is running now, waits through a restart, and delivers supervisor events to its subscribers.
import { expect, test } from "vitest";

import { CodexClient } from "../../src/codex/codex-client";
import { RpcConnection } from "../../src/codex/rpc-connection";
import { createSupervisedCodexProvider } from "../../src/main/supervised-codex-provider";
import { asThreadId, asTurnId, type ProviderEvent } from "../../src/shared/provider-events";
import { FakeAppServer } from "../fakes/fake-app-server";

const EMPTY_WORKSPACE = "/Users/example/Library/Application Support/Margin/empty-workspace";

async function startedClient(): Promise<Readonly<{ fake: FakeAppServer; client: CodexClient }>> {
  const fake = new FakeAppServer();
  fake.respond("initialize", { userAgent: "codex/0.146.0", codexHome: "/h", platformFamily: "unix", platformOs: "macos" });
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });
  const connection = new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 });
  const client = new CodexClient({ connection, appVersion: "1.0.0", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });
  await client.initialize();
  return { fake, client };
}

test("a_call_waits_for_the_client_that_a_restart_produces_and_uses_it", async () => {
  const { fake, client } = await startedClient();
  fake.respond("model/list", { data: [{ id: "gpt-5.6-sol", displayName: "Sol", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high", inputModalities: ["text"] }], nextCursor: null });
  fake.respond("turn/start", { turn: { id: "turn-1" } });
  let release: (client: CodexClient) => void = () => undefined;
  const restarting = new Promise<CodexClient>((resolve) => {
    release = resolve;
  });
  const { provider } = createSupervisedCodexProvider(() => restarting);

  const pending = provider.startTurn(asThreadId("thread-1"), { question: "hello", context: null, model: "gpt-5.6-sol", reasoning: "high", attachments: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fake.received().filter((message) => message.method === "turn/start")).toEqual([]);
  release(client);

  expect(await pending).toBe("turn-1");
});

test("a_failed_restart_rejects_the_call_with_its_reason", async () => {
  const { provider } = createSupervisedCodexProvider(() => Promise.reject(new Error("Codex restarted 3 times in 60 s and stopped again")));

  await expect(provider.readAccount()).rejects.toThrow("Codex restarted 3 times in 60 s and stopped again");
});

test("published_events_reach_every_subscriber_until_it_unsubscribes", async () => {
  const { client } = await startedClient();
  const { provider, publish } = createSupervisedCodexProvider(() => Promise.resolve(client));
  const first: Array<ProviderEvent> = [];
  const second: Array<ProviderEvent> = [];
  const unsubscribeFirst = provider.onEvent((event) => first.push(event));
  provider.onEvent((event) => second.push(event));
  const event: ProviderEvent = { type: "delta", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-1"), text: "x" };

  publish(event);
  unsubscribeFirst();
  publish(event);

  expect(first).toEqual([event]);
  expect(second).toEqual([event, event]);
});

test("the_provider_reports_the_codex_id", async () => {
  const { client } = await startedClient();

  expect(createSupervisedCodexProvider(() => Promise.resolve(client)).provider.id).toBe("codex");
});
