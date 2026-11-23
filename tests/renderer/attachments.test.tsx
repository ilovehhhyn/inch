// @vitest-environment jsdom
// Invariant: attached files show as chips above the composer, travel with the send they were attached to, leave only after a successful send, and appear in the sent message and in a reopened chat.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { App } from "../../src/renderer/app";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";
import { FakeMarginApi } from "../fakes/fake-margin-api";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function file(name: string, content: string | Uint8Array, type = "text/plain"): File {
  return new File([content as BlobPart], name, { type }); // the content is a string or bytes; File accepts both
}

async function attach(...files: Array<File>): Promise<void> {
  await userEvent.upload(await screen.findByLabelText("Choose files"), files);
}

test("choosing_a_file_shows_a_chip_and_sends_the_bytes_to_the_main_process", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await attach(file("train.py", "lr = 0.1\n"));

  expect(await screen.findByText("train.py")).toBeInTheDocument();
  expect(api.attachmentAdds.map((added) => [added.name, new TextDecoder().decode(added.bytes)])).toEqual([["train.py", "lr = 0.1\n"]]);
});

test("dropping_files_on_the_composer_attaches_them", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  const composer = (await screen.findByLabelText("Message")).closest(".composer");
  if (composer === null) throw new Error("the composer is missing");

  fireEvent.drop(composer, { dataTransfer: { files: [file("a.py", "x = 1\n"), file("b.png", PNG, "image/png")] } });

  expect(await screen.findByText("a.py")).toBeInTheDocument();
  expect(await screen.findByText("b.png")).toBeInTheDocument();
});

test("pasting_an_image_attaches_it_and_pasting_plain_text_does_not", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  const box = await screen.findByLabelText("Message");

  fireEvent.paste(box, { clipboardData: { files: [file("image.png", PNG, "image/png")], getData: () => "" } });
  expect(await screen.findByText("image.png")).toBeInTheDocument();
  fireEvent.paste(box, { clipboardData: { files: [], getData: () => "just text" } });

  expect(api.attachmentAdds).toHaveLength(1);
});

test("removing_a_chip_discards_the_file", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await attach(file("train.py", "x = 1\n"));

  await userEvent.click(await screen.findByRole("button", { name: "Remove train.py" }));

  await waitFor(() => expect(screen.queryByText("train.py")).toBeNull());
  expect(api.attachmentDiscards).toEqual(["att-1"]);
});

test("a_rejected_file_shows_the_reason_and_no_chip", async () => {
  const api = new FakeMarginApi();
  api.attachmentRejections.set("archive.zip", "cannot attach `archive.zip`; Margin accepts images, PDFs and text files");
  render(<App api={api} />);

  await attach(file("archive.zip", "PK", "application/zip"));

  expect(await screen.findByRole("status")).toHaveTextContent("cannot attach `archive.zip`; Margin accepts images, PDFs and text files");
  expect(screen.queryByText("archive.zip")).toBeNull();
});

test("the_eleventh_file_is_refused_without_asking_the_main_process", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);

  await attach(...Array.from({ length: 10 }, (_, index) => file(`f${index}.txt`, "x\n")));
  await waitFor(() => expect(api.attachmentAdds).toHaveLength(10));
  await attach(file("extra.txt", "x\n"));

  expect(await screen.findByRole("status")).toHaveTextContent("cannot attach more than 10 files to one message; remove one first");
  expect(api.attachmentAdds).toHaveLength(10);
});

test("a_send_carries_the_attachment_ids_and_the_chips_move_into_the_sent_message", async () => {
  const api = new FakeMarginApi();
  render(<App api={api} />);
  await attach(file("train.py", "x = 1\n"), file("pixel.png", PNG, "image/png"));
  await screen.findByText("pixel.png");

  await userEvent.type(screen.getByLabelText("Message"), "does this look right?{Enter}");

  await waitFor(() => expect(api.turnAttachmentIds).toEqual([["att-1", "att-2"]]));
  const sent = (await screen.findByText("does this look right?")).closest(".u");
  if (!(sent instanceof HTMLElement)) throw new Error("the sent message is missing");
  expect(within(sent).getByText("train.py")).toBeInTheDocument();
  expect(within(sent).getByText("pixel.png")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove train.py" })).toBeNull();
});

test("a_failed_send_keeps_the_chips_and_a_retry_uses_the_same_files", async () => {
  const api = new FakeMarginApi();
  const original = api.turnStart;
  api.turnStart = async (...args) => {
    if (api.turnAttachmentIds.length === 0) {
      api.turnAttachmentIds.push(args[5]);
      throw new Error("Codex is busy");
    }
    return original(...args);
  };
  render(<App api={api} />);
  await attach(file("train.py", "x = 1\n"));
  await screen.findByText("train.py");

  await userEvent.type(screen.getByLabelText("Message"), "q{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Codex is busy");
  expect(screen.getByRole("button", { name: "Remove train.py" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => expect(api.turnAttachmentIds).toEqual([["att-1"], ["att-1"]]));
  expect(api.attachmentDiscards).toEqual([]);
});

test("a_message_without_attachments_sends_an_empty_list_and_a_chat_reopens_with_its_chips", async () => {
  const api = new FakeMarginApi();
  const thread = asThreadId("old-1");
  api.threads = [{ id: thread, provider: "codex", title: "Old chat", updatedAtSec: 1 }];
  api.histories.set(thread, [
    { turnId: asTurnId("t1"), role: "user", text: "what is in this?", status: "done", attachments: [{ kind: "pdf", name: "paper.pdf" }] },
    { turnId: asTurnId("t1"), role: "assistant", text: "A paper.", status: "done" },
  ]);
  render(<App api={api} />);

  await userEvent.click(await screen.findByRole("button", { name: "Old chat" }));
  const message = (await screen.findByText("what is in this?")).closest(".u");
  if (!(message instanceof HTMLElement)) throw new Error("the reopened message is missing");
  expect(within(message).getByText("paper.pdf")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Message"), "and now?{Enter}");

  await waitFor(() => expect(api.turnAttachmentIds).toEqual([[]]));
});
