// Keeps a Claude request inside the API's size limits, counted the way the API counts them: after base64, over the whole replayed chat.
import type { Attachment } from "../shared/attachment";

const MEGABYTE = 1024 * 1024;

/**
 * 32 MB per request (bundled Claude API reference, "Document & File Input"). 5 MB per image is the Anthropic vision limit,
 * applied here to the file's own bytes; it is not in the bundled reference and was not tried against the API.
 */
export const CLAUDE_LIMITS = { imageBytes: 5 * MEGABYTE, requestBytes: 32 * MEGABYTE } as const;

/** The length of `bytes` bytes written as base64: four characters for every started group of three bytes. */
export function base64Bytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function megabytes(bytes: number): string {
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

/**
 * `historyBytes` is the size of everything already in the request: the replayed messages, with every earlier attachment as
 * base64, and the system prompt. The new files are added one at a time, so the error names the first one that does not fit.
 * Text files are sent as text, so their base64 size over-counts them, which errs toward refusing.
 */
export function requireWithinClaudeLimits(historyBytes: number, attachments: ReadonlyArray<Attachment>): void {
  const limit = CLAUDE_LIMITS.requestBytes;
  if (historyBytes > limit) throw new Error(`this chat already holds ${megabytes(historyBytes)}, which is the whole ${megabytes(limit)} limit of one request; start a new chat`);
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.bytes > CLAUDE_LIMITS.imageBytes) {
      throw new Error(`cannot send image \`${attachment.name}\` to Claude; an image may be at most 5 MB (${CLAUDE_LIMITS.imageBytes.toLocaleString("en-US")} bytes) and this one is ${attachment.bytes.toLocaleString("en-US")} bytes; resize it or attach a smaller one`);
    }
  }
  let total = historyBytes;
  for (const attachment of attachments) {
    total += base64Bytes(attachment.bytes);
    if (total > limit) throw new Error(`cannot send \`${attachment.name}\` to Claude; the request would be ${megabytes(total)} after base64 and the limit is ${megabytes(limit)}; remove the file or attach a smaller one`);
  }
}
