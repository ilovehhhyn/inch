// Invariant: every MCP server named in the user's Codex config gets an explicit `enabled: false`, or startup fails with the fix.
import { expect, test } from "vitest";

import { buildMcpDisableConfig } from "../../src/codex/mcp-overrides";

test("each_configured_server_is_disabled_by_name", () => {
  const config = { mcp_servers: { node_repl: { command: "x" }, rea: { command: "y" }, "computer-use": { command: "z" } } };

  expect(buildMcpDisableConfig(config)).toEqual({ node_repl: { enabled: false }, rea: { enabled: false }, "computer-use": { enabled: false } });
});

test("the_result_is_sorted_by_server_name", () => {
  expect(Object.keys(buildMcpDisableConfig({ mcp_servers: { zeta: {}, alpha: {}, mid: {} } }))).toEqual(["alpha", "mid", "zeta"]);
});

test("a_config_without_mcp_servers_disables_nothing", () => {
  expect(buildMcpDisableConfig({})).toEqual({});
  expect(buildMcpDisableConfig({ mcp_servers: null })).toEqual({});
});

test("a_server_name_that_cannot_be_written_as_a_bare_toml_key_is_an_error_naming_the_fix", () => {
  expect(() => buildMcpDisableConfig({ mcp_servers: { "my server": {} } })).toThrow(/mcp server name `my server` cannot be disabled; rename it in ~\/\.codex\/config\.toml to letters, digits, `_` or `-`, or remove it/);
});

test("an_mcp_servers_value_that_is_not_a_table_is_an_error", () => {
  expect(() => buildMcpDisableConfig({ mcp_servers: ["rea"] })).toThrow(/mcp_servers in the Codex config must be a table/);
});

test("a_config_that_is_not_an_object_is_an_error", () => {
  expect(() => buildMcpDisableConfig(null)).toThrow(/Codex config must be an object/);
});
