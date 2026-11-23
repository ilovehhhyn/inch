// Invariant: a model choice is accepted only when the model is offered and the reasoning level is one of that model's levels, and a model change keeps the level when the new model has it.
import { expect, test } from "vitest";

import { choiceAfterModelChange, defaultChoice, firstChoice, requireModelChoice, type ModelOption } from "../../src/shared/models";

const OPUS: ModelOption = { provider: "claude", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "low", acceptsImages: true, acceptsPdfs: true };
const SMALL: ModelOption = { provider: "codex", id: "small", label: "Small", reasoningLevels: ["medium", "high"], defaultReasoning: "medium", acceptsImages: false, acceptsPdfs: false };

test("an_offered_model_and_level_resolve_to_the_model_option", () => {
  expect(requireModelChoice([OPUS, SMALL], { model: "small", reasoning: "high" })).toBe(SMALL);
});

test("unknown_reasoning_value_is_rejected_before_sending", () => {
  expect(() => requireModelChoice([OPUS], { model: "claude-opus-5-5", reasoning: "turbo" })).toThrow(
    "reasoning level `turbo` is not offered by `claude-opus-5-5`; choose low, medium, high, xhigh or max",
  );
});

test("a_single_level_is_named_without_or", () => {
  const single: ModelOption = { ...SMALL, reasoningLevels: ["medium"] };
  expect(() => requireModelChoice([single], { model: "small", reasoning: "low" })).toThrow("choose medium");
});

test("an_unknown_model_is_rejected_with_the_offered_ids", () => {
  expect(() => requireModelChoice([OPUS, SMALL], { model: "gpt-9", reasoning: "low" })).toThrow("model `gpt-9` is not offered; choose claude-opus-5-5 or small");
});

test("an_empty_model_list_is_an_error_that_names_the_fix", () => {
  expect(() => requireModelChoice([], { model: "a", reasoning: "low" })).toThrow("no models are available; sign in again");
});

test("changing_to_a_model_without_the_level_selects_its_default_and_says_so", () => {
  expect(choiceAfterModelChange(SMALL, "low")).toEqual({ choice: { model: "small", reasoning: "medium" }, note: "Reasoning set to medium; this model has no low" });
});

test("changing_to_a_model_with_the_level_keeps_it_and_says_nothing", () => {
  expect(choiceAfterModelChange(OPUS, "high")).toEqual({ choice: { model: "claude-opus-5-5", reasoning: "high" }, note: null });
});

test("the_default_choice_is_the_first_model_with_its_default_level", () => {
  expect(defaultChoice([OPUS, SMALL])).toEqual({ model: "claude-opus-5-5", reasoning: "low" });
});

test("the_first_stored_choice_wins_even_when_the_model_is_no_longer_offered", () => {
  expect(firstChoice([OPUS], [null, { model: "retired", reasoning: "turbo" }, { model: "claude-opus-5-5", reasoning: "max" }])).toEqual({ model: "retired", reasoning: "turbo" });
});

test("with_no_stored_choice_the_default_is_used_and_an_empty_list_gives_null", () => {
  expect(firstChoice([OPUS], [null])).toEqual({ model: "claude-opus-5-5", reasoning: "low" });
  expect(firstChoice([], [null])).toBeNull();
});
