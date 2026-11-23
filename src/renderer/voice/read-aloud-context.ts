// Gives every answer in the window the one reader that speaks answers, so a speaker button needs no props passed down through the panes.
import { createContext } from "react";

export type AnswerReader = Readonly<{
  /** The answer being read, or null. */
  speakingId: string | null;
  toggle: (id: string, markdown: string) => void;
}>;

/** No reader means no speaker buttons, which is how a message is drawn outside the window. */
export const AnswerReaderContext = createContext<AnswerReader | null>(null);
