// Defines the one interface both model providers implement, so the window and the IPC layer never name a provider's protocol.
import type { Attachment } from "./attachment";
import type { ScreenContext } from "./context-format";
import type { ModelOption } from "./models";
import type { ProviderId } from "./provider-id";
import type { ProviderEvent, ThreadId, TurnId } from "./provider-events";
import type { DisplayMessage, ThreadSummary } from "./thread-history";

export type Unsubscribe = () => void;

/** The signed-in state of one provider; `label` is a plan or method such as "ChatGPT Plus", "Claude Console" or "API key", never a key, a token or an email. */
export type ProviderAccount = Readonly<{ provider: ProviderId; signedIn: boolean; label: string | null }>;

/**
 * `model` and `reasoning` must be one of `listModels()`; the provider rejects any other value before it sends anything.
 * `attachments` are Margin's stored copies, and reach the model before the context block, which reaches it before the question.
 */
export type TurnInput = Readonly<{ question: string; context: ScreenContext | null; model: string; reasoning: string; attachments: ReadonlyArray<Attachment> }>;

export interface ChatProvider {
  readonly id: ProviderId;
  readAccount(): Promise<ProviderAccount>;
  /** The models this account can use, the provider's default first. */
  listModels(): Promise<ReadonlyArray<ModelOption>>;
  /** Starts a chat on the provider's default model. */
  startThread(): Promise<ThreadId>;
  /** Forks `threadId` through `lastTurnId` into a new thread; side chats use it. */
  forkThread(threadId: ThreadId, lastTurnId: TurnId | null): Promise<ThreadId>;
  /** Sends the context block (when present) and then the question; resolves once the provider accepted the turn, and answers arrive through `onEvent`. */
  startTurn(threadId: ThreadId, input: TurnInput): Promise<TurnId>;
  interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
  /** The stored messages of a chat: questions without their context blocks, and answers. */
  readThread(threadId: ThreadId): Promise<ReadonlyArray<DisplayMessage>>;
  /** The chat list: the chats of this provider, newest first, side chats left out. */
  listThreads(): Promise<ReadonlyArray<ThreadSummary>>;
  onEvent(handler: (event: ProviderEvent) => void): Unsubscribe;
}
