// Reads and writes the saved window layout as one JSON file, replacing it atomically.
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { DEFAULT_LAYOUT, parseLayout, type Layout } from "../shared/layout";

export type LayoutIo = Readonly<{
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}>;

const NODE_IO: LayoutIo = { readFile, writeFile, rename, remove: (path) => rm(path, { force: true }) };

/** Makes each write's temporary file name unique, so overlapping writes never share one. */
let temporaryCounter = 0;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Returns the saved layout, the default layout when the file does not exist, and throws for a file that is unreadable or invalid. */
export async function readLayout(path: string, io: LayoutIo = NODE_IO): Promise<Layout> {
  let text: string;
  try {
    text = await io.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return DEFAULT_LAYOUT;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`layout ${path} is not valid JSON; delete the file to reset the layout`);
  }
  return parseLayout(value, path);
}

/** Validates `layout`, writes it to a temporary file in the same folder, then renames it over `path`, so a crash leaves the old file whole. */
export async function writeLayout(path: string, layout: Layout, io: LayoutIo = NODE_IO): Promise<void> {
  const checked = parseLayout(layout, path);
  const temporary = `${path}.${process.pid}.${temporaryCounter++}.tmp`;
  try {
    await io.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`);
    await io.rename(temporary, path);
  } catch (error) {
    try {
      await io.remove(temporary);
    } catch (cleanupError) {
      const cause = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${cause}; also could not remove ${temporary}: ${cleanup}`);
    }
    throw error;
  }
}
