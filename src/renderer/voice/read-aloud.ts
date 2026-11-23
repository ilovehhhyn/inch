// Reads answers aloud with the system voices of macOS through the Web Speech API, skipping code, and stops at once on Escape.

/** Answers are read aloud on request only; the setting turns on reading the answer to every spoken question. */
export const READ_ANSWERS_ALOUD_DEFAULT = false;
const SETTING_KEY = "margin.readAnswersAloud";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s+/;
const LIST_MARK = /^\s*(?:[-*+]|\d+\.)\s+/;
const QUOTE_MARK = /^\s*>\s?/;

function codeBlockSentence(lines: number): string {
  return `code block, ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** Replaces each fenced block, closed or not, with a sentence that counts its lines, so code is never read out. */
function replaceCodeBlocks(markdown: string): Array<string> {
  const out: Array<string> = [];
  let fence: string | null = null;
  let lines = 0;
  for (const line of markdown.split("\n")) {
    const opening = FENCE.exec(line)?.[1];
    if (fence === null && opening !== undefined) {
      fence = opening;
      lines = 0;
    } else if (fence !== null && opening === fence) {
      out.push("", codeBlockSentence(lines), "");
      fence = null;
    } else if (fence !== null) lines += 1;
    else out.push(line);
  }
  if (fence !== null) out.push("", codeBlockSentence(lines), "");
  return out;
}

function withoutMarks(line: string): string {
  return line
    .replace(HEADING, "")
    .replace(LIST_MARK, "")
    .replace(QUOTE_MARK, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*?)\*/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}

/** The paragraphs to speak, in order: marks removed, each fenced block replaced by "code block, N lines". */
export function speakableParagraphs(markdown: string): Array<string> {
  const paragraphs: Array<Array<string>> = [[]];
  for (const line of replaceCodeBlocks(markdown)) {
    if (line.trim() === "") paragraphs.push([]);
    else paragraphs.at(-1)?.push(withoutMarks(line).trim());
  }
  return paragraphs.map((lines) => lines.filter((line) => line !== "").join(" ")).filter((paragraph) => paragraph !== "");
}

/** An answer is read on its own only when its question was spoken and the setting is on; a typed question's answer is read on request. */
export function shouldReadAnswer(input: Readonly<{ readAloudOn: boolean; wasSpoken: boolean }>): boolean {
  return input.readAloudOn && input.wasSpoken;
}

export type SpeechEngine = Readonly<{
  speak: (text: string, handlers: Readonly<{ onEnd: () => void; onError: (message: string) => void }>) => void;
  /** Stops what is being spoken and drops anything queued. */
  stop: () => void;
}>;

export type ReadAloud = Readonly<{
  /** Reads `markdown` as answer `id`, or stops when `id` is the answer already being read. */
  toggle: (id: string, markdown: string) => void;
  stop: () => void;
  /** The answer being read, or null. */
  speakingId: () => string | null;
  /** Stops speech when Escape is pressed on `target`; the returned function detaches the listener. */
  attachEscape: (target: EventTarget) => () => void;
}>;

export function createReadAloud(engine: SpeechEngine, onChange: (speakingId: string | null) => void, onError: (message: string) => void = () => undefined): ReadAloud {
  let speaking: string | null = null;
  let queue: Array<string> = [];
  /** Callbacks of an utterance that was stopped carry an old generation and are ignored. */
  let generation = 0;

  function setSpeaking(id: string | null): void {
    if (speaking === id) return;
    speaking = id;
    onChange(id);
  }

  /** The engine is told to stop only while something is being read, so stopping when idle never touches speech synthesis. */
  function stop(): void {
    generation += 1;
    queue = [];
    if (speaking === null) return;
    engine.stop();
    setSpeaking(null);
  }

  function fail(message: string): void {
    generation += 1;
    queue = [];
    setSpeaking(null);
    onError(`Could not read the answer aloud: ${message}`);
  }

  function speakNext(current: number): void {
    const paragraph = queue.shift();
    if (paragraph === undefined) return setSpeaking(null);
    try {
      engine.speak(paragraph, {
        onEnd: () => {
          if (current === generation) speakNext(current);
        },
        onError: (message) => {
          if (current === generation) fail(message);
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    toggle(id, markdown) {
      if (speaking === id) return stop();
      stop();
      queue = speakableParagraphs(markdown);
      if (queue.length === 0) return;
      setSpeaking(id);
      speakNext(generation);
    },
    stop,
    speakingId: () => speaking,
    attachEscape(target) {
      const listener = (event: Event): void => {
        if (event instanceof KeyboardEvent && event.key === "Escape" && speaking !== null) stop();
      };
      target.addEventListener("keydown", listener);
      return () => target.removeEventListener("keydown", listener);
    },
  };
}

export type BrowserSpeechEngine = SpeechEngine & Readonly<{ activeUtterance: () => SpeechSynthesisUtterance | null }>;

/**
 * The system voices through `speechSynthesis`; a window without it fails when something is spoken, not when the window opens.
 * The utterance being spoken is kept in `active` until it ends, fails or is stopped: Chromium can collect an utterance that
 * nothing references and then never fire `end`, which would stop the queue after the first paragraph.
 */
export function createBrowserSpeechEngine(): BrowserSpeechEngine {
  let active: SpeechSynthesisUtterance | null = null;
  const synthesis = (): SpeechSynthesis => {
    if (typeof speechSynthesis === "undefined") throw new Error("speech synthesis is not available in this window");
    return speechSynthesis;
  };
  return {
    speak(text, handlers) {
      const utterance = new SpeechSynthesisUtterance(text);
      const release = (): void => {
        if (active === utterance) active = null;
      };
      utterance.addEventListener("end", () => {
        release();
        handlers.onEnd();
      });
      utterance.addEventListener("error", (event) => {
        release();
        handlers.onError(event.error);
      });
      active = utterance;
      synthesis().speak(utterance);
    },
    stop() {
      active = null;
      synthesis().cancel();
    },
    activeUtterance: () => active,
  };
}

export type ReadAloudSetting = Readonly<{ read: () => boolean; write: (isOn: boolean) => void }>;

/** The setting lives in the window's local storage as `on` or `off`; unset means the default, and any other value is an error. */
export function createReadAloudSetting(storage: Pick<Storage, "getItem" | "setItem">): ReadAloudSetting {
  return {
    read() {
      const stored = storage.getItem(SETTING_KEY);
      if (stored === null) return READ_ANSWERS_ALOUD_DEFAULT;
      if (stored === "on") return true;
      if (stored === "off") return false;
      throw new Error(`the saved read-aloud setting is \`${stored}\`; it must be on or off, so switch the setting again to repair it`);
    },
    write: (isOn) => storage.setItem(SETTING_KEY, isOn ? "on" : "off"),
  };
}
