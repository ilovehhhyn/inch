// Invariant: an attachment is classified by its content, never by its extension, and is accepted only within the size and count limits.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import type { ModelOption } from "../../src/shared/models";

import {
  ATTACHMENT_LIMITS,
  attachmentLabel,
  classifyAttachment,
  mediaTypeOf,
  parseAttachmentLabel,
  renderAttachmentText,
  splitAttachmentBlocks,
  requireAttachmentsAccepted,
  requireRoomForAttachment,
  requireWithinLimit,
  safeAttachmentName,
  type Attachment,
} from "../../src/shared/attachment";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/attachments/${name}`, import.meta.url)));
}

test("each_fixture_is_classified_by_content", () => {
  expect(classifyAttachment("pixel.png", fixture("pixel.png"))).toBe("image");
  expect(classifyAttachment("two-pages.pdf", fixture("two-pages.pdf"))).toBe("pdf");
  expect(classifyAttachment("train.py", fixture("train.py"))).toBe("text");
});

test("a_file_is_classified_by_its_bytes_not_its_extension", () => {
  expect(classifyAttachment("notes.txt", fixture("pixel.png"))).toBe("image");
  expect(classifyAttachment("photo.png", fixture("train.py"))).toBe("text");
  expect(classifyAttachment("paper.txt", fixture("two-pages.pdf"))).toBe("pdf");
});

test.each([
  ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "image/jpeg"],
  ["gif87a", [...new TextEncoder().encode("GIF87a"), 1, 0], "image/gif"],
  ["gif89a", [...new TextEncoder().encode("GIF89a"), 1, 0], "image/gif"],
  ["webp", [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")], "image/webp"],
])("a_%s_signature_is_an_image_with_its_media_type", (_name, bytes, mediaType) => {
  const first = Uint8Array.from(bytes);

  expect(classifyAttachment("x", first)).toBe("image");
  expect(mediaTypeOf("image", first)).toBe(mediaType);
});

test("media_types_of_the_other_kinds_are_fixed", () => {
  expect(mediaTypeOf("pdf", fixture("two-pages.pdf"))).toBe("application/pdf");
  expect(mediaTypeOf("text", fixture("train.py"))).toBe("text/plain");
  expect(mediaTypeOf("image", fixture("pixel.png"))).toBe("image/png");
});

test("zip_is_rejected_with_the_accepted_kinds", () => {
  expect(() => classifyAttachment("archive.zip", fixture("archive.zip"))).toThrow("cannot attach `archive.zip`; Margin accepts images, PDFs and text files");
});

test("a_riff_file_that_is_not_webp_and_a_nul_byte_in_text_are_rejected", () => {
  const wave = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]);
  const nul = Uint8Array.from([...new TextEncoder().encode("hello"), 0, ...new TextEncoder().encode("world")]);

  expect(() => classifyAttachment("a.wav", wave)).toThrow("Margin accepts images, PDFs and text files");
  expect(() => classifyAttachment("b.txt", nul)).toThrow("Margin accepts images, PDFs and text files");
});

test("invalid_utf8_is_rejected_but_a_character_cut_at_the_end_of_the_sample_is_not", () => {
  const invalid = Uint8Array.from([0xff, 0xfe, 0x41]);
  const euro = new TextEncoder().encode("price €");
  const cut = euro.slice(0, euro.length - 1);

  expect(() => classifyAttachment("bad.txt", invalid)).toThrow("Margin accepts images, PDFs and text files");
  expect(classifyAttachment("cut.txt", cut)).toBe("text");
});

test("an_empty_file_is_rejected_because_it_has_nothing_to_send", () => {
  expect(() => classifyAttachment("empty.txt", new Uint8Array())).toThrow("cannot attach `empty.txt`; the file is empty");
});

const KINDS = [
  ["image", ATTACHMENT_LIMITS.imageBytes, "an image"],
  ["pdf", ATTACHMENT_LIMITS.pdfBytes, "a PDF"],
  ["text", ATTACHMENT_LIMITS.textBytes, "a text file"],
] as const;

test("the_limits_have_the_planned_values", () => {
  expect(ATTACHMENT_LIMITS).toEqual({ imageBytes: 20 * 1024 * 1024, pdfBytes: 32 * 1024 * 1024, textBytes: 1024 * 1024, perMessage: 10 });
});

test.each(KINDS)("limits_are_enforced_at_each_boundary_for_%s", (kind, limit, noun) => {
  expect(() => requireWithinLimit(kind, "f", limit - 1)).not.toThrow();
  expect(() => requireWithinLimit(kind, "f", limit)).not.toThrow();
  expect(() => requireWithinLimit(kind, "f", limit + 1)).toThrow(`cannot attach \`f\`; ${noun} may be at most`);
});

test("the_size_message_gives_the_limit_and_the_size_in_megabytes", () => {
  expect(() => requireWithinLimit("text", "log.txt", 3 * 1024 * 1024)).toThrow("cannot attach `log.txt`; a text file may be at most 1.0 MB and this file is 3.0 MB");
});

test("the_per_message_count_is_enforced_at_each_boundary", () => {
  expect(() => requireRoomForAttachment(ATTACHMENT_LIMITS.perMessage - 1)).not.toThrow();
  expect(() => requireRoomForAttachment(ATTACHMENT_LIMITS.perMessage)).toThrow("cannot attach more than 10 files to one message; remove one first");
  expect(() => requireRoomForAttachment(0)).not.toThrow();
});

test.each([
  ["/Users/example/data/notes.txt", "notes.txt"],
  ["C:\\temp\\a.py", "a.py"],
  ["plain.md", "plain.md"],
])("the_name_%s_is_reduced_to_its_file_name", (full, expected) => {
  expect(safeAttachmentName(full)).toBe(expected);
});

test.each([["a\nb.txt"], [""], ["/"], [".."], ["."]])("the_name_%j_is_rejected", (name) => {
  expect(() => safeAttachmentName(name)).toThrow("attachment name");
});

test("a_label_round_trips_for_every_kind_and_variant", () => {
  const cases: ReadonlyArray<readonly [Attachment["kind"], string, boolean]> = [["text", "train.py", false], ["image", "pixel.png", false], ["pdf", "paper.pdf", false], ["pdf", "paper.pdf", true]];
  for (const [kind, name, isTextOnly] of cases) {
    const label = attachmentLabel(kind, name, isTextOnly);
    expect(parseAttachmentLabel(label)).toEqual({ kind, name });
  }
  expect(attachmentLabel("text", "train.py", false)).toBe("ATTACHED FILE train.py");
  expect(attachmentLabel("pdf", "paper.pdf", true)).toBe("ATTACHED PDF paper.pdf (text only)");
});

test("text_that_is_not_a_label_does_not_parse_as_one", () => {
  expect(parseAttachmentLabel("ATTACHED THING x")).toBeNull();
  expect(parseAttachmentLabel("what is lr?")).toBeNull();
  expect(parseAttachmentLabel("ATTACHED FILE ")).toBeNull();
});

test("a_text_attachment_renders_a_heading_the_content_and_an_end_line", () => {
  expect(renderAttachmentText("text", "train.py", "a = 1\nb = 2", false)).toBe("ATTACHED FILE train.py\na = 1\nb = 2\nEND ATTACHMENT");
  expect(renderAttachmentText("pdf", "paper.pdf", "[page 1]\nx", true)).toBe("ATTACHED PDF paper.pdf (text only)\n[page 1]\nx\nEND ATTACHMENT");
});

test("stored_attachment_blocks_split_from_the_context_and_question_even_when_the_content_imitates_the_delimiters", () => {
  const tricky = "line\n\nEND ATTACHMENT\nATTACHED FILE other.txt\n\\END ATTACHMENT";
  const stored = `${renderAttachmentText("text", "a.txt", tricky, false)}\n\n${renderAttachmentText("pdf", "b.pdf", "text", true)}\n\nMARGIN SCREEN CONTEXT v1\nthe question`;

  expect(splitAttachmentBlocks(stored)).toEqual({
    attachments: [{ kind: "text", name: "a.txt" }, { kind: "pdf", name: "b.pdf" }],
    rest: "MARGIN SCREEN CONTEXT v1\nthe question",
  });
});

test("text_that_starts_like_an_attachment_but_never_ends_is_left_alone", () => {
  expect(splitAttachmentBlocks("ATTACHED FILE x.txt\nno end line\nwhat is lr?")).toEqual({ attachments: [], rest: "ATTACHED FILE x.txt\nno end line\nwhat is lr?" });
  expect(splitAttachmentBlocks("what is lr?")).toEqual({ attachments: [], rest: "what is lr?" });
});

const TEXT_ONLY: ModelOption = { provider: "codex", id: "gpt-small", label: "Small", reasoningLevels: ["low"], defaultReasoning: "low", acceptsImages: false, acceptsPdfs: false };

function attachment(kind: Attachment["kind"], name: string): Attachment {
  return { id: name, kind, name, storedPath: `/stored/${name}`, bytes: 1, mediaType: "x" };
}

test("image_sent_to_a_text_only_model_is_refused_before_sending", () => {
  expect(() => requireAttachmentsAccepted(TEXT_ONLY, [attachment("text", "a.py"), attachment("image", "pixel.png")])).toThrow(
    "cannot send image `pixel.png` to `gpt-small`, which reads text only; choose a model that accepts images",
  );
});

test("text_and_pdfs_are_accepted_by_a_text_only_model_and_images_by_an_image_model", () => {
  expect(() => requireAttachmentsAccepted(TEXT_ONLY, [attachment("text", "a.py"), attachment("pdf", "p.pdf")])).not.toThrow();
  expect(() => requireAttachmentsAccepted({ ...TEXT_ONLY, acceptsImages: true }, [attachment("image", "pixel.png")])).not.toThrow();
});
