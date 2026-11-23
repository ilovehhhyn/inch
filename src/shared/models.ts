// Describes the models a provider offers and the model and reasoning level chosen for a message, and rejects a choice the provider does not offer.
import type { ProviderId } from "./provider-id";

/** One model a provider offers; the first option a provider lists is its default. */
export type ModelOption = Readonly<{
  provider: ProviderId;
  id: string;
  label: string;
  reasoningLevels: ReadonlyArray<string>;
  defaultReasoning: string;
  acceptsImages: boolean;
  /** True when the provider reads a PDF itself; false means Margin sends the PDF's extracted text. */
  acceptsPdfs: boolean;
}>;

export type ModelChoice = Readonly<{ model: string; reasoning: string }>;

/** "low, medium or high"; one item stands alone. */
export function listChoices(items: ReadonlyArray<string>): string {
  const last = items.at(-1);
  if (last === undefined) return "";
  if (items.length === 1) return last;
  return `${items.slice(0, -1).join(", ")} or ${last}`;
}

/** The option for `choice`, or an error naming what the provider offers; this runs before anything is sent. */
export function requireModelChoice(models: ReadonlyArray<ModelOption>, choice: ModelChoice): ModelOption {
  if (models.length === 0) throw new Error("no models are available; sign in again or restart Margin");
  const option = models.find((candidate) => candidate.id === choice.model);
  if (option === undefined) throw new Error(`model \`${choice.model}\` is not offered; choose ${listChoices(models.map((candidate) => candidate.id))}`);
  if (!option.reasoningLevels.includes(choice.reasoning)) {
    throw new Error(`reasoning level \`${choice.reasoning}\` is not offered by \`${option.id}\`; choose ${listChoices(option.reasoningLevels)}`);
  }
  return option;
}

export type ChoiceChange = Readonly<{ choice: ModelChoice; note: string | null }>;

/** Switches to `option`; the level stays when the model has it, else the model's default is selected and the note says so. */
export function choiceAfterModelChange(option: ModelOption, currentReasoning: string): ChoiceChange {
  if (option.reasoningLevels.includes(currentReasoning)) return { choice: { model: option.id, reasoning: currentReasoning }, note: null };
  return {
    choice: { model: option.id, reasoning: option.defaultReasoning },
    note: `Reasoning set to ${option.defaultReasoning}; this model has no ${currentReasoning}`,
  };
}

/** The first model with its default level; `models` must not be empty. */
export function defaultChoice(models: ReadonlyArray<ModelOption>): ModelChoice {
  const first = models[0];
  if (first === undefined) throw new Error("no models are available; sign in again or restart Margin");
  return { model: first.id, reasoning: first.defaultReasoning };
}
