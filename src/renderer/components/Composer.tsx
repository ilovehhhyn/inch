// Holds the text the user is typing; the draft lives in the parent so it survives a sign-out.
import type { ReactElement } from "react";

export type ComposerProps = Readonly<{ draft: string; onDraftChange: (draft: string) => void }>;

export function Composer({ draft, onDraftChange }: ComposerProps): ReactElement {
  return <textarea aria-label="Message" value={draft} onChange={(event) => onDraftChange(event.target.value)} />;
}
