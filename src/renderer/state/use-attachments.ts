// Holds the files attached to one composer: asks the main process to copy each one, and keeps the chips until a send succeeds.
import { useCallback, useRef, useState } from "react";

import { requireRoomForAttachment, type AttachmentChip } from "../../shared/attachment";
import type { MarginApi } from "../../shared/ipc-contract";

export type Attachments = Readonly<{
  chips: ReadonlyArray<AttachmentChip>;
  /** Attaches each file in turn; rejects with every refusal joined, after the accepted files became chips. */
  add: (files: ReadonlyArray<File>) => Promise<void>;
  /** Takes a chip off the message and deletes the copy; rejects when the main process cannot. */
  remove: (index: number) => Promise<void>;
  /** Forgets the chips after a send took their files. */
  clear: () => void;
}>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAttachments(api: MarginApi): Attachments {
  const [chips, setChips] = useState<ReadonlyArray<AttachmentChip>>([]);
  /** The chips as of the last change, so files added in one drop see each other's count. */
  const latest = useRef<ReadonlyArray<AttachmentChip>>([]);
  const publish = useCallback((next: ReadonlyArray<AttachmentChip>): void => {
    latest.current = next;
    setChips(next);
  }, []);

  const add = useCallback(
    async (files: ReadonlyArray<File>): Promise<void> => {
      const refusals: Array<string> = [];
      for (const file of files) {
        try {
          requireRoomForAttachment(latest.current.length);
          const chip = await api.attachmentAdd(file.name, new Uint8Array(await file.arrayBuffer()));
          publish([...latest.current, chip]);
        } catch (error) {
          refusals.push(messageOf(error));
        }
      }
      if (refusals.length > 0) throw new Error(refusals.join("; "));
    },
    [api, publish],
  );

  const remove = useCallback(
    async (index: number): Promise<void> => {
      const chip = latest.current[index];
      if (chip === undefined) throw new Error(`there is no attached file at position ${index + 1}`);
      await api.attachmentDiscard(chip.id);
      publish(latest.current.filter((_, position) => position !== index));
    },
    [api, publish],
  );

  const clear = useCallback((): void => publish([]), [publish]);

  return { chips, add, remove, clear };
}
