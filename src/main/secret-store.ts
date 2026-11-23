// Stores API keys encrypted with Electron safeStorage, one file per provider, replaced atomically and readable by the user only.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SecretStore } from "../claude/claude-credentials";
import type { ProviderId } from "../shared/provider-id";

/** The part of Electron's `safeStorage` the store uses. */
export type SafeStorageLike = Readonly<{
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}>;

export type SecretStoreOptions = Readonly<{ safeStorage: SafeStorageLike; directory: string }>;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createSafeStorageSecretStore(options: SecretStoreOptions): SecretStore {
  const fileOf = (provider: ProviderId): string => join(options.directory, `${provider}-api-key.bin`);
  let writes = 0;
  return {
    async saveApiKey(provider, key) {
      if (key.trim() === "") throw new Error("API key must not be empty");
      if (!options.safeStorage.isEncryptionAvailable()) {
        throw new Error("the system keychain is not available to Margin, so an API key cannot be stored safely; unlock the login keychain and restart Margin, or sign in with a Claude Console account instead");
      }
      const encrypted = options.safeStorage.encryptString(key);
      await mkdir(options.directory, { recursive: true, mode: DIRECTORY_MODE });
      const temporary = `${fileOf(provider)}.${process.pid}-${writes++}.tmp`;
      try {
        await writeFile(temporary, encrypted, { mode: FILE_MODE });
        await rename(temporary, fileOf(provider));
      } catch (error) {
        await unlink(temporary).catch(() => undefined); // the failure being thrown is the one to report; a missing temporary file needs no cleanup
        throw error;
      }
    },
    async readApiKey(provider) {
      const path = fileOf(provider);
      let encrypted: Buffer;
      try {
        encrypted = await readFile(path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      try {
        return options.safeStorage.decryptString(encrypted);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} cannot be decrypted (${cause}); delete the file and sign in again`);
      }
    },
    async deleteApiKey(provider) {
      await unlink(fileOf(provider)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    },
  };
}
