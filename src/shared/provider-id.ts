// Names the two model providers and parses a provider id that crossed the IPC boundary.

export const PROVIDER_IDS = ["codex", "claude"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Parses an untrusted value into a ProviderId; an unknown one is an error that names the accepted ids. */
export function parseProviderId(value: unknown): ProviderId {
  const found = PROVIDER_IDS.find((id) => id === value);
  if (found === undefined) throw new Error(`unknown provider \`${String(value)}\`; expected ${PROVIDER_IDS.join(" or ")}`);
  return found;
}
