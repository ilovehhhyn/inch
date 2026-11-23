// Implements the ChatProvider interface over a CodexClient, so the rest of the app never sees the app-server protocol.
import type { ChatProvider, ProviderAccount } from "../shared/chat-provider";
import { renderContextBlock } from "../shared/context-format";
import type { AccountSummary } from "../shared/auth";
import { summarizeAccount, type CodexClient } from "./codex-client";
import { listChats, summarizeThread, toHistory } from "./thread-history";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function labelOf(summary: AccountSummary): string | null {
  if (!summary.signedIn) return null;
  if (summary.accountType === "apiKey") return "API key";
  return summary.planType === null ? "ChatGPT" : `ChatGPT ${capitalize(summary.planType)}`;
}

/** Wraps `client`; a restarted app-server has a new client, so the caller makes a new provider for it (the wrapper holds no state). */
export function createCodexProvider(client: CodexClient): ChatProvider {
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
    startTurn(threadId, input) {
      return client.startTurn(threadId, { question: input.question, context: input.context === null ? null : { text: renderContextBlock(input.context) } });
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
