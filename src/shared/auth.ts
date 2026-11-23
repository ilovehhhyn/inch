// Describes sign-in state and events in the form the renderer may see: never a key, a token or an email.

export type AccountType = "chatgpt" | "apiKey";

export type AccountSummary = Readonly<{ signedIn: false }> | Readonly<{ signedIn: true; accountType: AccountType; planType: string | null }>;

export type LoginKind = "chatgpt" | "chatgptDeviceCode";

/** What the window needs after a login starts: nothing for a browser login, the code and address for a device-code login. */
export type LoginStarted =
  | Readonly<{ kind: "chatgpt"; loginId: string }>
  | Readonly<{ kind: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string }>;

export type AuthEvent =
  | Readonly<{ type: "account"; summary: AccountSummary }>
  | Readonly<{ type: "loginCompleted"; success: boolean; error: string | null }>;

const LOGIN_KINDS: ReadonlyArray<LoginKind> = ["chatgpt", "chatgptDeviceCode"];

/** Parses an untrusted IPC value into a LoginKind. */
export function parseLoginKind(value: unknown): LoginKind {
  const kind = LOGIN_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) throw new Error(`login kind must be \`chatgpt\` or \`chatgptDeviceCode\`, got ${JSON.stringify(value)}`);
  return kind;
}
