// Invariant: a turn starts only after the chat's model choice is saved, a failure to save blocks the send before anything runs, and a send that the provider refuses leaves its files removable.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createAttachmentStore } from "../../src/main/attachments";
import { createChoiceStore } from "../../src/main/choice-store";
import { createTurnStarter } from "../../src/main/turn-starter";
import type { ChatProvider, TurnInput } from "../../src/shared/chat-provider";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";

const THREAD = asThreadId("thread-1");
const CHOICE = { model: "claude-opus-5-5", reasoning: "high" };

async function setup(providerResult: "accept" | "refuse" = "accept") {
  const directory = await mkdtemp(join(tmpdir(), "margin-turn-"));
  const calls: Array<string> = [];
  const received: Array<TurnInput> = [];
  const choices = createChoiceStore(join(directory, "choices.json"));
  const attachments = createAttachmentStore({ directory: join(directory, "attachments") });
  const provider = {
    startTurn: async (_threadId: unknown, input: TurnInput) => {
      calls.push("startTurn");
      received.push(input);
      if (providerResult === "refuse") throw new Error("cannot send image `pixel.png` to `plain`, which reads text only");
      return asTurnId("turn-1");
    },
  } as unknown as ChatProvider; // the starter calls startTurn and nothing else
  return { directory, calls, received, choices, attachments, start: createTurnStarter({ providerFor: () => provider, choices, attachments }) };
}

test("the_choice_is_saved_before_the_turn_starts_and_the_files_are_then_committed", async () => {
  const { calls, choices, start, attachments, received } = await setup();
  const file = await attachments.add({ name: "a.txt", bytes: new TextEncoder().encode("hello") });

  const turnId = await start("claude", THREAD, "q", null, CHOICE, [file.id]);

  expect(turnId).toBe("turn-1");
  expect(calls).toEqual(["startTurn"]);
  expect(await choices.read(THREAD)).toEqual(CHOICE);
  expect(received[0]?.attachments.map((attachment) => attachment.name)).toEqual(["a.txt"]);
  await expect(attachments.discard(file.id)).rejects.toThrow("belongs to a message that was sent");
});

test("a_choice_file_that_cannot_be_read_blocks_the_send_before_the_turn_starts", async () => {
  const { directory, calls, start } = await setup();
  await writeFile(join(directory, "choices.json"), "{not json");

  await expect(start("claude", THREAD, "q", null, CHOICE, [])).rejects.toThrow("is not valid JSON");

  expect(calls).toEqual([]);
});

test("a_refused_send_leaves_its_files_removable_and_does_not_commit_them", async () => {
  const { start, attachments } = await setup("refuse");
  const file = await attachments.add({ name: "pixel.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) });

  await expect(start("codex", THREAD, "q", null, CHOICE, [file.id])).rejects.toThrow("reads text only");

  await expect(attachments.discard(file.id)).resolves.toBeUndefined();
});
