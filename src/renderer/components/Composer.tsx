// Holds the text the user is typing and turns Enter, Command-I and Escape into send and interrupt requests; the draft lives in the parent.
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement } from "react";

import type { AttachmentChip } from "../../shared/attachment";
import { choiceAfterModelChange, type ModelChoice, type ModelOption } from "../../shared/models";
import type { ProviderId } from "../../shared/provider-id";
import { AttachmentChips } from "./AttachmentChips";
import { ModelPicker } from "./ModelPicker";
import { ProviderPicker } from "./ProviderPicker";
import { ReasoningPicker } from "./ReasoningPicker";

export type SendMode = "plain" | "withContext";

export const BUSY_HINT = "Wait for the answer, or press Esc to stop it";
export const EMPTY_HINT = "Type a question first";

/** The pickers under the composer; `provider` is present only for a new chat that can use more than one provider. */
export type ComposerPickers = Readonly<{
  models: ReadonlyArray<ModelOption>;
  choice: ModelChoice;
  onChoiceChange: (choice: ModelChoice) => void;
  provider?: Readonly<{ providers: ReadonlyArray<ProviderId>; selected: ProviderId; onChange: (provider: ProviderId) => void }>;
}>;

/** The files attached to this composer; `onAdd` rejects with the reason a file was refused, and the composer shows it. */
export type ComposerAttachments = Readonly<{
  chips: ReadonlyArray<AttachmentChip>;
  onAdd: (files: ReadonlyArray<File>) => Promise<void>;
  onRemove: (index: number) => Promise<void>;
}>;

export type ComposerProps = Readonly<{
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Resolves true once the question was accepted; the draft stays in the box until then, and after any failure. */
  onSend: (question: string, mode: SendMode) => Promise<boolean>;
  onInterrupt: () => void;
  /** True while an answer streams: every send is refused and nothing is queued. */
  busy: boolean;
  placeholder?: string;
  /** The accessible name of the text box; the main composer and each side chat composer need different ones. */
  label?: string;
  pickers?: ComposerPickers;
  attachments?: ComposerAttachments;
}>;

function sendModeOf(event: KeyboardEvent<HTMLTextAreaElement>): SendMode | null {
  const isComposing = event.nativeEvent.isComposing;
  if (isComposing) return null;
  const isCommandI = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "i";
  if (isCommandI) return "withContext";
  if (event.key === "Enter" && !event.shiftKey) return "plain";
  return null;
}

export function Composer({ draft, onDraftChange, onSend, onInterrupt, busy, placeholder = "Ask anything", label = "Message", pickers, attachments }: ComposerProps): ReactElement {
  const [hint, setHint] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const latestDraft = useRef(draft);
  useLayoutEffect(() => {
    latestDraft.current = draft;
  }, [draft]);

  /** After a successful send only the sent text is removed; anything typed while the send was in flight stays. */
  function clearSent(sentDraft: string): void {
    const current = latestDraft.current;
    if (current.startsWith(sentDraft)) onDraftChange(current.slice(sentDraft.length));
  }

  function attachFiles(files: ReadonlyArray<File>): void {
    if (attachments === undefined || files.length === 0) return;
    attachments.onAdd(files).then(
      () => setHint(null),
      (error: unknown) => setHint(error instanceof Error ? error.message : String(error)),
    );
  }

  function removeChip(index: number): void {
    attachments?.onRemove(index).catch((error: unknown) => setHint(error instanceof Error ? error.message : String(error)));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  }

  function changeModel(modelId: string): void {
    if (pickers === undefined) return;
    const option = pickers.models.find((model) => model.id === modelId);
    if (option === undefined) throw new Error(`model ${modelId} is not in the list the picker shows`);
    const change = choiceAfterModelChange(option, pickers.choice.reasoning);
    setHint(change.note);
    pickers.onChoiceChange(change.choice);
  }

  function trySend(mode: SendMode): void {
    const question = draft.trim();
    if (busy) return setHint(BUSY_HINT);
    if (question === "") return setHint(EMPTY_HINT);
    setHint(null);
    const sentDraft = draft;
    void onSend(question, mode).then((wasSent) => {
      if (wasSent) clearSent(sentDraft);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      onInterrupt();
      return;
    }
    const mode = sendModeOf(event);
    if (mode === null) return;
    event.preventDefault();
    trySend(mode);
  }

  return (
    <div className="composer" data-context-occluder="" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <textarea
        aria-label={label}
        className="composer-input"
        rows={1}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setHint(null);
          onDraftChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      {attachments === undefined ? null : (
        <>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Choose files"
            onChange={(event) => {
              attachFiles([...(event.target.files ?? [])]);
              event.target.value = ""; // the same file can then be chosen again
            }}
          />
          <button type="button" className="attach" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            +
          </button>
        </>
      )}
      <button type="button" className="send" aria-label="Send" onClick={() => trySend("plain")}>
        ↑
      </button>
      <div className="composer-above">
        {hint === null ? null : (
          <p className="composer-hint" role="status">
            {hint}
          </p>
        )}
        {attachments === undefined ? null : <AttachmentChips chips={attachments.chips} onRemove={removeChip} />}
      </div>
      {pickers === undefined ? null : (
        <div className="composer-tools">
          {pickers.provider === undefined ? null : <ProviderPicker {...pickers.provider} />}
          <ModelPicker models={pickers.models} value={pickers.choice.model} onChange={changeModel} />
          <ReasoningPicker
            levels={pickers.models.find((model) => model.id === pickers.choice.model)?.reasoningLevels ?? []}
            value={pickers.choice.reasoning}
            onChange={(reasoning) => {
              setHint(null);
              pickers.onChoiceChange({ model: pickers.choice.model, reasoning });
            }}
          />
        </div>
      )}
    </div>
  );
}
