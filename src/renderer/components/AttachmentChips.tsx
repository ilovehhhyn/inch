// Draws attached files as chips; chips above the composer can be removed, chips in a sent message cannot.
import type { ReactElement } from "react";

import type { AttachmentSummary } from "../../shared/attachment";

export type AttachmentChipsProps = Readonly<{
  chips: ReadonlyArray<AttachmentSummary>;
  /** Present on the composer's chips: removes the chip at this position. */
  onRemove?: (index: number) => void;
}>;

export function AttachmentChips({ chips, onRemove }: AttachmentChipsProps): ReactElement | null {
  if (chips.length === 0) return null;
  return (
    <ul className="chips" aria-label="Attached files">
      {chips.map((chip, index) => (
        <li key={`${index}:${chip.name}`} className="chip" data-kind={chip.kind}>
          <span className="chip-name">{chip.name}</span>
          {onRemove === undefined ? null : (
            <button type="button" className="chip-remove" aria-label={`Remove ${chip.name}`} onClick={() => onRemove(index)}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
