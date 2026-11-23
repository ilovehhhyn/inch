// Gathers what the Claude provider and the sign-in screen share: the current credential, the account label and the sign-in flows.
import type { AntCli } from "../claude/ant-cli";
import { CLAUDE_MODELS } from "../claude/claude-provider";
import {
  checkApiKey,
  createClaudeClient,
  requireModelsAvailable,
  claudeAccountOf,
  readClaudeCredential,
  signInWithApiKey,
  signInWithConsole,
  signOut,
  type ClaudeClientOptions,
  type ClaudeCredential,
  type SecretStore,
} from "../claude/claude-credentials";
import type { ProviderAccount } from "../shared/chat-provider";
import type { Logger } from "../shared/log";

export type ClaudeServicesOptions = Readonly<{
  store: SecretStore;
  /** Resolves `ant` lazily, because finding it needs the login-shell PATH. */
  ant: () => Promise<AntCli>;
  clock: () => number;
  clientOptions: ClaudeClientOptions;
  log: Logger;
  /** Checks a typed key with Anthropic; the default retrieves each model Margin offers. */
  validate?: (apiKey: string) => Promise<void>;
  /** Checks that the signed-in account can use every model Margin offers; the default retrieves each one. */
  checkModels?: (credential: ClaudeCredential) => Promise<void>;
}>;

export type ClaudeServices = Readonly<{
  /** The credential to use now, null when signed out; an `ant` token is kept for ANT_TOKEN_REFRESH_MS. */
  credentials: () => Promise<ClaudeCredential | null>;
  readAccount: () => Promise<ProviderAccount>;
  signInConsole: () => Promise<void>;
  signInApiKey: (apiKey: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Anthropic rejected the credential (HTTP 401): the account reads as signed out and the cached token is dropped, until a new key or login succeeds. */
  markRejected: () => void;
  clientOptions: ClaudeClientOptions;
}>;

export function createClaudeServices(options: ClaudeServicesOptions): ClaudeServices {
  let cached: ClaudeCredential | null = null;
  /** True after a 401. A stored key is then not used (it was refused) until a new one is typed; an `ant` token is fetched fresh, and a token that arrives ends the rejection. */
  let isRejected = false;
  const credentials = async (): Promise<ClaudeCredential | null> => {
    if (isRejected && (await options.store.readApiKey("claude")) !== null) {
      cached = null;
      return null;
    }
    cached = await readClaudeCredential(options.store, options.ant, options.clock, cached);
    if (cached !== null) isRejected = false;
    return cached;
  };
  const modelIds = CLAUDE_MODELS.map((model) => model.id);
  const checkModels = options.checkModels ?? ((credential: ClaudeCredential) => requireModelsAvailable(createClaudeClient(credential, options.clientOptions), modelIds));
  const validate = options.validate ?? ((apiKey: string) => checkApiKey(apiKey, options.clientOptions, modelIds));
  return {
    credentials,
    readAccount: async () => claudeAccountOf(await credentials()),
    markRejected() {
      isRejected = true;
      cached = null;
    },
    async signInConsole() {
      cached = null;
      isRejected = false;
      await signInWithConsole(await options.ant());
      const credential = await credentials();
      if (credential === null) throw new Error("ant signed in but gave no token; run `ant auth login --profile margin` in a terminal and try again");
      await checkModels(credential);
    },
    async signInApiKey(apiKey) {
      cached = null;
      isRejected = false;
      await signInWithApiKey(options.store, apiKey, validate, options.log);
    },
    async signOut() {
      cached = null;
      isRejected = false;
      await signOut(options.store, await options.ant());
    },
    clientOptions: options.clientOptions,
  };
}
