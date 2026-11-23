// Renders and parses the MARGIN SCREEN CONTEXT block: the one text form in which a pane's visible text travels with a question.

export type ContextBlock = Readonly<{ text: string; label: string }>;

/** Positions are not part of the text form, so a parsed block carries only its text and label. */
export type ScreenContext = Readonly<{ paneKind: "chat" | "diff"; paneTitle: string; blocks: ReadonlyArray<ContextBlock> }>;

export const CONTEXT_HEADER_LINE = "MARGIN SCREEN CONTEXT v1";
const END_LINE = "END MARGIN SCREEN CONTEXT";
const BLOCK_PREFIX = "--- ";
const PANE_PREFIX = "pane: ";
const TITLE_SEPARATOR = " · ";
const PANE_LINE = /^pane: (chat|diff) · (.*)$/;
/** A text line equal to a delimiter gets one backslash in front; a line that already starts with backslashes and then a delimiter gets one more. */
const NEEDS_ESCAPE = /^\\*(--- |END MARGIN SCREEN CONTEXT$|MARGIN SCREEN CONTEXT v1$)/;
const IS_ESCAPED = /^\\+(--- |END MARGIN SCREEN CONTEXT$|MARGIN SCREEN CONTEXT v1$)/;

function requireOneLine(value: string, name: string): void {
  if (value.includes("\n")) throw new Error(`${name} must be one line, got ${JSON.stringify(value.slice(0, 60))}; collapse the line breaks where the value is built`);
}

function escapeLine(line: string): string {
  return NEEDS_ESCAPE.test(line) ? `\\${line}` : line;
}

function unescapeLine(line: string): string {
  return IS_ESCAPED.test(line) ? line.slice(1) : line;
}

function blockLines(block: ContextBlock): Array<string> {
  requireOneLine(block.label, "block label");
  if (block.label === "") throw new Error("block label must not be empty; every context block needs a label such as `train.py line 39`");
  return [`${BLOCK_PREFIX}${block.label}`, ...block.text.split("\n").map(escapeLine)];
}

/** The characters `block` adds to the rendered text: its lines and the line break that follows them. */
export function blockChars(block: ContextBlock): number {
  return blockLines(block).join("\n").length + 1;
}

export function renderContextBlock(context: ScreenContext): string {
  requireOneLine(context.paneTitle, "pane title");
  return [CONTEXT_HEADER_LINE, `${PANE_PREFIX}${context.paneKind}${TITLE_SEPARATOR}${context.paneTitle}`, ...context.blocks.flatMap(blockLines), END_LINE].join("\n");
}

function parseBlocks(lines: ReadonlyArray<string>): Array<ContextBlock> | null {
  const blocks: Array<{ label: string; textLines: Array<string> }> = [];
  for (const line of lines) {
    if (line.startsWith(BLOCK_PREFIX)) blocks.push({ label: line.slice(BLOCK_PREFIX.length), textLines: [] });
    else if (blocks.length === 0) return null;
    else blocks.at(-1)?.textLines.push(unescapeLine(line));
  }
  return blocks.map((block) => ({ label: block.label, text: block.textLines.join("\n") }));
}

/** Splits stored user text into its context block and the question after it; null when the text does not start with a block. */
export function splitContextBlock(text: string): Readonly<{ context: ScreenContext; question: string }> | null {
  const lines = text.split("\n");
  const paneMatch = PANE_LINE.exec(lines[1] ?? "");
  const endIndex = lines.indexOf(END_LINE);
  if (lines[0] !== CONTEXT_HEADER_LINE || paneMatch === null || endIndex < 2) return null;
  const blocks = parseBlocks(lines.slice(2, endIndex));
  if (blocks === null) return null;
  const paneKind = paneMatch[1] === "chat" ? "chat" : "diff";
  const rest = lines.slice(endIndex + 1).join("\n");
  return { context: { paneKind, paneTitle: paneMatch[2] ?? "", blocks }, question: rest.startsWith("\n") ? rest.slice(1) : rest };
}

export function parseContextBlock(text: string): ScreenContext | null {
  return splitContextBlock(text)?.context ?? null;
}
