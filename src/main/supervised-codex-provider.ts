// Gives the Codex provider the client that is running now, waiting through a restart, and fans supervisor events out to subscribers.
import { createCodexProvider } from "../codex/codex-provider";
import type { CodexClient } from "../codex/codex-client";
import type { AttachmentContent } from "../shared/attachment";
import type { ChatProvider } from "../shared/chat-provider";
import type { ProviderEvent } from "../shared/provider-events";

export type SupervisedCodexProvider = Readonly<{
  provider: ChatProvider;
  /** Feeds one event to every subscriber; the supervisor calls it for client events and for the crash event it makes itself. */
  publish: (event: ProviderEvent) => void;
}>;

/**
 * `ready` resolves to the running client, after a restart when one is under way, and rejects when Codex cannot run.
 * Events come from `publish`, not from a client, because a client dies with its app-server and the supervisor also
 * reports the failed turn of a crash.
 */
export function createSupervisedCodexProvider(ready: () => Promise<CodexClient>, content?: AttachmentContent): SupervisedCodexProvider {
  const handlers = new Set<(event: ProviderEvent) => void>();
  const current = async (): Promise<ChatProvider> => createCodexProvider(await ready(), content);
  const provider: ChatProvider = {
    id: "codex",
    readAccount: async () => (await current()).readAccount(),
    listModels: async () => (await current()).listModels(),
    startThread: async () => (await current()).startThread(),
    forkThread: async (threadId, lastTurnId) => (await current()).forkThread(threadId, lastTurnId),
    startTurn: async (threadId, input) => (await current()).startTurn(threadId, input),
    interruptTurn: async (threadId, turnId) => (await current()).interruptTurn(threadId, turnId),
    readThread: async (threadId) => (await current()).readThread(threadId),
    listThreads: async () => (await current()).listThreads(),
    onEvent: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return { provider, publish: (event) => void [...handlers].forEach((handler) => handler(event)) };
}
