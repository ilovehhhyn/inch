# Claude latency and sign-in spike

This note records what is known about Claude's delay and about passing an `ant` token to the SDK, and what is not known. Nothing in it was measured with a live request.

## Not measured

| Question | Status | Reason |
| --- | --- | --- |
| Time to the first text token at effort `low` and `medium`, with and without a 12,000-character context | Not measured | The controller ruled that no paid Anthropic request may be sent, because no dollar cap has been set. |
| Whether an `ant` token passed as `authToken` needs the `anthropic-beta: oauth-2025-04-20` header through the SDK | Not measured live | The `ant` CLI is not installed on this machine (`which ant` printed `ant not found`). |
| The version of `ant` that works | Not measured | Same reason. Margin pins no `ant` version. |
| Whether `claude-opus-5-5` at effort `low` answers `Reply with the single word OK.` correctly | Not measured | No request was sent. |
| `firstDeltaMs` of a real Claude Command-I question about `warmup.diff` (Task 19, step 5) | Not measured | No request was sent. The end-to-end test shows only that the context reaches a fake service. |

The first-token delay for Claude therefore has no number, and the comparison with the Codex numbers in `codex-app-server.md` cannot be made.

## Values the code uses in place of the measurements

| Name | Value | Basis | What it does not show |
| --- | --- | --- | --- |
| `CLAUDE_DEFAULT_EFFORT` | `"low"` | The plan's rule: choose the lower effort unless its answers are wrong on the probe. The probe has not run, so the rule's condition is untested. | That `low` answers well enough, or is faster. |
| `ANT_TOKEN_NEEDS_OAUTH_BETA` | `true` | The bundled Claude API reference says `/v1/messages` rejects an OAuth token without `anthropic-beta: oauth-2025-04-20`. In `@anthropic-ai/sdk` 1.12.0 (`client.js`) a plain `authToken` gets no such header from the SDK (only credential providers do), and a request that passes its own `betas` replaces the client's default `anthropic-beta` header. Margin therefore sets the header as a client default and adds the beta to every request's `betas` list (`betasFor`). A unit test with a captured request shows both reach the wire. | That the server accepts the request. Nobody has sent one. |

Both values are written as named constants so the measurement can replace them in one place.

## How to run the measurement later

The probe is `spikes/probe-claude.mjs`. It sends 40 requests: 10 for each of effort `low` and `medium`, each with no context and with a 12,000-character context.

1. Decide a dollar cap. The plan estimates under $1 in total; the probe bounds each request to 1,024 output tokens and assumes the worst case before each request.
2. Store the API key in the Keychain: `security add-generic-password -s margin-spike -a anthropic -w`.
3. Run `MARGIN_SPIKE_USD_CAP=<cap> node spikes/probe-claude.mjs > docs/spikes/raw-claude-latency.jsonl`.

The probe exits with an error and sends nothing when `MARGIN_SPIKE_USD_CAP` is missing, empty, not a number or not positive (`tests/spikes/probe-claude.test.ts`). It stops before any request that could take the total over the cap.

For the token question: install `ant`, run `ant auth login --profile margin-spike`, then send one request with `new Anthropic({ authToken })` using the output of `ant auth print-credentials --access-token --profile margin-spike`, once with and once without the header.
