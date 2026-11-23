// Invariant: an attached file is copied into Margin's own folder only after its content and size are accepted, a send takes ownership of exactly the files named, and a rejected file leaves nothing behind.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { clearStagedAttachments, createAttachmentContent, createAttachmentStore, PDF_TEXT_LIMIT_CHARS } from "../../src/main/attachments";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachment";
import { asThreadId } from "../../src/shared/provider-events";

const CHAT = asThreadId("chat-1");

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../fixtures/attachments/${name}`, import.meta.url)));
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "margin-attachments-"));
  let counter = 0;
  return { directory, store: createAttachmentStore({ directory, createId: () => `id-${++counter}` }) };
}

async function filesUnder(directory: string): Promise<Array<string>> {
  const found: Array<string> = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else found.push(join(path, entry.name).slice(directory.length + 1));
    }
  }
  await walk(directory);
  return found.sort();
}

test("add_copies_the_file_under_its_own_name_and_describes_it", async () => {
  const { directory, store } = await setup();
  const bytes = await fixture("train.py");

  const attachment = await store.add({ name: "/Users/example/code/train.py", bytes });

  expect(attachment).toEqual({ id: "id-1", kind: "text", name: "train.py", storedPath: join(directory, "pending", "id-1", "train.py"), bytes: bytes.length, mediaType: "text/plain" });
  expect(new Uint8Array(await readFile(attachment.storedPath))).toEqual(bytes);
});

test("a_rejected_file_writes_nothing", async () => {
  const { directory, store } = await setup();

  await expect(store.add({ name: "archive.zip", bytes: await fixture("archive.zip") })).rejects.toThrow("cannot attach `archive.zip`; Margin accepts images, PDFs and text files");
  await expect(store.add({ name: "big.txt", bytes: new Uint8Array(ATTACHMENT_LIMITS.textBytes + 1).fill(97) })).rejects.toThrow("a text file may be at most 1.0 MB");

  expect(await filesUnder(directory)).toEqual([]);
});

test("a_file_of_exactly_the_text_limit_is_accepted", async () => {
  const { store } = await setup();

  const attachment = await store.add({ name: "edge.txt", bytes: new Uint8Array(ATTACHMENT_LIMITS.textBytes).fill(97) });

  expect(attachment.bytes).toBe(ATTACHMENT_LIMITS.textBytes);
});

test("adopt_moves_the_files_into_the_chat_folder_and_a_retry_returns_the_same_files", async () => {
  const { directory, store } = await setup();
  const first = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });
  const second = await store.add({ name: "train.py", bytes: await fixture("train.py") });

  const adopted = await store.adopt(CHAT, [first.id, second.id]);
  const again = await store.adopt(CHAT, [first.id, second.id]);

  expect(adopted.map((attachment) => attachment.storedPath)).toEqual([join(directory, "chat-1", "id-1", "pixel.png"), join(directory, "chat-1", "id-2", "train.py")]);
  expect(again).toEqual(adopted);
  expect(await filesUnder(directory)).toEqual(["chat-1/id-1/pixel.png", "chat-1/id-2/train.py"]);
});

test("adopt_with_one_unknown_id_moves_nothing", async () => {
  const { directory, store } = await setup();
  const known = await store.add({ name: "train.py", bytes: await fixture("train.py") });

  await expect(store.adopt(CHAT, [known.id, "missing"])).rejects.toThrow("attachment `missing` is not attached; attach the file again");

  expect(await filesUnder(directory)).toEqual(["pending/id-1/train.py"]);
});

test("an_attachment_of_a_sent_message_cannot_be_adopted_by_another_chat", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "train.py", bytes: await fixture("train.py") });
  await store.adopt(CHAT, [added.id]);
  store.commit([added.id]);

  await expect(store.adopt(asThreadId("chat-2"), [added.id])).rejects.toThrow("attachment `id-1` belongs to a message that was sent; attach the file again");
});

test("more_than_ten_attachments_are_refused_before_any_move", async () => {
  const { directory, store } = await setup();
  const ids: Array<string> = [];
  for (let index = 0; index <= ATTACHMENT_LIMITS.perMessage; index++) ids.push((await store.add({ name: `f${index}.txt`, bytes: await fixture("train.py") })).id);

  await expect(store.adopt(CHAT, ids)).rejects.toThrow("cannot attach more than 10 files to one message");

  expect((await filesUnder(directory)).every((path) => path.startsWith("pending/"))).toBe(true);
});

test("the_same_id_twice_is_refused", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "train.py", bytes: await fixture("train.py") });

  await expect(store.adopt(CHAT, [added.id, added.id])).rejects.toThrow("attachment `id-1` is listed twice");
});

test("a_chat_id_that_could_leave_the_folder_is_refused", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "train.py", bytes: await fixture("train.py") });

  await expect(store.adopt(asThreadId("../outside"), [added.id])).rejects.toThrow("chat id `../outside` must be letters, digits, dashes or underscores");
});

test("discard_removes_the_staged_file_and_the_id_is_then_unknown", async () => {
  const { directory, store } = await setup();
  const added = await store.add({ name: "train.py", bytes: await fixture("train.py") });

  await store.discard(added.id);

  expect(await filesUnder(directory)).toEqual([]);
  await expect(store.adopt(CHAT, [added.id])).rejects.toThrow("is not attached");
  await expect(store.discard(added.id)).rejects.toThrow("attachment `id-1` is not attached");
});

test("clearing_staged_files_at_start_up_removes_only_the_pending_folder", async () => {
  const { directory, store } = await setup();
  const kept = await store.add({ name: "kept.py", bytes: await fixture("train.py") });
  await store.adopt(CHAT, [kept.id]);
  await store.add({ name: "stale.py", bytes: await fixture("train.py") });

  await clearStagedAttachments(directory);

  expect(await filesUnder(directory)).toEqual(["chat-1/id-1/kept.py"]);
});

test("clearing_when_nothing_was_staged_is_not_an_error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "margin-attachments-"));

  await expect(clearStagedAttachments(join(directory, "never-created"))).resolves.toBeUndefined();
});

test("the_content_reader_returns_text_base64_and_pdf_text", async () => {
  const { store } = await setup();
  const content = createAttachmentContent();
  const text = await store.add({ name: "train.py", bytes: await fixture("train.py") });
  const image = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });
  const pdf = await store.add({ name: "two-pages.pdf", bytes: await fixture("two-pages.pdf") });

  expect(await content.readText(text)).toBe("def get_lr(step, peak, warmup_steps):\n    return peak * (step // warmup_steps)\n");
  expect(await content.readBase64(image)).toBe(Buffer.from(await fixture("pixel.png")).toString("base64"));
  expect(await content.extractPdfText(pdf)).toBe("[page 1]\nPage one warmup schedule\n\n[page 2]\nPage two cosine decay");
});

test("a_text_file_that_is_not_utf8_beyond_the_sampled_bytes_is_an_error_naming_the_file", async () => {
  const { store } = await setup();
  const bytes = new Uint8Array(ATTACHMENT_LIMITS.textBytes / 2).fill(97);
  const added = await store.add({ name: "late.txt", bytes });
  await writeFile(added.storedPath, Uint8Array.from([...bytes.slice(0, 10_000), 0xff, 0xfe]));

  await expect(createAttachmentContent().readText(added)).rejects.toThrow("cannot read `late.txt` as UTF-8 text");
});

function pdfWith(content: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("a_pdf_without_a_text_layer_is_an_error_that_says_so", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "scan.pdf", bytes: pdfWith("") });

  await expect(createAttachmentContent().extractPdfText(added)).rejects.toThrow("cannot read `scan.pdf` as text; the PDF has no text layer (it may be scanned)");
});

test("a_pdf_with_more_text_than_the_limit_is_an_error_naming_the_limit", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "long.pdf", bytes: pdfWith("BT /F1 8 Tf 10 700 Td (word) Tj ET") });

  await expect(createAttachmentContent({ pdfTextLimitChars: 3 }).extractPdfText(added)).rejects.toThrow("cannot read `long.pdf` as text; it has more than 3 characters of text");
  expect(PDF_TEXT_LIMIT_CHARS).toBe(400_000);
});

test("a_bytes_that_pdfjs_cannot_parse_is_an_error_naming_the_file", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "broken.pdf", bytes: new TextEncoder().encode("%PDF-1.4\nnot really a pdf") });

  await expect(createAttachmentContent().extractPdfText(added)).rejects.toThrow("cannot read `broken.pdf` as text");
});

test("a_file_adopted_by_a_send_that_failed_can_still_be_discarded", async () => {
  const { directory, store } = await setup();
  const added = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });
  await store.adopt(CHAT, [added.id]);

  await store.discard(added.id);

  expect(await filesUnder(directory)).toEqual([]);
  await expect(store.adopt(CHAT, [added.id])).rejects.toThrow("is not attached");
});

test("a_file_adopted_by_a_send_that_failed_moves_with_the_next_send_in_another_chat", async () => {
  const { directory, store } = await setup();
  const added = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });
  await store.adopt(CHAT, [added.id]);

  const moved = await store.adopt(asThreadId("chat-2"), [added.id]);

  expect(moved.map((attachment) => attachment.storedPath)).toEqual([join(directory, "chat-2", "id-1", "pixel.png")]);
  expect(await filesUnder(directory)).toEqual(["chat-2/id-1/pixel.png"]);
});

test("a_file_of_a_sent_message_cannot_be_discarded_and_stays_on_disk", async () => {
  const { directory, store } = await setup();
  const added = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });
  await store.adopt(CHAT, [added.id]);
  store.commit([added.id]);

  await expect(store.discard(added.id)).rejects.toThrow("attachment `id-1` belongs to a message that was sent; it cannot be removed");

  expect(await filesUnder(directory)).toEqual(["chat-1/id-1/pixel.png"]);
});

test("committing_an_id_that_was_never_adopted_is_an_error", async () => {
  const { store } = await setup();
  const added = await store.add({ name: "pixel.png", bytes: await fixture("pixel.png") });

  expect(() => store.commit([added.id])).toThrow("attachment `id-1` was not adopted by a send");
});
