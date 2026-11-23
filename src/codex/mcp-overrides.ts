// Builds the per-thread config that turns off every MCP server in the user's Codex config, so no MCP tool can run commands.
import type { JsonValue } from "./rpc-types";

/** Characters a TOML bare key allows; a dotted override path cannot quote other names. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns `{ <name>: { enabled: false } }` for each key of `config.mcp_servers`, sorted by name.
 * A merge override cannot remove a server, so each one is disabled by name. Servers defined only by plugins are not
 * in this table; `features.plugins = false` and `features.apps = false` remove them.
 */
export function buildMcpDisableConfig(config: unknown): { [name: string]: JsonValue } {
  if (!isRecord(config)) throw new Error("Codex config must be an object; update Margin and Codex so their versions match");
  const servers = config["mcp_servers"];
  if (servers === undefined || servers === null) return {};
  if (!isRecord(servers)) throw new Error("mcp_servers in the Codex config must be a table; fix ~/.codex/config.toml");
  const disabled: { [name: string]: JsonValue } = {};
  for (const name of Object.keys(servers).sort()) {
    if (!BARE_KEY.test(name)) {
      throw new Error(`mcp server name \`${name}\` cannot be disabled; rename it in ~/.codex/config.toml to letters, digits, \`_\` or \`-\`, or remove it`);
    }
    disabled[name] = { enabled: false };
  }
  return disabled;
}
