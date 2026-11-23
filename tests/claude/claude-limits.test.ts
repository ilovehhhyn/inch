// Invariant: Claude is never sent an image over 5 MB or a request over 32 MB after base64, and the error names the file that does not fit.
import { expect, test } from "vitest";

import { base64Bytes, CLAUDE_LIMITS, requireWithinClaudeLimits } from "../../src/claude/claude-limits";
import type { Attachment } from "../../src/shared/attachment";

const MB = 1024 * 1024;

function file(kind: Attachment["kind"], name: string, bytes: number): Attachment {
  return { id: name, kind, name, storedPath: `/stored/${name}`, bytes, mediaType: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain" };
}

test("the_limits_are_five_megabytes_per_image_and_thirty_two_per_request", () => {
  expect(CLAUDE_LIMITS).toEqual({ imageBytes: 5 * MB, requestBytes: 32 * MB });
});

test("base64_grows_the_bytes_to_four_thirds_rounded_up_to_whole_groups", () => {
  expect([0, 1, 2, 3, 4, 3000].map(base64Bytes)).toEqual([0, 4, 4, 4, 8, 4000]);
});

test("an_image_is_accepted_when_its_base64_is_exactly_five_megabytes_and_refused_one_byte_over_naming_the_file", () => {
  const largestFile = 3 * ((5 * MB) / 4); // 3,932,160 bytes: base64 is exactly 5 MB

  expect(base64Bytes(largestFile)).toBe(5 * MB);
  expect(() => requireWithinClaudeLimits(0, [file("image", "ok.png", largestFile)])).not.toThrow();
  expect(() => requireWithinClaudeLimits(0, [file("image", "big.png", largestFile + 1)])).toThrow("cannot send image `big.png` to Claude; an image may be at most 5 MB after base64 (5,242,880 characters) and this one is 5,242,884 after base64 (3,932,161 bytes on disk); resize it or attach a smaller one");
});

test("an_image_that_is_under_five_megabytes_on_disk_but_over_it_after_base64_is_refused", () => {
  expect(() => requireWithinClaudeLimits(0, [file("image", "mid.png", 4 * MB)])).toThrow("cannot send image `mid.png` to Claude");
});

test("a_pdf_that_is_small_before_base64_but_too_big_after_it_is_refused", () => {
  const pdf = file("pdf", "paper.pdf", 25 * MB);

  expect(base64Bytes(pdf.bytes)).toBeGreaterThan(32 * MB);
  expect(() => requireWithinClaudeLimits(0, [pdf])).toThrow("cannot send `paper.pdf` to Claude; the request would be 33.3 MB after base64 and the limit is 32.0 MB; remove the file or attach a smaller one");
});

test("the_history_counts_toward_the_request_so_the_file_that_does_not_fit_is_named", () => {
  const history = 20 * MB;

  expect(() => requireWithinClaudeLimits(history, [file("pdf", "a.pdf", 6 * MB)])).not.toThrow();
  expect(() => requireWithinClaudeLimits(history, [file("pdf", "a.pdf", 6 * MB), file("pdf", "b.pdf", 6 * MB)])).toThrow("cannot send `b.pdf` to Claude; the request would be");
});

test("a_history_that_already_fills_the_request_says_to_start_a_new_chat", () => {
  expect(() => requireWithinClaudeLimits(32 * MB + 1, [])).toThrow("this chat already holds 32.0 MB, which is the whole 32.0 MB limit of one request; start a new chat");
});

test("the_request_exactly_at_the_limit_is_accepted", () => {
  const exactly = file("text", "t.txt", 3 * ((32 * MB) / 4)); // base64 of 24 MB of text is exactly 32 MB

  expect(() => requireWithinClaudeLimits(0, [exactly])).not.toThrow();
  expect(() => requireWithinClaudeLimits(1, [exactly])).toThrow("cannot send `t.txt` to Claude");
});
