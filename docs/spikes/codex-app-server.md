# Codex app-server spike

This note records what was measured against `codex-cli 0.146.0` on one Mac (Apple silicon, ChatGPT Plus account) on 2026-11-23. It answers the two open questions in the plan: how long a turn takes to start streaming, and whether the shell tool can be switched off. The probe is `spikes/probe-turn.mjs`. Raw samples are in `docs/spikes/raw-latency.jsonl`.

## Summary

- Sending a 12,000-character context item before the question raised the median time to the first answer text from 1,587 ms to 2,615 ms, a difference of 1,028 ms. The plan's gate (more than 1 s) is exceeded by 28 ms. The sample is small and noisy, so this does not show that context costs a full second.
- The shell tool is removed by the thread config `{ "features": { "shell_tool": false } }`. Decision: `SHELL_TOOL_DISABLE = { features: { shell_tool: false, apps: false, plugins: false } }`.
- Two text inputs in one turn are stored as one text item with the strings joined and no separator. The context item must end with its own blank line.
- MCP servers from the user's own Codex configuration stay active in a Margin thread, and the model used one to run `ls` with the shell tool off. This is not solved. See "Open problems".

## Method

- The probe starts `codex app-server`, sends `initialize` and `initialized`, and starts two ephemeral threads (`ephemeral: true`, as `spikes/probe-turn.mjs` sets it in `latency` mode) with `sandbox: "read-only"`, `approvalPolicy: "never"` and a fresh empty working directory.
- Each thread gets 10 turns of the prompt `Reply with the single word OK.` Turns alternate between the two threads, so a change in server load affects both. The first thread sends only the prompt. The second thread sends a 12,000-character context text item before the prompt on every turn, so its history grows as it would in use.
- Margin's own threads are not ephemeral, because an ephemeral thread cannot be resumed after a crash. The rollout writes of a non-ephemeral thread are therefore not in these latency numbers; they were not measured.
- The probe waits 4 s between turns, because back-to-back turns returned HTTP 429 after about five turns.
- The model is `gpt-5.6-sol`, the default in `model/list`. The user's `~/.codex/config.toml` names `gpt-6-astra`, which is not in `model/list`. Turns on that model returned 429 every time, so every thread must pass `model` explicitly.
- Times are milliseconds from the moment `turn/start` was sent.

## Results

Of 20 turns, 13 completed and 7 failed with `exceeded retry limit, last status: 429 Too Many Requests`. The failures are in the raw file with `status: "failed"`. They are spread over both conditions (3 without context, 4 with context). Only completed turns are summarised.

| Condition | Completed turns | Median to `turn/started` | Median to first delta | 90th percentile to first delta | Median to `turn/completed` |
| --- | --- | --- | --- | --- | --- |
| No context | 7 of 10 | 11 ms | 1,587 ms | 3,356 ms | 1,724 ms |
| 12,000-character context | 6 of 10 | 11 ms | 2,615 ms | 6,404 ms | 2,759 ms |

- Dropping the first turn of each thread (which includes starting the MCP servers) gives medians of 1,734 ms without context (6 turns) and 2,626 ms with context (5 turns), a difference of 892 ms.
- The 90th percentile of 6 or 7 samples is the largest value, so treat it as a maximum.

What the numbers show: for this account, at this time, a short answer starts to stream about 1.6 s after the send without context and about 2.6 s with it, and the gap is near the 1 s gate.

What they do not show: that the gap is caused by the context size. The 429 retries inside Codex add seconds to some turns, the sample is 13 turns, and one run on one machine cannot separate server load from input size. A fair test needs more turns spread over a longer time, and a second machine.

## Shell tool

All runs used one turn with the prompt "Run the shell command `ls` in your working directory and tell me the output." and checked for an `item/started` item of type `commandExecution`.

| `thread/start` parameter | `commandExecution` item | Result |
| --- | --- | --- |
| none | yes | Shell ran. |
| `config: { features: { shell_tool: false } }` | no | Model said no shell tool is available. |
| `config: { "features.shell_tool": false }` | no | Same. Dotted keys also work. |
| `environments: []` | no | Model said no shell tool, but see the MCP row. |
| `config: { features: { shell_tool: false, apps: false, plugins: false } }` | no | `codex_apps` and `cua_repl` no longer start. |

- With the shell off, `apply_patch` is still offered. A write request was rejected by the read-only sandbox and produced no `fileChange` item.
- With only `shell_tool` off, the model still ran `ls` through an `mcpToolCall` to a server named `node_repl`. These servers come from the user's `~/.codex/config.toml` and installed plugins, so their names differ per user.
- Setting `config: { mcp_servers: { node_repl: { enabled: false }, rea: { enabled: false } } }` stopped them on this machine. Naming a server that is defined only by a plugin (`cua_repl`) fails `thread/start` with `invalid transport`.

## Two text inputs

A turn with `input: [{ text: "CONTEXT-ITEM first" }, { text: "QUESTION-ITEM second. Reply OK." }]` was stored by `thread/read` with `includeTurns: true` as one `userMessage` with one content item: `CONTEXT-ITEM firstQUESTION-ITEM second. Reply OK.` Order is kept. The items are joined with no separator. Margin therefore ends the context item with `"\n\n"`.

## Other findings

- `thread/resume` of a thread that never ran a turn fails with `no rollout found for thread id`. `thread/list` also omits such a thread. Only threads that have run a turn can be resumed after a crash.
- Threads are written to `~/.codex/sessions`, so Margin threads appear in the user's Codex history. Margin sets `serviceName: "margin"` and filters `thread/list` by its own empty working directory.
- Server ready about 1.5 s after spawn, and the first turn on a new thread waits for MCP servers to start (about 1 s in the first probe turn).

## Open problems

- Per-user MCP servers can run commands. A fix needs a list of the servers a user has (for example from `config/read` at start-up) and a per-thread `enabled: false` entry for each, or a dedicated `CODEX_HOME` with a copy of the login.
- Latency has to be measured again with more turns before the context design is judged on speed.

## Check of the built app with real Codex (2026-11-23, after the provider refactor)

The built app was started against the real `codex-cli 0.146.0` (no scripted stand-in) and sent three real model turns, which is all the controller allowed. The turns were: Command-I on a code diff, a plain message in a side chat forked from that answer, and Command-I on the diff again.

| Check | Result |
| --- | --- |
| Command-I on the diff pane (`warmup.diff`, 14 blocks, 861 characters) | The answer named `train.py` lines 36 to 41 and said line 39 was wrong. |
| Side chat forked through the first answer, plain message | The side chat answered in its own pane (`//` is floor division). The fork, the thread open and the turn all went through the provider interface. |
| Command-I on the diff a second time, asking for the line number | The answer was `train.py line 39`. |

Latency of the two Command-I sends, from `metrics.jsonl` (time from the key press):

| Send | `captureMs` | `turnStartAckMs` | `firstDeltaMs` |
| --- | --- | --- | --- |
| First, on a new thread | 0.6 | 217.7 | 3,275.5 |
| Second | 0.3 | 9.5 | 1,547.6 |

The planned measure was the median of 10 sends; only 2 were allowed, so no median is claimed. The context here was 861 characters, not the 12,000 of Task 0's gate, so these numbers do not test that gate. They agree in size with Task 0's medians (1,587 ms without context, 2,615 ms with 12,000 characters), and the first send includes the cold start of a new thread.
