// Describes a file attached to a message and decides, from its bytes and size alone, whether Margin accepts it.

export type AttachmentKind = "image" | "pdf" | "text";

/** `storedPath` is Margin's own copy, so a later edit to the original never changes a sent message. */
export type Attachment = Readonly<{ id: string; kind: AttachmentKind; name: string; storedPath: string; bytes: number; mediaType: string }>;

/** The name and kind a message shows as a chip; it never carries the file's content. */
export type AttachmentSummary = Readonly<{ name: string; kind: AttachmentKind }>;

/** The PDF limit is the Claude request limit (32 MB); the others keep a message well under it. */
export const ATTACHMENT_LIMITS = { imageBytes: 20 * 1024 * 1024, pdfBytes: 32 * 1024 * 1024, textBytes: 1 * 1024 * 1024, perMessage: 10 } as const;

/** How many leading bytes `classifyAttachment` needs: enough for every signature and for a text check. */
export const SNIFF_BYTES = 8 * 1024;

const MEGABYTE = 1024 * 1024;
const ACCEPTED = "Margin accepts images, PDFs and text files";
const ASCII = new TextEncoder();

function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF_87A = [...ASCII.encode("GIF87a")];
const GIF_89A = [...ASCII.encode("GIF89a")];
const RIFF = [...ASCII.encode("RIFF")];
const WEBP = [...ASCII.encode("WEBP")];
const PDF = [...ASCII.encode("%PDF-")];

/** The media type of an image signature, or null; WebP is `RIFF`, four size bytes, then `WEBP`. */
function imageMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF_87A) || startsWith(bytes, GIF_89A)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

/** Text is non-empty UTF-8 with no NUL byte; the sample may end inside a character, which `stream` allows. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Decides the kind from the file's leading bytes; the name only appears in the error. */
export function classifyAttachment(name: string, firstBytes: Uint8Array): AttachmentKind {
  if (firstBytes.length === 0) throw new Error(`cannot attach \`${name}\`; the file is empty`);
  if (imageMediaType(firstBytes) !== null) return "image";
  if (startsWith(firstBytes, PDF)) return "pdf";
  if (isText(firstBytes)) return "text";
  throw new Error(`cannot attach \`${name}\`; ${ACCEPTED}`);
}

export function mediaTypeOf(kind: AttachmentKind, firstBytes: Uint8Array): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "text") return "text/plain";
  const mediaType = imageMediaType(firstBytes);
  if (mediaType === null) throw new Error("the bytes are not an image; classify the attachment first");
  return mediaType;
}

const LIMIT_BYTES: Readonly<Record<AttachmentKind, number>> = { image: ATTACHMENT_LIMITS.imageBytes, pdf: ATTACHMENT_LIMITS.pdfBytes, text: ATTACHMENT_LIMITS.textBytes };
const KIND_NOUNS: Readonly<Record<AttachmentKind, string>> = { image: "an image", pdf: "a PDF", text: "a text file" };

function megabytes(bytes: number): string {
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

/** A file of exactly the limit is accepted; one byte more is not. */
export function requireWithinLimit(kind: AttachmentKind, name: string, bytes: number): void {
  const limit = LIMIT_BYTES[kind];
  if (bytes > limit) throw new Error(`cannot attach \`${name}\`; ${KIND_NOUNS[kind]} may be at most ${megabytes(limit)} and this file is ${megabytes(bytes)}`);
}

/** `count` is how many files the message already holds. */
export function requireRoomForAttachment(count: number): void {
  if (count >= ATTACHMENT_LIMITS.perMessage) throw new Error(`cannot attach more than ${ATTACHMENT_LIMITS.perMessage} files to one message; remove one first`);
}

/** The last path segment of `fullName`; a name that is empty, a dot segment or has a line break would break the label that carries it. */
export function safeAttachmentName(fullName: string): string {
  const name = fullName.split(/[\\/]/).at(-1) ?? "";
  if (name === "" || name === "." || name === ".." || /[\r\n]/.test(name)) throw new Error(`attachment name ${JSON.stringify(fullName)} must be a file name on one line; rename the file`);
  return name;
}

const LABEL_WORDS: Readonly<Record<AttachmentKind, string>> = { image: "IMAGE", pdf: "PDF", text: "FILE" };
const TEXT_ONLY_SUFFIX = " (text only)";
const LABEL_PATTERN = /^ATTACHED (FILE|PDF|IMAGE) (.+?)( \(text only\))?$/;

/** The first line that names an attachment in the text a model reads: `ATTACHED FILE train.py`; a PDF sent as text says so. */
export function attachmentLabel(kind: AttachmentKind, name: string, isTextOnly: boolean): string {
  return `ATTACHED ${LABEL_WORDS[kind]} ${name}${isTextOnly ? TEXT_ONLY_SUFFIX : ""}`;
}

/** Reads a label back from stored text, so a reopened chat shows its chips; null for any other line. */
export function parseAttachmentLabel(line: string): AttachmentSummary | null {
  const match = LABEL_PATTERN.exec(line);
  if (match === null) return null;
  const kind = (Object.keys(LABEL_WORDS) as Array<AttachmentKind>).find((candidate) => LABEL_WORDS[candidate] === match[1]);
  const name = match[2];
  return kind === undefined || name === undefined ? null : { kind, name };
}

/** Reads the stored copy of an attachment for a provider; the node-side implementation lives in main, so providers are tested with fakes. */
export interface AttachmentContent {
  /** The file as UTF-8 text; rejects when the file is not valid UTF-8. */
  readText(attachment: Attachment): Promise<string>;
  readBase64(attachment: Attachment): Promise<string>;
  /** The text layer of a PDF, each page under a `[page N]` line; rejects for a PDF with no text. */
  extractPdfText(attachment: Attachment): Promise<string>;
}
