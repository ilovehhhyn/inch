// Implements the ChatProvider interface over a CodexClient, so the rest of the app never sees the app-server protocol.
import type { ChatProvider, ProviderAccount } from "../shared/chat-provider";
import { renderAttachmentText, requireAttachmentsAccepted, type Attachment, type AttachmentContent } from "../shared/attachment";
import { renderContextBlock } from "../shared/context-format";
import { requireModelChoice } from "../shared/models";
import type { AccountSummary } from "../shared/auth";
import { summarizeAccount, type CodexClient } from "./codex-client";
import type { UserInput } from "./generated/v2/UserInput";
import { listChats, summarizeThread, toHistory } from "./thread-history";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function labelOf(summary: AccountSummary): string | null {
  if (!summary.signedIn) return null;
  if (summary.accountType === "apiKey") return "API key";
  return summary.planType === null ? "ChatGPT" : `ChatGPT ${capitalize(summary.planType)}`;
}

const TEXT_ITEM_END = "\n\n";

/** An image goes by its stored path; a text file or a PDF goes as text, which the app-server stores joined with the text after it, so each block ends with a blank line. */
async function attachmentItems(attachments: ReadonlyArray<Attachment>, content: AttachmentContent | undefined): Promise<Array<UserInput>> {
  if (attachments.length === 0) return [];
  if (content === undefined) throw new Error("the provider was created without an attachment reader; pass createAttachmentContent() when creating it");
  const items: Array<UserInput> = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") items.push({ type: "localImage", path: attachment.storedPath });
    else if (attachment.kind === "text") items.push({ type: "text", text: renderAttachmentText("text", attachment.name, await content.readText(attachment), false) + TEXT_ITEM_END, text_elements: [] });
    else items.push({ type: "text", text: renderAttachmentText("pdf", attachment.name, await content.extractPdfText(attachment), true) + TEXT_ITEM_END, text_elements: [] });
  }
  return items;
}

/** Wraps `client`; a restarted app-server has a new client, so the caller makes a new provider for it (the wrapper holds no state). */
export function createCodexProvider(client: CodexClient, content?: AttachmentContent): ChatProvider {
  return {
    id: "codex",
    async readAccount(): Promise<ProviderAccount> {
      const summary = summarizeAccount(await client.readAccount());
      return { provider: "codex", signedIn: summary.signedIn, label: labelOf(summary) };
    },
    async startThread() {
      return client.startThread({ model: await client.defaultModelId() });
    },
    async forkThread(threadId, lastTurnId) {
      return client.forkThread(threadId, lastTurnId, await client.defaultModelId());
    },
    listModels: () => client.listModels(),
    async startTurn(threadId, input) {
      const option = requireModelChoice(await client.listModels(), { model: input.model, reasoning: input.reasoning });
      requireAttachmentsAccepted(option, input.attachments);
      const items = await attachmentItems(input.attachments, content);
      return client.startTurn(threadId, { question: input.question, context: input.context === null ? null : { text: renderContextBlock(input.context) }, model: input.model, effort: input.reasoning, attachmentItems: items });
    },
    interruptTurn: (threadId, turnId) => client.interruptTurn(threadId, turnId),
    async readThread(threadId) {
      await client.resumeThread(threadId, await client.defaultModelId());
      return toHistory(await client.readThread(threadId));
    },
    async listThreads() {
      return listChats(await client.listThreads()).map(summarizeThread);
    },
    onEvent: (handler) => client.onProviderEvent(handler),
  };
}
