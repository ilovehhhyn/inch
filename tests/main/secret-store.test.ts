// Invariant: an API key is written only in the form safeStorage returns, readable only through it, and never left half-written.
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createSafeStorageSecretStore, type SafeStorageLike } from "../../src/main/secret-store";

const KEY = "sk-ant-test-123";

/** Encrypts by reversing the bytes after a marker, so a test can tell stored text from plain text. */
function fakeSafeStorage(isAvailable = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => isAvailable,
    encryptString: (plain) => Buffer.from(`ENC:${[...plain].reverse().join("")}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("ENC:")) throw new Error("not encrypted by this store");
      return [...text.slice(4)].reverse().join("");
    },
  };
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "margin-secrets-"));
}

test("a_saved_key_is_read_back_and_the_file_never_holds_the_plain_key", async () => {
  const folder = await directory();
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(), directory: folder });

  await store.saveApiKey("claude", KEY);

  expect(await store.readApiKey("claude")).toBe(KEY);
  const files = await readdir(folder);
  expect(files).toEqual(["claude-api-key.bin"]);
  expect((await readFile(join(folder, "claude-api-key.bin"))).toString("utf8")).not.toContain(KEY);
  expect((await stat(join(folder, "claude-api-key.bin"))).mode & 0o777).toBe(0o600);
});

test("no_key_reads_as_null_and_delete_is_safe_to_repeat", async () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(), directory: await directory() });

  expect(await store.readApiKey("claude")).toBeNull();
  await store.saveApiKey("claude", KEY);
  await store.deleteApiKey("claude");
  await store.deleteApiKey("claude");

  expect(await store.readApiKey("claude")).toBeNull();
});

test("without_encryption_nothing_is_written_and_the_error_names_the_fix", async () => {
  const folder = await directory();
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(false), directory: folder });

  await expect(store.saveApiKey("claude", KEY)).rejects.toThrow("the system keychain is not available to Margin, so an API key cannot be stored safely; unlock the login keychain and restart Margin, or sign in with a Claude Console account instead");

  expect(await readdir(folder)).toEqual([]);
});

test("a_file_that_cannot_be_decrypted_is_an_error_naming_the_file_not_a_signed_out_state", async () => {
  const folder = await directory();
  await writeFile(join(folder, "claude-api-key.bin"), "plain text");
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(), directory: folder });

  await expect(store.readApiKey("claude")).rejects.toThrow(new RegExp(`${join(folder, "claude-api-key.bin")} cannot be decrypted.*delete the file`));
});

test("a_blank_key_is_rejected_and_the_old_key_is_kept", async () => {
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(), directory: await directory() });
  await store.saveApiKey("claude", KEY);

  await expect(store.saveApiKey("claude", "  ")).rejects.toThrow("API key must not be empty");

  expect(await store.readApiKey("claude")).toBe(KEY);
});

test("a_save_leaves_no_temporary_file_behind", async () => {
  const folder = await directory();
  const store = createSafeStorageSecretStore({ safeStorage: fakeSafeStorage(), directory: folder });

  await store.saveApiKey("claude", KEY);
  await store.saveApiKey("claude", `${KEY}-2`);

  expect(await readdir(folder)).toEqual(["claude-api-key.bin"]);
  expect(await store.readApiKey("claude")).toBe(`${KEY}-2`);
});
