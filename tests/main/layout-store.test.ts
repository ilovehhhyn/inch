// Invariant: the saved layout is replaced atomically, read back exactly, and never accepted with unknown keys or another version.
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { readLayout, writeLayout, type LayoutIo } from "../../src/main/layout-store";
import { DEFAULT_LAYOUT, MAX_PANEL_WIDTH_PX, MIN_PANEL_WIDTH_PX, type Layout } from "../../src/shared/layout";
import { asThreadId, asTurnId } from "../../src/shared/provider-events";

const SAVED: Layout = {
  version: 2,
  diffFolder: "/Users/example/code/repo",
  sideChats: [{ provider: "claude", threadId: asThreadId("thread-2"), forkedFromTurn: asTurnId("turn-4") }],
  panelWidthPx: 640,
};

async function layoutPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "margin-layout-")), "layout.json");
}

test("write_then_read_returns_the_same_layout", async () => {
  const path = await layoutPath();

  await writeLayout(path, SAVED);

  expect(await readLayout(path)).toEqual(SAVED);
});

test("missing_file_gives_the_default_layout", async () => {
  expect(await readLayout(await layoutPath())).toEqual(DEFAULT_LAYOUT);
});

test("write_is_atomic", async () => {
  const path = await layoutPath();
  await writeLayout(path, SAVED);
  const crashingIo: LayoutIo = {
    writeFile,
    rename: async () => {
      throw new Error("power cut between write and rename");
    },
    readFile,
    remove: async () => undefined,
  };

  await expect(writeLayout(path, { ...SAVED, panelWidthPx: 900 }, crashingIo)).rejects.toThrow(/power cut/);

  expect(await readLayout(path)).toEqual(SAVED);
});

test("a_failed_write_never_hides_its_cause_even_when_cleanup_also_fails", async () => {
  const path = await layoutPath();
  const io: LayoutIo = {
    writeFile,
    rename: async () => {
      throw new Error("rename failed");
    },
    readFile,
    remove: async () => {
      throw new Error("remove failed");
    },
  };

  await expect(writeLayout(path, SAVED, io)).rejects.toThrow(/rename failed.*remove failed/s);
});

test("write_uses_a_temporary_file_in_the_same_folder_then_renames_it", async () => {
  const path = await layoutPath();
  const renames: Array<[string, string]> = [];
  const io: LayoutIo = {
    writeFile,
    rename: async (from, to) => {
      renames.push([from, to]);
      await rename(from, to);
    },
    readFile,
    remove: async () => undefined,
  };

  await writeLayout(path, SAVED, io);

  expect(renames).toHaveLength(1);
  expect(renames[0]?.[1]).toBe(path);
  expect(join(renames[0]?.[0] ?? "", "..")).toBe(join(path, ".."));
  expect(renames[0]?.[0]).not.toBe(path);
});

test("unknown_keys_are_rejected_with_the_file_name", async () => {
  const path = await layoutPath();
  await writeFile(path, JSON.stringify({ ...SAVED, theme: "dark" }));

  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path}.*unknown key \`theme\``));
});

test("another_version_is_rejected_with_the_fix", async () => {
  const path = await layoutPath();
  await writeFile(path, JSON.stringify({ ...SAVED, version: 3 }));

  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path}.*version 3.*delete the file`));
});

test("a_version_1_layout_is_read_with_its_side_chats_as_codex_chats", async () => {
  const path = await layoutPath();
  await writeFile(path, JSON.stringify({ version: 1, diffFolder: "/Users/example/code/repo", sideChats: [{ threadId: "side-1", forkedFromTurn: "turn-1" }], panelWidthPx: 640 }));

  expect(await readLayout(path)).toEqual({ version: 2, diffFolder: "/Users/example/code/repo", sideChats: [{ provider: "codex", threadId: "side-1", forkedFromTurn: "turn-1" }], panelWidthPx: 640 });
});

test("a_version_1_side_chat_that_names_a_provider_is_rejected", async () => {
  const path = await layoutPath();
  await writeFile(path, JSON.stringify({ version: 1, diffFolder: null, sideChats: [{ provider: "claude", threadId: "side-1", forkedFromTurn: "turn-1" }], panelWidthPx: 640 }));

  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path}.*unknown key \`provider\``));
});

test("a_version_2_side_chat_without_a_provider_or_with_an_unknown_one_is_rejected", async () => {
  const path = await layoutPath();
  await writeFile(path, JSON.stringify({ ...SAVED, sideChats: [{ threadId: "t", forkedFromTurn: "u" }] }));
  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path}.*provider`));

  await writeFile(path, JSON.stringify({ ...SAVED, sideChats: [{ provider: "gemini", threadId: "t", forkedFromTurn: "u" }] }));
  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path}.*unknown provider \`gemini\`; expected codex or claude`));
});

test("text_that_is_not_json_is_rejected_with_the_file_name", async () => {
  const path = await layoutPath();
  await writeFile(path, "{not json");

  await expect(readLayout(path)).rejects.toThrow(new RegExp(`${path} is not valid JSON`));
});

test("wrong_field_types_and_out_of_range_widths_are_rejected_on_read_and_on_write", async () => {
  const path = await layoutPath();
  const bad: Array<unknown> = [
    { ...SAVED, diffFolder: 5 },
    { ...SAVED, diffFolder: "relative/path" },
    { ...SAVED, sideChats: [{ provider: "codex", threadId: "t", forkedFromTurn: "u", extra: 1 }] },
    { ...SAVED, sideChats: [{ provider: "codex", threadId: "", forkedFromTurn: "u" }] },
    { ...SAVED, sideChats: "none" },
    { ...SAVED, panelWidthPx: MIN_PANEL_WIDTH_PX - 1 },
    { ...SAVED, panelWidthPx: MAX_PANEL_WIDTH_PX + 1 },
    { ...SAVED, panelWidthPx: 600.5 },
    [],
    null,
  ];

  for (const value of bad) {
    await writeFile(path, JSON.stringify(value));
    await expect(readLayout(path), JSON.stringify(value)).rejects.toThrow(path);
    await expect(writeLayout(path, value as Layout), JSON.stringify(value)).rejects.toThrow(path); // the cast passes an invalid value to prove the writer rejects it
  }
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(null)); // the last rejected write left the file alone
});

test("overlapping_writes_use_different_temporary_files_and_both_finish", async () => {
  const path = await layoutPath();
  const temporaries: Array<string> = [];
  const io: LayoutIo = {
    writeFile: async (target, data) => {
      temporaries.push(target);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writeFile(target, data);
    },
    rename,
    readFile,
    remove: async () => undefined,
  };

  await Promise.all([writeLayout(path, { ...SAVED, panelWidthPx: 500 }, io), writeLayout(path, { ...SAVED, panelWidthPx: 700 }, io)]);

  expect(new Set(temporaries).size).toBe(2);
  expect([500, 700]).toContain((await readLayout(path)).panelWidthPx);
});
