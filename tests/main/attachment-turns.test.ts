// Invariant: each provider sends attachments before the context block and the context block before the question, in the form its model reads, and refuses an image for a text-only model before anything is sent.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createClaudeProvider } from "../../src/claude/claude-provider";
import { createClaudeThreadStore } from "../../src/claude/claude-thread-store";
import { CodexClient } from "../../src/codex/codex-client";
import { createCodexProvider } from "../../src/codex/codex-provider";
import { RpcConnection } from "../../src/codex/rpc-connection";
import { toHistory } from "../../src/codex/thread-history";
import { createAttachmentContent, createAttachmentStore } from "../../src/main/attachments";
import type { Attachment, AttachmentContent } from "../../src/shared/attachment";
import { renderContextBlock, type ScreenContext } from "../../src/shared/context-format";
import { asThreadId, type ProviderEvent } from "../../src/shared/provider-events";
import { FakeAnthropic } from "../fakes/fake-anthropic";
import { FakeAppServer } from "../fakes/fake-app-server";
import { readFile } from "node:fs/promises";

const EMPTY_WORKSPACE = "/Users/example/Library/Application Support/Margin/empty-workspace";
const CONTEXT: ScreenContext = { paneKind: "diff", paneTitle: "repo", blocks: [{ label: "train.py line 39", text: "return peak * (step // warmup_steps)" }] };
const THREAD = asThreadId("thread-1");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../fixtures/attachments/${name}`, import.meta.url)));
}

async function stored(names: ReadonlyArray<readonly [string, string]>): Promise<Array<Attachment>> {
  const store = createAttachmentStore({ directory: await mkdtemp(join(tmpdir(), "margin-turns-")) });
  const added: Array<Attachment> = [];
  for (const [file, name] of names) added.push(await store.add({ name, bytes: await fixture(file) }));
  return store.adopt(THREAD, added.map((attachment) => attachment.id)).then((moved) => [...moved]);
}

function modelEntry(id: string, modalities: Array<string>) {
  return { id, displayName: id, hidden: false, isDefault: id === "vision", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }], defaultReasoningEffort: "low", inputModalities: modalities };
}

async function codex(content: AttachmentContent = createAttachmentContent()) {
  const fake = new FakeAppServer();
  fake.respond("initialize", { userAgent: "codex/0.146.0", codexHome: "/h", platformFamily: "unix", platformOs: "macos" });
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });
  fake.respond("model/list", { data: [modelEntry("vision", ["text", "image"]), modelEntry("plain", ["text"])], nextCursor: null });
  fake.respond("turn/start", { turn: { id: "turn-1" } });
  const client = new CodexClient({ connection: new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 }), appVersion: "1", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });
  await client.initialize();
  const skip = fake.received().length;
  return { provider: createCodexProvider(client, content), sent: () => fake.received().slice(skip) };
}

function turnInput(attachments: ReadonlyArray<Attachment>, model = "vision") {
  return { question: "does this look right?", context: CONTEXT, model, reasoning: "low", attachments };
}

test("codex_image_becomes_local_image_with_the_copied_path", async () => {
  const [image] = await stored([["pixel.png", "pixel.png"]]);
  const { provider, sent } = await codex();

  await provider.startTurn(THREAD, turnInput(image === undefined ? [] : [image]));

  const input = (sent().find((message) => message.method === "turn/start")?.params as { input: Array<{ type: string; path?: string }> }).input;
  expect(input[0]).toEqual({ type: "localImage", path: image?.storedPath });
  expect(image?.storedPath).toContain(`${"thread-1"}/`);
});

test("codex_pdf_becomes_extracted_text", async () => {
  const attachments = await stored([["two-pages.pdf", "paper.pdf"]]);
  const { provider, sent } = await codex();

  await provider.startTurn(THREAD, turnInput(attachments));

  const input = (sent().find((message) => message.method === "turn/start")?.params as { input: Array<{ type: string; text?: string }> }).input;
  expect(input[0]).toEqual({ type: "text", text: "ATTACHED PDF paper.pdf (text only)\n[page 1]\nPage one warmup schedule\n\n[page 2]\nPage two cosine decay\nEND ATTACHMENT\n\n", text_elements: [] });
});

test("order_is_attachments_then_context_then_question_for_codex", async () => {
  const attachments = await stored([["pixel.png", "pixel.png"], ["train.py", "train.py"], ["two-pages.pdf", "paper.pdf"]]);
  const { provider, sent } = await codex();

  await provider.startTurn(THREAD, turnInput(attachments));

  const input = (sent().find((message) => message.method === "turn/start")?.params as { input: Array<{ type: string; text?: string; path?: string }> }).input;
  expect(input.map((item) => item.type)).toEqual(["localImage", "text", "text", "text", "text"]);
  expect(input[1]?.text?.startsWith("ATTACHED FILE train.py\ndef get_lr")).toBe(true);
  expect(input[2]?.text?.startsWith("ATTACHED PDF paper.pdf (text only)")).toBe(true);
  expect(input[3]?.text).toBe(`${renderContextBlock(CONTEXT)}\n\n`);
  expect(input[4]?.text).toBe("does this look right?");
});

test("a_reloaded_codex_turn_shows_its_attachments_and_only_the_question", async () => {
  const attachments = await stored([["train.py", "train.py"], ["two-pages.pdf", "paper.pdf"]]);
  const { provider, sent } = await codex();
  await provider.startTurn(THREAD, turnInput(attachments));
  const items = (sent().find((message) => message.method === "turn/start")?.params as { input: Array<{ type: string; text?: string }> }).input;
  const joined = items.map((item) => item.text ?? "").join(""); // the app-server stores consecutive text items as one item with no separator
  const image = { type: "localImage" as const, path: "/stored/thread-1/id-9/pixel.png" };

  const history = toHistory({
    id: "thread-1",
    turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage", id: "u", clientId: null, content: [image, { type: "text", text: joined, text_elements: [] }] }] }],
  } as never); // the fixture sets only the fields the history code reads

  expect(history).toEqual([
    {
      turnId: "t1",
      role: "user",
      text: "does this look right?",
      status: "done",
      attachments: [{ kind: "image", name: "pixel.png" }, { kind: "text", name: "train.py" }, { kind: "pdf", name: "paper.pdf" }],
    },
  ]);
});

test("image_sent_to_a_text_only_model_is_refused_before_sending_by_codex", async () => {
  const [image] = await stored([["pixel.png", "pixel.png"]]);
  const { provider, sent } = await codex();

  await expect(provider.startTurn(THREAD, turnInput(image === undefined ? [] : [image], "plain"))).rejects.toThrow("cannot send image `pixel.png` to `plain`, which reads text only");

  expect(sent().map((message) => message.method)).toEqual(["model/list"]);
});

test("a_codex_turn_with_attachments_but_no_content_reader_is_an_error_naming_the_fix", async () => {
  const [image] = await stored([["pixel.png", "pixel.png"]]);
  const fake = new FakeAppServer();
  fake.respond("initialize", { userAgent: "codex/0.146.0", codexHome: "/h", platformFamily: "unix", platformOs: "macos" });
  fake.ignore("initialized");
  fake.respond("config/read", { config: {} });
  fake.respond("model/list", { data: [modelEntry("vision", ["text", "image"])], nextCursor: null });
  const client = new CodexClient({ connection: new RpcConnection({ input: fake.input, output: fake.output, requestTimeoutMs: 30_000 }), appVersion: "1", openExternal: async () => undefined, log: () => undefined, emptyWorkspacePath: EMPTY_WORKSPACE });
  await client.initialize();

  await expect(createCodexProvider(client).startTurn(THREAD, turnInput(image === undefined ? [] : [image]))).rejects.toThrow("the provider was created without an attachment reader");
});

async function claude() {
  const store = createClaudeThreadStore(join(await mkdtemp(join(tmpdir(), "margin-claude-")), "claude-threads"));
  const fake = new FakeAnthropic();
  let counter = 0;
  const events: Array<ProviderEvent> = [];
  const provider = createClaudeProvider({ credentials: async () => ({ kind: "apiKey", apiKey: "sk-ant-test" }), store, makeClient: () => fake.asClient(), createId: () => `id-${++counter}`, content: createAttachmentContent() });
  provider.onEvent((event) => events.push(event));
  fake.script({ kind: "answer", chunks: ["ok"] });
  return { provider, fake, events, store };
}

async function untilCompleted(events: ReadonlyArray<ProviderEvent>): Promise<void> {
  for (let attempt = 0; attempt < 500 && !events.some((event) => event.type === "completed"); attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(events.some((event) => event.type === "completed")).toBe(true);
}

test("claude_pdf_becomes_a_document_block", async () => {
  const attachments = await stored([["two-pages.pdf", "paper.pdf"]]);
  const { provider, fake, events } = await claude();
  const threadId = await provider.startThread();

  await provider.startTurn(threadId, { ...turnInput(attachments, "claude-opus-5-5"), context: null });
  await untilCompleted(events);

  const messages = fake.requests[0]?.params["messages"] as Array<{ content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }>;
  const blocks = messages[0]?.content ?? [];
  expect(blocks[0]).toEqual({ type: "text", text: "ATTACHED PDF paper.pdf" });
  expect(blocks[1]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(await fixture("two-pages.pdf")).toString("base64") } });
});

test("order_is_attachments_then_context_then_question_for_claude", async () => {
  const attachments = await stored([["pixel.png", "pixel.png"], ["train.py", "train.py"]]);
  const { provider, fake, events } = await claude();
  const threadId = await provider.startThread();

  await provider.startTurn(threadId, turnInput(attachments, "claude-opus-5-5"));
  await untilCompleted(events);

  const messages = fake.requests[0]?.params["messages"] as Array<{ content: Array<{ type: string; text?: string; source?: { media_type: string } }> }>;
  const blocks = messages[0]?.content ?? [];
  expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text", "text", "text"]);
  expect(blocks[0]?.text).toBe("ATTACHED IMAGE pixel.png");
  expect(blocks[1]?.source?.media_type).toBe("image/png");
  expect(blocks[2]?.text?.startsWith("ATTACHED FILE train.py\ndef get_lr")).toBe(true);
  expect(blocks[3]?.text).toBe(renderContextBlock(CONTEXT));
  expect(blocks[4]?.text).toBe("does this look right?");
});

test("a_reloaded_claude_chat_shows_its_attachments_and_only_the_question", async () => {
  const attachments = await stored([["pixel.png", "pixel.png"], ["train.py", "train.py"], ["two-pages.pdf", "paper.pdf"]]);
  const { provider, events } = await claude();
  const threadId = await provider.startThread();
  await provider.startTurn(threadId, turnInput(attachments, "claude-opus-5-5"));
  await untilCompleted(events);

  const history = await provider.readThread(threadId);

  expect(history[0]).toMatchObject({ role: "user", text: "does this look right?", attachments: [{ kind: "image", name: "pixel.png" }, { kind: "text", name: "train.py" }, { kind: "pdf", name: "paper.pdf" }] });
});

test("claude_refuses_nothing_for_images_and_pdfs_and_a_bad_attachment_rejects_before_any_request", async () => {
  const { provider, fake } = await claude();
  const threadId = await provider.startThread();
  const missing: Attachment = { id: "x", kind: "image", name: "gone.png", storedPath: "/nonexistent/gone.png", bytes: 1, mediaType: "image/png" };

  await expect(provider.startTurn(threadId, turnInput([missing], "claude-opus-5-5"))).rejects.toThrow(/ENOENT/);

  expect(fake.requests).toEqual([]);
});
