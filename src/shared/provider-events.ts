// Defines the provider-neutral events and identifiers that the reducer and the UI consume, whichever provider produced them.

export type ThreadId = string & { readonly brand: "ThreadId" };
export type TurnId = string & { readonly brand: "TurnId" };

/** Brands an id that came from a provider response; the provider is the only source of valid ids. */
export function asThreadId(value: string): ThreadId {
  return value as ThreadId; // the brand records that the string came from a provider response
}

export function asTurnId(value: string): TurnId {
  return value as TurnId; // the brand records that the string came from a provider response
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "refused";

export type ProviderEvent =
  | Readonly<{ type: "delta"; threadId: ThreadId; turnId: TurnId; text: string }>
  | Readonly<{ type: "completed"; threadId: ThreadId; turnId: TurnId; status: TurnStatus; error: string | null }>
  | Readonly<{ type: "accountChanged"; provider: "codex" | "claude" }>;
