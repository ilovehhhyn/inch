// Keeps Anthropic settings out of the environment: removes every ANTHROPIC_ variable and validates the one test-only address.

const PREFIX = "ANTHROPIC_";
const LOOPBACK_ADDRESS = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/** Deletes every `ANTHROPIC_` variable from `environment` and returns their names, sorted and without values. */
export function scrubAnthropicVariables(environment: Record<string, string | undefined>): Array<string> {
  const names = Object.keys(environment).filter((name) => name.startsWith(PREFIX)).sort();
  for (const name of names) Reflect.deleteProperty(environment, name);
  return names;
}

/**
 * The address of a fake Anthropic service for the end-to-end tests, read once at start-up from MARGIN_ANTHROPIC_BASE_URL.
 * Only a loopback address on a port is accepted, so the variable cannot send a key to another host.
 */
export function readClaudeBaseUrl(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = environment["MARGIN_ANTHROPIC_BASE_URL"];
  if (value === undefined) return undefined;
  if (!LOOPBACK_ADDRESS.test(value)) throw new Error(`MARGIN_ANTHROPIC_BASE_URL must be http://127.0.0.1:<port> or http://localhost:<port>, got \`${value}\`; it exists for tests, so unset it`);
  return value;
}
