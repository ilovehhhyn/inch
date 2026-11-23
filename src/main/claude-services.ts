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
  clientOptions: ClaudeClientOptions;
}>;

export function createClaudeServices(options: ClaudeServicesOptions): ClaudeServices {
  let cached: ClaudeCredential | null = null;
  const credentials = async (): Promise<ClaudeCredential | null> => {
    cached = await readClaudeCredential(options.store, await options.ant(), options.clock, cached);
    return cached;
  };
  const modelIds = CLAUDE_MODELS.map((model) => model.id);
  const checkModels = options.checkModels ?? ((credential: ClaudeCredential) => requireModelsAvailable(createClaudeClient(credential, options.clientOptions), modelIds));
  const validate = options.validate ?? ((apiKey: string) => checkApiKey(apiKey, options.clientOptions, modelIds));
  return {
    credentials,
    readAccount: async () => claudeAccountOf(await credentials()),
    async signInConsole() {
      cached = null;
      await signInWithConsole(await options.ant());
      const credential = await credentials();
      if (credential === null) throw new Error("ant signed in but gave no token; run `ant auth login --profile margin` in a terminal and try again");
      await checkModels(credential);
    },
    async signInApiKey(apiKey) {
      cached = null;
      await signInWithApiKey(options.store, apiKey, validate, options.log);
    },
    async signOut() {
      cached = null;
      await signOut(options.store, await options.ant());
    },
    clientOptions: options.clientOptions,
  };
}
