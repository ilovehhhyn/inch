// Starts a turn in the order that keeps a failure harmless: take the files, save the model choice, start the turn, and only then call the files sent.
import type { AttachmentStore } from "./attachments";
import type { ChoiceStore } from "./choice-store";
import type { ChatProvider } from "../shared/chat-provider";
import type { ScreenContext } from "../shared/context-format";
import type { ModelChoice } from "../shared/models";
import type { ThreadId, TurnId } from "../shared/provider-events";
import type { ProviderId } from "../shared/provider-id";

export type TurnStarterServices = Readonly<{ providerFor: (id: ProviderId) => ChatProvider; choices: ChoiceStore; attachments: AttachmentStore }>;

/**
 * The choice is written before the turn starts, so a choice file that cannot be written stops the send cleanly instead of
 * failing a turn that is already running. A provider that refuses the turn leaves the files adopted but not committed, so
 * the window can still remove them or send them in another chat.
 */
export function createTurnStarter(services: TurnStarterServices): (provider: ProviderId, threadId: ThreadId, question: string, context: ScreenContext | null, choice: ModelChoice, attachmentIds: ReadonlyArray<string>) => Promise<TurnId> {
  return async (provider, threadId, question, context, choice, attachmentIds) => {
    const adopted = await services.attachments.adopt(threadId, attachmentIds);
    await services.choices.write(threadId, choice);
    const turnId = await services.providerFor(provider).startTurn(threadId, { question, context, model: choice.model, reasoning: choice.reasoning, attachments: adopted });
    services.attachments.commit(attachmentIds);
    return turnId;
  };
}
