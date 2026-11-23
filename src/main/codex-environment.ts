// Builds the explicit environment of the codex child process from an allowlist, so no provider secret is inherited.

/** Codex needs the home directory to find its login, a PATH to run tools and locale and proxy settings to reach the network. */
const ALLOWED_VARIABLES: ReadonlyArray<string> = ["CODEX_HOME", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LOGNAME", "NO_PROXY", "SHELL", "TMPDIR", "USER"];

export function buildCodexEnvironment(parent: Readonly<Record<string, string | undefined>>, loginShellPath: string): Readonly<Record<string, string>> {
  if (parent["HOME"] === undefined) throw new Error("HOME is not set; launch Margin from Finder or a normal shell");
  const environment: Record<string, string> = { PATH: loginShellPath };
  for (const name of ALLOWED_VARIABLES) {
    const value = parent[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}
