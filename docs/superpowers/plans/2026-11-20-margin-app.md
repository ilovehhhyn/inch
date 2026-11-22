# Margin desktop app implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Margin, an open-source macOS desktop chat app in which pressing ⌘I sends the question together with the text visible in the pane the user scrolled last. Users sign in with OpenAI (through the local Codex app-server) or with Claude (through the Anthropic API).

**Architecture:** An Electron app with two model providers behind one interface, `ChatProvider`. The OpenAI provider starts `codex app-server` as a child process and speaks its JSON-RPC protocol over stdio, using TypeScript bindings generated from the pinned Codex version. The Claude provider calls the Anthropic Messages API with the official TypeScript SDK and keeps each conversation in a local file, because that API does not store conversations. The renderer draws every pane itself (main chat, side chats, code diff), so on ⌘I it reads the exact visible text from its own DOM, with no screenshot and no text recognition. Pure functions choose and format that context; the input/output shell around them is thin.

**Tech stack:** Electron, TypeScript, React, Vite (`electron-vite`), Vitest with Testing Library, Playwright for Electron end-to-end tests, `electron-builder` for the `.dmg`. Codex CLI 0.146.0 as an external, user-installed dependency. `@anthropic-ai/sdk` for Claude, and the `ant` CLI (optional, user-installed) for browser sign-in to a Claude Console account.

**Build order:** Tasks 0 to 15 build the app with the OpenAI provider and ship it. Tasks 16 to 19 add the Claude provider; they need Tasks 5, 10 and 11 to be done, and Task 15's `.dmg` build is rerun after them. Tasks 20 to 23 add attachments, the model and reasoning pickers, and voice; they need Task 19. Task 24 (live spoken conversation with Codex) is optional and comes last.

**Spec:** the product rules are written out in the section "Product spec" below, taken from the concept film and the brainstorm on the Margin page. There is no separate spec file yet; Task 0 creates `docs/spec.md` from that section.

## Facts this plan rests on

These were checked on 2026-11-20 against Codex CLI 0.146.0 on this machine (`codex app-server generate-ts` and a live probe). Anything not in this list is marked as unverified where it appears.

| Fact | Evidence |
| --- | --- |
| `codex app-server` speaks newline-delimited JSON-RPC over stdio by default. | `codex app-server --help` (`--listen stdio://` default); probe exchanged messages this way. |
| The client must send `initialize` and then the `initialized` notification. | `ClientRequest.ts`, `ClientNotification.ts`; probe. |
| `account/read` returns the signed-in account; an existing Codex CLI login is reused from `~/.codex`. | Probe returned `{"type":"chatgpt","planType":"plus"}` with no login step. |
| Login methods: `account/login/start` with `type` `chatgpt` (returns `authUrl`), `chatgptDeviceCode` (returns `verificationUrl`, `userCode`), or `apiKey`. Completion arrives as `account/login/completed`. | `v2/LoginAccountParams.ts`, `v2/LoginAccountResponse.ts`, `ServerNotification.ts`. |
| `thread/start` accepts `model`, `cwd`, `sandbox` (`read-only`), `approvalPolicy` (`never`), `developerInstructions`, `ephemeral`. | `v2/ThreadStartParams.ts`; probe started an ephemeral read-only thread. |
| `turn/start` takes `input: UserInput[]`; a text input is `{ type: "text", text, text_elements }`. | `v2/TurnStartParams.ts`, `v2/UserInput.ts`. |
| Answers stream as `item/agentMessage/delta` (`threadId`, `turnId`, `itemId`, `delta`); a turn ends with `turn/completed` (`status`: `completed`, `interrupted`, `failed`). | `ServerNotification.ts`, `v2/AgentMessageDeltaNotification.ts`, `v2/TurnStatus.ts`. |
| `thread/fork` creates a new thread from an existing one, optionally through `lastTurnId`. | `v2/ThreadForkParams.ts`. |
| The server can send requests to the client: command and file-change approvals, `item/tool/requestUserInput`, `account/chatgptAuthTokens/refresh`. | `ServerRequest.ts`. |
| `model/list` returned `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` for this account. | Probe. |
| Measured cold costs: server ready ≈ 1.5 s after spawn; `thread/start` ≈ 0.9 s. | Probe, one run; not a benchmark. |
| The app-server and its binding generators are labelled `[experimental]`. | `codex app-server --help`. |

**Not yet measured:** time from `turn/start` to the first `item/agentMessage/delta`, and whether Codex's shell tool can be switched off for a thread. Task 0 measures both before any product code is written.

### Facts for the Claude provider

These were checked on 2026-11-21 against Anthropic's documentation and the bundled Claude API reference.

| Fact | Evidence |
| --- | --- |
| Third-party products may not offer claude.ai (Pro, Max) login: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." Products should use API key authentication. | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), note under "Get started". |
| Claude Max, Ultra and Team plans include monthly API credits, used through an API key from the Claude Console organization linked to the plan. | [Support article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), update of 2026-10-07. |
| `ant auth login` opens a browser, signs in to a Claude Console account, and stores a short-lived token in a named profile under `~/.config/anthropic/`. `ant auth print-credentials --access-token` prints a fresh token for that profile. It is meant for interactive use on the user's own machine. | Bundled reference `shared/anthropic-cli.md`. |
| An exported `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` overrides every profile, even when empty. | Bundled reference `shared/anthropic-cli.md`, "The #1 auth trap". |
| The TypeScript client accepts an explicit `apiKey` (`new Anthropic({ apiKey })`) and streams with `client.messages.stream(...)`; `stream.finalMessage()` returns the complete message. | Bundled reference `typescript/claude-api/README.md`, `streaming.md`. |
| The default model is `claude-opus-5-5` ($4 input, $20 output per million tokens). Thinking cannot be turned off on it; `output_config.effort` (`low` to `max`, default `medium`) controls how long it thinks. | Bundled reference, model table and thinking table. |
| A request can be declined with `stop_reason: "refusal"`; the server-side `fallbacks: "default"` parameter (beta `server-side-fallback-2026-07-01`) reruns it on another model in the same call. | Bundled reference, "Refusal Fallbacks". |
| `ant` is not installed on this machine; `claude` (Claude Code) is. | `which ant claude`, 2026-11-21. |

### Facts for attachments, reasoning and voice

Checked on 2026-11-21 against Codex CLI 0.146.0 (`codex app-server generate-ts --experimental`) and the bundled Claude API reference.

| Fact | Evidence |
| --- | --- |
| Codex turn input accepts `{ type: "localImage", path }` and `{ type: "image", url }`; there is no document or PDF input type. | `v2/UserInput.ts`. |
| Each Codex model lists `inputModalities` (`"text"`, `"image"`, `"audio"`), `supportedReasoningEfforts` and `defaultReasoningEffort`. `turn/start` takes `effort` per turn; `ReasoningEffort` is a plain string. | `v2/Model.ts`, `v2/TurnStartParams.ts`, `ReasoningEffort.ts`. |
| Claude accepts images and PDFs as content blocks (PDF limits: 32 MB per request, 600 pages). | Bundled reference, "Document & File Input". |
| Claude effort is `low`, `medium`, `high`, `xhigh` or `max` in `output_config.effort`; `claude-opus-5-5` has no "thinking off". A mid-conversation effort change invalidates the prompt cache. | Bundled reference, thinking table and "Choosing an effort level". |
| Codex has an experimental live voice API: `thread/realtime/start` (WebRTC or WebSocket transport, audio or text output, voice choice), `thread/realtime/appendAudio`, `thread/realtime/stop`, and notifications such as `thread/realtime/outputAudio/delta` and `thread/realtime/transcript/delta`. It appears only in the `--experimental` bindings. | `v2/ThreadRealtime*.ts`. |
| The Claude Messages API takes no audio input and produces no audio. | Bundled reference (no audio content type is documented). |

**Not yet measured for Claude:** time to the first text token with `claude-opus-5-5` at effort `low` and `medium`, with and without a 12,000-character context, and whether an `ant` OAuth token passed as `authToken` needs the `anthropic-beta: oauth-2025-04-20` header through the SDK. Task 16 measures both.

## Product spec

1. Margin matches the Codex desktop app's layout and interaction: the sidebar, the centred thread, the composer and its controls, spacing, type sizes and keyboard behaviour, taken from reference screenshots (Task 6). It does not copy OpenAI's logos, icons, name or other brand assets. It shows **no Margin logo, avatar or name** inside answers or the composer.
2. **Enter** sends the message without screen context. **⌘I** sends it with screen context. Nothing on screen changes when ⌘I is pressed: no chip, no scan effect, no attachment.
3. The context is the text visible in **the pane the user scrolled last**. If the user has not scrolled any pane since their previous message, the context comes from the pane that has keyboard focus.
4. Inside that pane, visible blocks are weighted by distance from the pane's vertical centre; the centre block is always included.
5. Panes: the main chat; any number of side chats (each forked from the main chat); one code-diff pane showing `git diff` for a folder the user chooses. The right-hand panel stacks the diff above the side chats.
6. The answer appears in the thread where the user typed. The assistant names what it read in its first sentence (section, message, file and line).
7. Diff context carries file names and new-file line numbers, so answers can cite `get_lr()` on line 39.
8. Sign-in offers two providers. **OpenAI** goes through the Codex app-server: ChatGPT browser login, ChatGPT device code, or an OpenAI API key typed by the user. **Claude** goes through the Anthropic API: browser sign-in to a Claude Console account (through `ant auth login`), or an Anthropic API key typed by the user. Margin does not offer claude.ai (Pro, Max) login, because Anthropic does not allow it in third-party products without approval.
8a. Each chat belongs to one provider, chosen when the chat is created. Side chats use the provider of the chat they were forked from. The ⌘I rules are the same for both providers.
11. The composer has pickers for the provider (new chat only), the model, and the reasoning level. The reasoning choices are the ones the chosen model supports. The model and reasoning level can change between messages.
12. Files can be attached with the "+" button, drag and drop, or paste: images (PNG, JPEG, GIF, WebP), PDFs, and text or code files. Attachments show as chips above the composer and in the sent message. Unlike ⌘I context, attachments are visible, because the user chose them.
13. Voice: hold a key to talk; the speech is transcribed on the Mac into the composer and sent when the key is released. Answers can be read aloud. This works for both providers. A live spoken conversation (Task 24) is available for Codex chats only.
14. Margin offers no plugins, skills, MCP servers, apps or artifacts, even though the Codex app-server supports some of them.
9. Margin never runs commands or edits files on the user's behalf.
10. Nothing on screen is read until ⌘I. Only the chosen pane is read.

## Global constraints

- Platform: macOS 14 or later on Apple silicon for the first release.
- Codex: require exactly `codex-cli 0.146.0` (`SUPPORTED_CODEX_VERSION`). A different or missing version is a hard error at startup naming the install command. Upgrading Codex means regenerating bindings and rerunning the protocol tests in the same commit.
- Pin every npm dependency to an exact version in `package.json` and commit `package-lock.json`. Versions are chosen in Task 1 and recorded there; no ranges.
- Context budget: `CONTEXT_BUDGET_CHARS = 12_000` (about 3,000 tokens), a named constant with that reason beside it.
- Capture budget: reading context on ⌘I must take under `CAPTURE_BUDGET_MS = 20` on the end-to-end fixture.
- Every thread Margin creates uses `sandbox: "read-only"`, `approvalPolicy: "never"`, and `cwd` set to Margin's own empty directory `~/Library/Application Support/Margin/empty-workspace`.
- Claude: default model `CLAUDE_DEFAULT_MODEL = "claude-opus-5-5"`; effort is always sent explicitly (`CLAUDE_DEFAULT_EFFORT`, chosen from Task 16's measurement); `max_tokens` is `64_000` with streaming. Margin never reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE` from its environment and removes them from the environment of every child process.
- Secrets (API keys, OAuth tokens) are stored only with Electron `safeStorage` or in the `ant` profile, never in plain files, logs, error messages or the renderer.
- Child processes are started with an argument array and an explicit environment, never a shell string.
- No silent fallbacks. A setting or state that cannot be honoured is an error with a message naming the fix.
- House style: the `mdx` skill (Helen's rules) for code, tests, commits and docs.

## Review focus

These are the five inputs or conditions most likely to hurt a real user that no single feature test would naturally hit. Each has a test in the task named.

1. **Auto-scroll counted as user scroll.** When an answer streams, the thread scrolls itself; that must not make the main chat "last scrolled". Expected: only wheel, trackpad, keyboard and scrollbar input count. Test in Task 9.
2. **Codex missing, wrong version, or signed out mid-session.** Expected: a full-window message naming the fix, never a blank window or a hung composer. Tests in Tasks 3 and 4.
3. **A huge pane.** A 5,000-line diff or a 40-message thread must not exceed the context budget or slow capture. Expected: the centre block is kept, the rest trimmed by weight, total under `CONTEXT_BUDGET_CHARS`, capture under `CAPTURE_BUDGET_MS`. Tests in Tasks 8 and 14.
4. **⌘I while an answer is streaming.** Expected: the send is refused with the composer hint "Wait for the answer, or press Esc to stop it"; nothing is queued silently. Test in Task 10.
5. **The app-server crashes during a turn.** Expected: the turn shows "Codex stopped unexpectedly. Retry", the server restarts, and the thread resumes with `thread/resume`. Test in Task 2 and Task 10.

## File structure

```
margin/
  package.json, package-lock.json, electron.vite.config.ts, tsconfig.json, vitest.config.ts
  docs/spec.md                      Product spec (copied from this plan in Task 0)
  docs/spikes/codex-app-server.md   Task 0 measurements
  scripts/generate-codex-bindings.sh  Regenerates src/codex/generated from the pinned Codex
  src/
    codex/
      generated/                    @generated TypeScript bindings. Never edited by hand.
      rpc-connection.ts             JSON-RPC framing and request/response matching over a byte stream.
      codex-process.ts              Starts, watches and restarts the app-server child process.
      codex-version.ts              Parses and checks `codex --version`.
      codex-client.ts               Typed methods over the connection (initialize, account, thread, turn).
      server-requests.ts            Answers server-to-client requests (declines all approvals).
      codex-provider.ts             ChatProvider implementation over CodexClient (Task 17).
    claude/
      claude-credentials.ts         Resolves Claude credentials: stored API key or `ant` profile token.
      ant-cli.ts                    Runs `ant auth login`, `print-credentials` and `logout` with bounded waits.
      claude-thread-store.ts        Atomic per-thread JSON files of Anthropic messages.
      claude-provider.ts            ChatProvider implementation over the Messages API.
    main/
      main.ts                       Electron entry: window, menus, lifecycle.
      ipc.ts                        Typed IPC handlers that expose the Codex client to the renderer.
      git-diff.ts                   Runs `git diff` for a chosen folder with bounded output.
      layout-store.ts               Atomic read/write of panel layout and diff folder.
    shared/
      ipc-contract.ts               Channel names and payload types shared by main and renderer.
      provider-events.ts            ProviderEvent: the provider-neutral stream events the reducer consumes.
      chat-provider.ts              ChatProvider interface implemented by the OpenAI and Claude providers.
      context-format.ts             Renders and parses the screen-context text block.
    renderer/
      app.tsx                       Root layout: sidebar, main chat, right panel.
      state/thread-reducer.ts       Pure reducer from server notifications to displayed messages.
      context/visible-blocks.ts     Reads visible blocks from a pane's DOM.
      context/select-context.ts     Pure: weights and trims blocks into one context.
      context/scroll-tracker.ts     Records the last pane scrolled by the user.
      context/pane-registry.ts      Maps pane ids to their block readers.
      diff/parse-unified-diff.ts    Pure: unified diff text to rows with line numbers.
      components/ (Sidebar, ChatPane, Composer, Message, DiffPane, SideChatPane, SignIn, StartupError)
  tests/
    fakes/fake-app-server.ts        Scripted stand-in for `codex app-server`, used by unit and e2e tests.
    fixtures/                       Diffs and thread transcripts.
    e2e/                            Playwright Electron tests.
```

---

### Task 0: Protocol spike and measurements

This task writes no product code. It answers the two open questions and records numbers the rest of the plan depends on.

**Files:**
- Create: `spikes/probe-turn.mjs`, `docs/spikes/codex-app-server.md`, `docs/spec.md`

**Interfaces:**
- Produces: the decision `SHELL_TOOL_DISABLE` (a `thread/start` `config` override, or `none-available`) and the measured first-token latency, both written in `docs/spikes/codex-app-server.md`.

- [ ] **Step 1: Copy the "Product spec" section of this plan into `docs/spec.md`.**
- [ ] **Step 2: Write `spikes/probe-turn.mjs`.** It starts `codex app-server`, sends `initialize` and `initialized`, starts one ephemeral thread with the global thread settings, then runs 10 turns of the fixed prompt `Reply with the single word OK.` and records, per turn: time to `turn/started`, time to the first `item/agentMessage/delta`, and time to `turn/completed`. Run it once with no context and once with a 12,000-character context text item before the question.
- [ ] **Step 3: Run it.** Command: `node spikes/probe-turn.mjs > docs/spikes/raw-latency.jsonl`. Expected: 20 lines, each with three timings.
- [ ] **Step 4: Find out whether the shell tool can be disabled.** Read `codex app-server generate-json-schema` output and `codex --help` for a feature or config key that removes shell and patch tools; try it as `thread/start` `config`, ask the model "run `ls`", and record whether an `item/commandExecution` item appears. Record the key, or `none-available`.
- [ ] **Step 5: Check two-item input.** Send a turn whose `input` is `[contextText, questionText]` and confirm with `thread/read` (`includeTurns: true`) that both items are stored in order in the `userMessage` item.
- [ ] **Step 6: Write `docs/spikes/codex-app-server.md`.** It gives the median and 90th percentile of each timing with and without context (raw samples are in `raw-latency.jsonl`), the shell-tool decision, and the two-item result. State plainly that 10 runs from one machine is a small sample.
- [ ] **Step 7: Gate.** If the median time to first delta with context exceeds the time without context by more than 1 second, stop and report to Helen before Task 1, because the latency goal of the product would not hold.
- [ ] **Step 8: Commit.** `git commit -m "docs(spike): measure codex app-server turn latency"`

### Task 1: Project scaffold and generated bindings

**Files:**
- Create: `package.json`, `package-lock.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `scripts/generate-codex-bindings.sh`, `src/codex/generated/**`, `src/main/main.ts`, `src/renderer/app.tsx`, `tests/smoke.test.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run dev`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run lint`, `npm run bindings:check`.

- [ ] **Step 1: Create the project with exact pins.** Use `electron-vite`'s React + TypeScript template, then replace every `^` or `~` range with the exact installed version. Enable `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in `tsconfig.json`.
- [ ] **Step 2: Write `scripts/generate-codex-bindings.sh`.** It checks `codex --version` equals `codex-cli 0.146.0` (exit 1 with the message ``codex must be codex-cli 0.146.0, found `{found}`; install it with `npm install -g @openai/codex@0.146.0` ``), runs `codex app-server generate-ts --out src/codex/generated`, and prepends `// @generated by scripts/generate-codex-bindings.sh. Do not edit by hand.` to every file.
- [ ] **Step 3: Add `npm run bindings:check`.** It regenerates into a temporary directory and fails if the result differs from `src/codex/generated`.
- [ ] **Step 4: Write the smoke test** `tests/smoke.test.ts`: `test("generated bindings export ClientRequest", ...)` imports `ClientRequest` from the bindings and asserts that a value with `method: "initialize"` type-checks (use `expectTypeOf`).
- [ ] **Step 5: Run.** `npm test` passes; `npm run dev` opens an empty window; `npm run bindings:check` passes.
- [ ] **Step 6: Add CI** (`.github/workflows/ci.yml`, actions pinned by full commit SHA with the tag in a comment) running lint, unit tests and `bindings:check` on `macos-14`.
- [ ] **Step 7: Commit.** `git commit -m "build: scaffold electron app with pinned codex bindings"`

### Task 2: JSON-RPC connection and Codex process

**Files:**
- Create: `src/codex/rpc-connection.ts`, `src/codex/codex-process.ts`, `tests/fakes/fake-app-server.ts`, `tests/codex/rpc-connection.test.ts`, `tests/codex/codex-process.test.ts`

**Interfaces:**
- Produces:
  - `class RpcConnection { constructor(options: Readonly<{ input: Readable; output: Writable; requestTimeoutMs: number }>) ; request<Method extends ClientRequest["method"]>(method: Method, params: ParamsOf<Method>): Promise<ResultOf<Method>>; notify(method: "initialized"): void; onNotification(handler: (notification: ServerNotification) => void): Unsubscribe; onServerRequest(handler: (request: ServerRequest) => Promise<JsonValue>): void; close(): void }`
  - `class RpcError extends Error { readonly kind: "timeout" | "server" | "closed" | "malformed"; readonly method: string }`
  - `function startCodexProcess(options: Readonly<{ codexPath: string; env: Readonly<Record<string, string>>; spawn?: SpawnFunction }>): CodexProcess` where `CodexProcess = { connection: RpcConnection; exited: Promise<ExitInfo>; stop(): Promise<void> }`
  - `REQUEST_TIMEOUT_MS = 30 * 1000` (thread and turn start can take over a second cold; 30 s covers a slow network without hanging the UI forever).
  - `FakeAppServer` in `tests/fakes/fake-app-server.ts`: `respond(method, result)`, `emit(notification)`, `sendRequest(request)`, `crash()`, `received(): Array<{ method; params }>`. It throws on any request it was not scripted to answer.

- [ ] **Step 1: Write the failing tests.**
  - `request_resolves_with_the_result_that_matches_its_id`: two concurrent requests answered out of order resolve to their own results.
  - `request_rejects_with_timeout_after_request_timeout_ms`: with fake timers, no answer, rejects `RpcError` with `kind === "timeout"` and message containing the method name and `30000 ms`.
  - `malformed_line_rejects_pending_requests_and_closes`: the fake writes `not json\n`; pending request rejects with `kind === "malformed"`.
  - `partial_lines_are_buffered_until_newline`: a response split across three chunks resolves once.
  - `server_request_handler_reply_is_written_with_the_same_id`.
  - `process_exit_rejects_pending_requests_with_closed` (Review focus 5).
- [ ] **Step 2: Run** `npx vitest run tests/codex` and confirm all fail because the modules do not exist.
- [ ] **Step 3: Implement `RpcConnection`.** Newline framing, an id counter starting at 1, a `Map` of pending requests, one timer per request cleared on settle.
- [ ] **Step 4: Implement `startCodexProcess`.** `spawn(codexPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env })`; stderr is kept in a bounded ring buffer of 64 KiB for error reports; `exited` resolves with code and signal.
- [ ] **Step 5: Run** the tests; all pass.
- [ ] **Step 6: Commit.** `git commit -m "feat(codex): add json-rpc connection and app-server process"`

### Task 3: Codex version gate and startup errors

**Files:**
- Create: `src/codex/codex-version.ts`, `src/renderer/components/StartupError.tsx`, `tests/codex/codex-version.test.ts`
- Modify: `src/main/main.ts`

**Interfaces:**
- Produces:
  - `SUPPORTED_CODEX_VERSION = "0.146.0"`
  - `function parseCodexVersion(output: string): string` (throws on unrecognised output)
  - `function requireSupportedCodex(found: string | undefined): void` throwing `StartupError` with `kind: "codex-missing" | "codex-version"`
  - `type StartupError = { kind: "codex-missing" | "codex-version" | "codex-crashed" | "signed-out"; message: string; fix: string }`

- [ ] **Step 1: Write the failing tests.**
  - `parses_cli_version_line`: `"codex-cli 0.146.0\n"` gives `"0.146.0"`.
  - `missing_codex_names_the_install_command`: `requireSupportedCodex(undefined)` throws with message ``codex was not found on PATH; install it with `npm install -g @openai/codex@0.146.0` `` .
  - `other_version_is_rejected_with_both_versions`: `"0.150.1"` throws a message containing `0.150.1` and `0.146.0`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Main resolves `codex` with `which` semantics over `PATH` (the user's login-shell `PATH`, read once at start-up with `/bin/zsh -lc 'printf %s "$PATH"'` because apps launched from Finder get a minimal `PATH`), runs `codex --version` with a 5-second timeout, and on error shows `StartupError` full-window with the message and a "Copy command" button.
- [ ] **Step 4: Run tests; pass. Commit.** `git commit -m "feat(codex): require the supported codex version at startup"`

### Task 4: Sign-in through the app-server

**Files:**
- Create: `src/codex/codex-client.ts`, `src/renderer/components/SignIn.tsx`, `tests/codex/codex-client-auth.test.ts`, `tests/renderer/sign-in.test.tsx`
- Modify: `src/main/ipc.ts`, `src/shared/ipc-contract.ts`

**Interfaces:**
- Consumes: `RpcConnection` (Task 2).
- Produces (on `CodexClient`):
  - `initialize(): Promise<InitializeResponse>` sends `initialize` with `clientInfo { name: "margin", title: "Margin", version: appVersion }` and `capabilities: { experimentalApi: true, requestAttestation: false }`, then `initialized`.
  - `readAccount(): Promise<GetAccountResponse>`
  - `startLogin(kind: "chatgpt" | "chatgptDeviceCode"): Promise<LoginAccountResponse>`; `startApiKeyLogin(apiKey: string): Promise<void>`; `cancelLogin(loginId: string)`; `logout()`
  - `onLoginCompleted(handler: (event: AccountLoginCompletedNotification) => void): Unsubscribe`
  - IPC channels `auth:read`, `auth:start`, `auth:apiKey`, `auth:logout`, event `auth:changed`.

- [ ] **Step 1: Write the failing tests** (client against `FakeAppServer`).
  - `initialize_sends_initialized_after_the_response`: the fake's `received()` order is `initialize`, then `initialized`.
  - `existing_chatgpt_login_is_reported_without_a_login_request`: fake `account/read` returns a chatgpt account; no `account/login/start` is sent.
  - `chatgpt_login_opens_auth_url_in_the_browser`: the injected `openExternal` fake receives the `authUrl` from the fake's response.
  - `device_code_login_shows_the_user_code`: the SignIn component renders `userCode` and `verificationUrl`.
  - `failed_login_shows_the_server_error`: `account/login/completed` with `success: false, error: "denied"` shows "Sign-in failed: denied".
  - `signed_out_mid_session_returns_to_sign_in` (Review focus 2): `account/updated` with no account switches the window to SignIn and keeps unsent composer text.
  - `api_key_is_never_logged`: after `startApiKeyLogin("sk-test-123")`, no log line or error contains `sk-test-123`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** The renderer never receives tokens or keys back; it only learns the account type, plan and whether sign-in is needed. Show the account's email only in Settings.
- [ ] **Step 4: Run tests; pass. Commit.** `git commit -m "feat(auth): sign in through the codex app-server"`

### Task 5: Threads, turns and streaming

**Files:**
- Modify: `src/codex/codex-client.ts`
- Create: `src/codex/server-requests.ts`, `src/renderer/state/thread-reducer.ts`, `tests/codex/codex-client-threads.test.ts`, `tests/renderer/thread-reducer.test.ts`, `tests/codex/server-requests.test.ts`

**Interfaces:**
- Produces:
  - `THREAD_DEFAULTS = { sandbox: "read-only", approvalPolicy: "never", cwd: emptyWorkspacePath, developerInstructions: MARGIN_INSTRUCTIONS, config: SHELL_TOOL_DISABLE }` (the last from Task 0; omitted if `none-available`).
  - `startThread(options: Readonly<{ model: string }>): Promise<ThreadId>`; `resumeThread(threadId)`; `forkThread(threadId, lastTurnId: TurnId | null): Promise<ThreadId>`; `listThreads()`; `readThread(threadId): Promise<Thread>`
  - `startTurn(threadId: ThreadId, input: Readonly<{ question: string; context: ScreenContext | null }>): Promise<TurnId>`; `interruptTurn(threadId, turnId)`
  - `type ThreadId = string & { readonly brand: "ThreadId" }`; same for `TurnId`.
  - `MARGIN_INSTRUCTIONS`: fixed text, in full: "You are a reading companion inside a chat app. Some user messages begin with a block marked MARGIN SCREEN CONTEXT. That block is the text the user was looking at when they asked. When it is present, the question refers to it: start your answer by naming what you read (the message, section, file and line), then answer. Quote file names, function names and line numbers exactly as they appear in the block. Never run commands or edit files."
  - `type ProviderEvent = { type: "delta"; threadId: ThreadId; turnId: TurnId; text: string } | { type: "completed"; threadId: ThreadId; turnId: TurnId; status: "completed" | "interrupted" | "failed" | "refused"; error: string | null } | { type: "accountChanged"; provider: "codex" | "claude" }` in `src/shared/provider-events.ts`. The reducer consumes these so that the Claude provider (Task 18) can reuse it unchanged.
  - `function toProviderEvent(notification: ServerNotification): ProviderEvent | null` in `src/codex/codex-client.ts` maps `item/agentMessage/delta`, `turn/completed` and `account/updated`, and returns `null` for every other method.
  - `function reduceThread(state: ThreadView, event: ProviderEvent): ThreadView` where `ThreadView = Readonly<{ messages: ReadonlyArray<DisplayMessage>; activeTurn: TurnId | null; error: string | null }>` and `DisplayMessage = Readonly<{ id: string; role: "user" | "assistant"; text: string; status: "streaming" | "done" | "failed" }>`
  - `answerServerRequest(request: ServerRequest): JsonValue` declines every approval (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `applyPatchApproval`, `execCommandApproval`, `item/permissions/requestApproval`) and answers `item/tool/requestUserInput` with an empty answer. Every decline is logged with method and thread id.

- [ ] **Step 1: Write the failing tests.**
  - `thread_start_sends_read_only_never_and_empty_cwd`: assert the exact params the fake received.
  - `deltas_append_to_the_streaming_message_in_order`: three `item/agentMessage/delta` notifications produce one assistant message with the concatenated text.
  - `deltas_for_another_thread_are_ignored`.
  - `turn_completed_failed_marks_the_message_failed_with_the_error_text`.
  - `every_approval_request_is_declined`: a table over the five approval methods; each reply is a decline and one log entry is written.
  - `crash_during_turn_restarts_and_resumes_the_thread` (Review focus 5): fake crashes mid-stream; the message shows "Codex stopped unexpectedly. Retry"; a new process sends `thread/resume` with the same thread id.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Use the exact decline shape from the generated `*ApprovalResponse` types; do not hand-write JSON.
- [ ] **Step 4: Run tests; pass. Commit.** `git commit -m "feat(codex): run read-only threads and stream answers"`

### Task 6: Chat UI with Enter to send

**Files:**
- Create: `src/renderer/components/{Sidebar,ChatPane,Composer,Message}.tsx`, `tests/renderer/chat-pane.test.tsx`, `tests/renderer/composer.test.tsx`
- Modify: `src/renderer/app.tsx`

**Interfaces:**
- Consumes: `reduceThread`, IPC `thread:*` channels.
- Produces: `<ChatPane paneId threadId />`, `<Composer onSend(question: string, mode: "plain" | "withContext") busy />`. `ChatPane` exposes its scroll container element through `ref` for Task 9.

- [ ] **Step 0: Write the visual reference.** Collect screenshots of the Codex desktop app (new chat, a long thread, the composer with its menus open, the sidebar) from Helen, and write `docs/ui-reference.md`: measured widths, paddings, radii, font sizes and colours for each element, as CSS custom properties in `src/renderer/theme.css`. Use only measurements, not OpenAI's image or icon files; draw Margin's own icons.
- [ ] **Step 1: Write the failing tests.**
  - `enter_sends_plain_and_clears_the_composer`.
  - `shift_enter_inserts_a_newline`.
  - `answers_render_without_any_logo_or_assistant_name` (spec 1): the rendered assistant message contains no element with role `img` and no text "Margin".
  - `markdown_code_spans_render_as_code`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Markdown with a pinned renderer (`react-markdown`) and no raw HTML. Auto-scroll to the bottom while streaming only if the user was already at the bottom.
- [ ] **Step 4: Run tests; pass. Manually: sign in, ask a question, see it stream. Commit.** `git commit -m "feat(ui): add chat pane and composer"`

### Task 7: Visible blocks from a pane

**Files:**
- Create: `src/renderer/context/visible-blocks.ts`, `src/renderer/context/pane-registry.ts`, `tests/renderer/visible-blocks.test.ts`

**Interfaces:**
- Produces:
  - `type VisibleBlock = Readonly<{ text: string; label: string; top: number; bottom: number }>` (pixel positions relative to the pane's viewport; `label` is e.g. `message 4 (assistant), heading "3. Learning-rate schedule"` or `train.py line 39`).
  - `function readVisibleBlocks(container: HTMLElement): ReadonlyArray<VisibleBlock>` reads elements marked `data-context-block` whose rectangles intersect the container's visible rectangle, in document order. A partly visible block keeps its full text; its `top` and `bottom` are clipped to the view, so weighting in Task 8 uses only the visible part.
  - `registerPane(paneId: PaneId, reader: () => ReadonlyArray<VisibleBlock>, kind: "chat" | "diff"): Unregister`; `readPane(paneId): ReadonlyArray<VisibleBlock>`.

- [ ] **Step 1: Write the failing tests** (jsdom with stubbed `getBoundingClientRect`).
  - `only_blocks_intersecting_the_view_are_returned`.
  - `blocks_keep_document_order`.
  - `nearest_heading_above_the_view_is_added_to_the_label` (a chat answer scrolled past its heading still reports `heading "3. Learning-rate schedule"`).
- [ ] **Step 2–4: Fail, implement, pass.** `Message` marks each paragraph, list item and code block with `data-context-block` and a `data-context-label`.
- [ ] **Step 5: Commit.** `git commit -m "feat(context): read visible blocks from a pane"`

### Task 8: Context selection and format

**Files:**
- Create: `src/renderer/context/select-context.ts`, `src/shared/context-format.ts`, `tests/renderer/select-context.test.ts`, `tests/shared/context-format.test.ts`

**Interfaces:**
- Produces:
  - `CONTEXT_BUDGET_CHARS = 12_000` (about 3,000 tokens; Task 0 shows this adds little delay).
  - `function selectContext(blocks: ReadonlyArray<VisibleBlock>, viewportHeight: number, budgetChars: number): ReadonlyArray<VisibleBlock>`. Governing rule: weight `w = 1 - |c - h/2| / (h/2)`, where `c` is the centre of the block's visible part and `h` the viewport height; blocks are added in order of descending `w` until the next one would exceed the budget; the result is returned in document order. The block with the highest `w` is always included, truncated to the budget if it alone exceeds it.
  - `type ScreenContext = Readonly<{ paneKind: "chat" | "diff"; paneTitle: string; blocks: ReadonlyArray<VisibleBlock> }>`
  - `function renderContextBlock(context: ScreenContext): string` returns the exact text below; `function parseContextBlock(text: string): ScreenContext | null` reverses it (used to hide the block when a thread is reloaded).

```
MARGIN SCREEN CONTEXT v1
pane: diff · PR #128 · Add linear warmup
--- train.py line 39
        return peak * (step // warmup_steps)
--- train.py line 40
    progress = (step - warmup_steps) / (total_steps - warmup_steps)
END MARGIN SCREEN CONTEXT
```

- [ ] **Step 1: Write the failing tests.**
  - `centre_block_is_always_kept`.
  - `result_never_exceeds_the_budget` over sizes 0, 1, budget − 1, budget, budget + 1 characters (Review focus 3).
  - `huge_single_block_is_truncated_not_dropped`.
  - `output_is_in_document_order`.
  - `render_then_parse_round_trips` for a chat context and a diff context.
  - `parse_returns_null_for_ordinary_text`.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(context): select and format screen context"`

### Task 9: Last-scrolled pane tracking

**Files:**
- Create: `src/renderer/context/scroll-tracker.ts`, `tests/renderer/scroll-tracker.test.ts`

**Interfaces:**
- Produces:
  - `function createScrollTracker(clock: () => number): ScrollTracker` with `attach(paneId, element): Detach`, `markMessageSent(): void`, and `choosePane(focusedPaneId: PaneId | null): PaneId | null`.
  - Rule (spec 3): return the pane with the latest user scroll after the last `markMessageSent`; if none, return `focusedPaneId`.
  - User scroll is detected from `wheel`, `keydown` (PageUp, PageDown, arrows, Space, Home, End) and `pointerdown` on the scrollbar, each followed by a `scroll` event within `USER_SCROLL_WINDOW_MS = 300`. A `scroll` event with no such input before it is programmatic and ignored.

- [ ] **Step 1: Write the failing tests.**
  - `wheel_scroll_marks_the_pane`.
  - `programmatic_scroll_does_not_mark_the_pane` (Review focus 1): `element.scrollTop = 500` dispatches `scroll` with no input; `choosePane(null)` stays `null`.
  - `latest_of_two_panes_wins`: diff at t=100, side chat at t=50 gives diff.
  - `sending_resets_to_focus`: after `markMessageSent`, `choosePane("main")` returns `"main"`.
- [ ] **Step 2–4: Fail, implement, pass. Commit.** `git commit -m "feat(context): track the pane the user scrolled last"`

### Task 10: ⌘I sends with context

**Files:**
- Modify: `src/renderer/components/Composer.tsx`, `src/renderer/app.tsx`, `src/codex/codex-client.ts`
- Create: `tests/renderer/command-i.test.tsx`

**Interfaces:**
- Consumes: `choosePane` (Task 9), `readPane` (Task 7), `selectContext` and `renderContextBlock` (Task 8), `startTurn` (Task 5).
- Produces: `startTurn` sends `input = [{ type: "text", text: renderContextBlock(context), text_elements: [] }, { type: "text", text: question, text_elements: [] }]` when context is present, otherwise only the question. The displayed user message shows only the question; `parseContextBlock` hides the first item when a thread is reloaded.

- [ ] **Step 1: Write the failing tests.**
  - `command_i_sends_two_text_items_context_first`: the fake receives exactly that `input`.
  - `command_i_changes_nothing_on_screen` (spec 2): after ⌘I the DOM outside the thread is unchanged except the cleared composer; no element with text "context", "attached" or "screen" appears.
  - `enter_sends_without_context`.
  - `command_i_during_streaming_is_refused_with_a_hint` (Review focus 4): composer shows "Wait for the answer, or press Esc to stop it"; the fake receives no `turn/start`.
  - `escape_interrupts_the_active_turn`: sends `turn/interrupt` with the active ids.
  - `reloaded_thread_hides_the_context_item`.
- [ ] **Step 2–4: Fail, implement, pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(composer): send screen context on command-i"`

### Task 11: Side chats

**Files:**
- Create: `src/renderer/components/SideChatPane.tsx`, `tests/renderer/side-chat.test.tsx`
- Modify: `src/renderer/app.tsx`, `src/main/layout-store.ts`

**Interfaces:**
- Consumes: `forkThread` (Task 5), `ChatPane`, `Composer`.
- Produces: "Open side chat" on any assistant message calls `forkThread(mainThreadId, thatTurnId)` and opens a `SideChatPane` in the right panel below the diff. Each side chat has its own composer; its answers stay in it.

- [ ] **Step 1: Write the failing tests.**
  - `open_side_chat_forks_through_the_chosen_turn`.
  - `side_chat_answers_stay_in_the_side_chat`.
  - `main_composer_command_i_after_scrolling_the_side_chat_uses_side_chat_context` (spec 3 and 6): context pane is the side chat; the answer appears in the main thread.
- [ ] **Step 2–4: Fail, implement, pass. Commit.** `git commit -m "feat(ui): add forked side chats"`

### Task 12: Code-diff pane

**Files:**
- Create: `src/main/git-diff.ts`, `src/renderer/diff/parse-unified-diff.ts`, `src/renderer/components/DiffPane.tsx`, `tests/fixtures/warmup.diff`, `tests/main/git-diff.test.ts`, `tests/renderer/parse-unified-diff.test.ts`, `tests/renderer/diff-pane.test.tsx`

**Interfaces:**
- Produces:
  - `DIFF_MAX_BYTES = 2 * 1024 * 1024` (beyond this the pane shows "This diff is too large to show (N MB). Narrow it to fewer files." instead of truncating silently).
  - `function runGitDiff(options: Readonly<{ folder: string; base: "HEAD" | "staged"; exec?: ExecFile }>): Promise<string>` running `git -C <folder> diff --no-color --no-ext-diff -U3 [--staged]` with an explicit environment and a 10-second timeout; errors name the folder and git's stderr.
  - `type DiffRow = Readonly<{ kind: "file" | "hunk" | "context" | "add" | "delete"; file: string; newLine: number | null; text: string }>`
  - `function parseUnifiedDiff(text: string): ReadonlyArray<DiffRow>`
  - Each rendered row is a `data-context-block` with label `` `${file} line ${newLine}` `` (deleted rows: `` `${file} deleted line` ``).

- [ ] **Step 1: Write the failing tests.**
  - `parses_new_file_line_numbers_from_hunk_headers`: on `warmup.diff` (the PR from the film), the row with text `        return peak * (step // warmup_steps)` has `file: "train.py"`, `newLine: 39`, `kind: "add"`.
  - `deleted_rows_have_no_new_line_number`.
  - `renamed_and_binary_files_produce_a_file_row_and_no_lines`.
  - `diff_over_the_limit_shows_the_size_message` (Review focus 3).
  - `git_failure_message_names_the_folder`.
  - `visible_diff_context_labels_carry_file_and_line`: from a rendered DiffPane scrolled to line 39, `readPane` labels include `train.py line 39`.
- [ ] **Step 2–4: Fail, implement, pass.** The folder is chosen with Electron's folder dialog and saved by `layout-store`.
- [ ] **Step 5: Commit.** `git commit -m "feat(diff): show git diff with line-numbered context"`

### Task 13: Layout persistence and chat list

**Files:**
- Create: `tests/main/layout-store.test.ts`
- Modify: `src/main/layout-store.ts`, `src/renderer/components/Sidebar.tsx`

**Interfaces:**
- Produces: `readLayout(): Promise<Layout>`, `writeLayout(layout: Layout): Promise<void>` (temporary file in the same folder, then rename) where `Layout = Readonly<{ version: 1; diffFolder: string | null; sideChats: ReadonlyArray<{ threadId: ThreadId; forkedFromTurn: TurnId }>; panelWidthPx: number }>`. Unknown keys or another `version` are rejected with a message naming the file. The sidebar lists threads from `thread/list`.

- [ ] **Step 1–4: Tests** `write_is_atomic` (a crash between write and rename leaves the old file intact), `unknown_keys_are_rejected`, `missing_file_gives_the_default_layout`; fail, implement, pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): persist panel layout atomically"`

### Task 14: Latency instrumentation and the end-to-end test

**Files:**
- Create: `src/renderer/metrics.ts`, `tests/e2e/command-i.spec.ts`, `tests/e2e/fixtures/long-thread.json`

**Interfaces:**
- Produces: for every ⌘I send, one JSON line appended to `~/Library/Application Support/Margin/metrics.jsonl`: `{ at, paneKind, blockCount, contextChars, captureMs, turnStartAckMs, firstDeltaMs }`. No text content is written.

- [ ] **Step 1: Write the end-to-end test** (Playwright Electron, `FakeAppServer` in place of Codex through an environment variable read once at start-up, `MARGIN_CODEX_PATH`).
  - `diff_scenario_from_the_film`: open the main chat; open the diff pane on `warmup.diff`; type in a side chat and press Enter; scroll the diff to line 39 with the mouse wheel; type "does this look right?" in the main composer and press ⌘I. Assert the fake received a context block containing `--- train.py line 39`, that the answer appears in the main chat, and that nothing else on screen changed.
  - `capture_is_under_budget`: on `long-thread.json` (40 messages) and a 5,000-line diff, `captureMs < 20` in `metrics.jsonl` for 20 consecutive sends (Review focus 3).
- [ ] **Step 2–4: Fail, implement metrics, pass.** Run `npm run test:e2e`.
- [ ] **Step 5: Manual check with real Codex** and record in `docs/spikes/codex-app-server.md`: median `firstDeltaMs` over 10 real ⌘I sends, compared with Task 0's number.
- [ ] **Step 6: Commit.** `git commit -m "test(e2e): cover the command-i diff scenario and capture time"`

### Task 15: Packaging and documentation

**Files:**
- Create: `electron-builder.yml`, `README.md`, `PRIVACY.md`, `LICENSE` (Apache-2.0, matching Codex)
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Build an unsigned `.dmg`** with `npm run build && npx electron-builder --mac dmg --arm64`. Expected: `dist/Margin-<version>-arm64.dmg`, installs and launches on a second user account.
- [ ] **Step 2: Write `README.md`.** First sentence: "Margin is a desktop chat app that answers questions about whatever you were reading when you pressed ⌘I." Then: requirements (macOS 14+, `codex-cli 0.146.0`), install, sign-in (it reuses your Codex login), the ⌘I rule, what it does not do (no screen reading outside its own window, no commands, no file edits), and the open terms question below.
- [ ] **Step 3: Write `PRIVACY.md`.** What is read (only the chosen pane, only on ⌘I), where it goes (to OpenAI through Codex, as part of that one message), what is stored locally (Codex's thread history in `~/.codex`, Margin's layout and timing metrics without text).
- [ ] **Step 4: Add a CI job** that builds the `.dmg` on tags.
- [ ] **Step 5: Commit.** `git commit -m "build: package margin as a macos dmg"`

### Task 16: Claude latency and sign-in spike

This task writes no product code. It measures Claude's delay and settles how an `ant` token reaches the SDK.

**Files:**
- Create: `spikes/probe-claude.mjs`, `docs/spikes/claude.md`

**Interfaces:**
- Produces: `CLAUDE_DEFAULT_EFFORT` (`"low"` or `"medium"`), and `ANT_TOKEN_NEEDS_OAUTH_BETA` (`true` or `false`), both written in `docs/spikes/claude.md`.

- [ ] **Step 1: Ask Helen for a dollar cap before any paid call.** The expected cost is under $1: 40 requests of about 3,500 input and 200 output tokens at $4 and $20 per million tokens is about $0.56 + $0.16.
- [ ] **Step 2: Write `spikes/probe-claude.mjs`.** It reads the API key from the macOS Keychain entry Helen creates for the spike (never from the environment or chat), and runs 10 streamed requests in each of four settings: effort `low` and `medium`, each with no context and with a 12,000-character context block before the question `Reply with the single word OK.`. Per request it records time to the first `text_delta`, time to `message_stop`, `usage.input_tokens` and `usage.output_tokens`. It adds up the cost from `usage` after each request and stops with an error before the next request would pass the cap.
- [ ] **Step 3: Run it.** Command: `node spikes/probe-claude.mjs > docs/spikes/raw-claude-latency.jsonl`. Expected: 40 lines and a printed total cost under the cap.
- [ ] **Step 4: Test an `ant` token.** Install `ant`, run `ant auth login --profile margin-spike`, then send one request with `new Anthropic({ authToken })` using the token from `ant auth print-credentials --access-token --profile margin-spike`, once without and once with `defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }`. Record which works as `ANT_TOKEN_NEEDS_OAUTH_BETA`, and record the `ant` version as `SUPPORTED_ANT_VERSION`.
- [ ] **Step 5: Write `docs/spikes/claude.md`.** It gives medians and 90th percentiles per setting, compares them with Task 0's Codex numbers in one table, chooses `CLAUDE_DEFAULT_EFFORT` (the lower effort unless its answers are wrong on the probe), and states that 10 runs per setting from one machine is a small sample.
- [ ] **Step 6: Commit.** `git commit -m "docs(spike): measure claude latency and ant token use"`

### Task 17: ChatProvider interface, with Codex behind it

**Files:**
- Create: `src/shared/chat-provider.ts`, `src/codex/codex-provider.ts`, `tests/codex/codex-provider.test.ts`
- Modify: `src/main/ipc.ts`, `src/shared/ipc-contract.ts`, `src/renderer/app.tsx`

**Interfaces:**
- Consumes: `CodexClient` (Tasks 4 and 5), `ProviderEvent` (Task 5).
- Produces:
  - `type ProviderId = "codex" | "claude"`
  - `type ProviderAccount = Readonly<{ provider: ProviderId; signedIn: boolean; label: string | null }>` (`label` is "ChatGPT Plus", "Claude Console" or "API key"; never a key or token)
  - `interface ChatProvider { readonly id: ProviderId; readAccount(): Promise<ProviderAccount>; startThread(): Promise<ThreadId>; forkThread(threadId: ThreadId, lastTurnId: TurnId | null): Promise<ThreadId>; startTurn(threadId: ThreadId, input: Readonly<{ question: string; context: ScreenContext | null }>): Promise<TurnId>; interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void>; readThread(threadId: ThreadId): Promise<ReadonlyArray<DisplayMessage>>; onEvent(handler: (event: ProviderEvent) => void): Unsubscribe }`
  - `function createCodexProvider(client: CodexClient): ChatProvider`
  - IPC channels gain a `provider: ProviderId` field; `Layout.sideChats` entries and the chat list gain `provider`.

- [ ] **Step 1: Write the failing tests.**
  - `codex_provider_forwards_start_turn_with_context_first`: same assertion as Task 10's, through the interface.
  - `codex_provider_emits_provider_events_only`: a fake `turn/started` notification produces no event; a delta produces one `delta` event.
  - `ipc_rejects_an_unknown_provider_id`: `"gemini"` fails with ``unknown provider `gemini`; expected codex or claude``.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement**, and move every renderer call from Codex-specific channels to the provider channels. Rerun the whole unit and end-to-end suites; they must pass unchanged.
- [ ] **Step 4: Commit.** `git commit -m "refactor(provider): put codex behind a chat provider interface"`

### Task 18: Claude sign-in

**Files:**
- Create: `src/claude/claude-credentials.ts`, `src/claude/ant-cli.ts`, `tests/claude/claude-credentials.test.ts`, `tests/claude/ant-cli.test.ts`
- Modify: `src/renderer/components/SignIn.tsx`, `tests/renderer/sign-in.test.tsx`

**Interfaces:**
- Produces:
  - `type ClaudeCredential = { kind: "apiKey"; apiKey: string } | { kind: "antProfile"; profile: "margin"; accessToken: string; fetchedAtMs: number }`
  - `function readClaudeCredential(store: SecretStore, ant: AntCli, clock: () => number): Promise<ClaudeCredential | null>`: a stored key wins; otherwise a token from the `margin` profile if one exists; otherwise `null`.
  - `function createClaudeClient(credential: ClaudeCredential): Anthropic` builds `new Anthropic({ apiKey })` or `new Anthropic({ authToken, defaultHeaders })` (headers per `ANT_TOKEN_NEEDS_OAUTH_BETA`). It never lets the SDK read the environment.
  - `ANT_TOKEN_REFRESH_MS = 5 * 60 * 1000`: an `ant` token older than this is fetched again with `print-credentials`, which refreshes it if needed.
  - `type AntCli = { version(): Promise<string>; login(profile: "margin"): Promise<void>; accessToken(profile: "margin"): Promise<string>; logout(profile: "margin"): Promise<void> }`. Every call runs `ant` with an argument array, an environment with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_PROFILE` removed, and a timeout: 5 minutes for `login`, 10 seconds for the others.
  - `SecretStore` wraps Electron `safeStorage`: `saveApiKey(provider, key)`, `readApiKey(provider)`, `deleteApiKey(provider)`.
  - Sign-in screen: a "Claude" section with "Sign in with Claude Console" and "Use an Anthropic API key". A typed key is checked once with `client.models.list()` (no tokens used) before it is saved.

- [ ] **Step 1: Write the failing tests** (fake `AntCli`, fake `SecretStore`, fake clock).
  - `stored_api_key_wins_over_the_ant_profile`.
  - `ant_token_is_refetched_after_five_minutes`.
  - `missing_ant_names_the_install_step`: `version()` fails, so "Sign in with Claude Console" shows ``ant was not found on PATH; install it as described in Anthropic's CLI docs, or use an API key instead``.
  - `environment_credentials_are_ignored` (from the auth trap above): with `ANTHROPIC_API_KEY=stale` in `process.env`, `createClaudeClient` uses the stored key, and the environment passed to `ant` contains no `ANTHROPIC_` credential variable.
  - `invalid_key_is_not_saved`: `models.list()` rejects with `AuthenticationError`; the screen shows "Anthropic rejected this API key" and `SecretStore` holds nothing.
  - `api_key_never_reaches_the_renderer_or_logs`: after saving `sk-ant-test-123`, no IPC payload and no log line contains it.
  - `no_claude_ai_login_is_offered` (spec 8): the sign-in screen has no control mentioning "claude.ai", "Pro" or "Max".
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Sign out deletes the stored key and runs `ant auth logout --profile margin`; it never touches other `ant` profiles or Claude Code's login.
- [ ] **Step 4: Run tests; pass. Commit.** `git commit -m "feat(claude): sign in with a claude console account or api key"`

### Task 19: Claude chats, streaming and side chats

**Files:**
- Create: `src/claude/claude-thread-store.ts`, `src/claude/claude-provider.ts`, `tests/claude/claude-thread-store.test.ts`, `tests/claude/claude-provider.test.ts`, `tests/fakes/fake-anthropic.ts`, `tests/e2e/claude-command-i.spec.ts`
- Modify: `src/renderer/components/Sidebar.tsx` (provider choice on "New chat")

**Interfaces:**
- Consumes: `ChatProvider` (Task 17), `ClaudeCredential` and `createClaudeClient` (Task 18), `renderContextBlock` and `MARGIN_INSTRUCTIONS` (Tasks 5 and 8).
- Produces:
  - `type ClaudeThreadFile = Readonly<{ version: 1; threadId: ThreadId; model: string; effort: "low" | "medium"; messages: ReadonlyArray<Anthropic.MessageParam>; turns: ReadonlyArray<{ turnId: TurnId; userMessageIndex: number }> }>`, one file per thread in `~/Library/Application Support/Margin/claude-threads/`, written atomically. Unknown keys or another `version` are rejected with a message naming the file.
  - `function createClaudeProvider(options: Readonly<{ credentials: () => Promise<ClaudeCredential>; store: ClaudeThreadStore; makeClient?: (credential: ClaudeCredential) => Anthropic }>): ChatProvider`
  - `startTurn` appends a user message whose `content` is `[{ type: "text", text: renderContextBlock(context) }, { type: "text", text: question }]` (only the question without context), then calls `client.beta.messages.stream({ model, max_tokens: 64_000, system: MARGIN_INSTRUCTIONS, messages, output_config: { effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })` with top-level `cache_control: { type: "ephemeral" }` so that the unchanged history is cached between turns. Each `text_delta` becomes a `delta` event. On `message_stop` the whole `finalMessage().content` (thinking blocks included, unchanged) is appended as the assistant message.
  - `interruptTurn` aborts the stream. The assistant message stored for an interrupted turn holds only the text already shown, or the text `(stopped before any answer)` when none was shown, so that user and assistant messages keep alternating.
  - `forkThread` copies `messages` up to and including the assistant reply of `lastTurnId` into a new thread file.
  - Errors map to `completed` events with `status: "failed"`, most specific first: `Anthropic.AuthenticationError` gives "Claude sign-in expired. Sign in again" and an `accountChanged` event; `Anthropic.RateLimitError` gives "Claude rate limit reached. Try again in N s" with N from `retry-after`; `Anthropic.APIConnectionError` gives "Cannot reach Anthropic. Check the connection". `stop_reason: "refusal"` gives `status: "refused"` and "Claude declined to answer this", with the `stop_details.category` when present.

- [ ] **Step 1: Write the failing tests** (fake Anthropic client recording each request and replaying scripted stream events; it throws on any unscripted call).
  - `command_i_sends_context_block_then_question_in_one_user_message`.
  - `request_carries_model_effort_fallbacks_and_cache_control`: assert the exact request fields above.
  - `assistant_content_is_stored_unchanged_including_thinking_blocks`.
  - `interrupt_keeps_messages_alternating`: interrupt before any text; the stored thread ends with a user message followed by an assistant message reading `(stopped before any answer)`.
  - `fork_copies_messages_through_the_chosen_turn` and `fork_leaves_the_original_thread_unchanged`.
  - `each_error_maps_to_its_message`: a table over the three error classes and a refusal.
  - `thread_file_with_unknown_keys_is_rejected`.
  - `reloaded_thread_hides_the_context_block`: `readThread` returns only the question for a ⌘I message.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Use the SDK's types (`Anthropic.MessageParam`, the typed error classes); do not define parallel types or match error strings.
- [ ] **Step 4: End-to-end test** `claude_diff_scenario_from_the_film`: Task 14's diff scenario with a Claude chat and the fake client. Assert the same context block and that the answer appears in the main chat.
- [ ] **Step 5: Manual check with a real key** (within the cap from Task 16): one ⌘I question about `warmup.diff` must name `get_lr()` and line 39. Record `firstDeltaMs` in `docs/spikes/claude.md`.
- [ ] **Step 6: Rerun Task 15 Steps 1 to 3** so that the `.dmg`, `README.md` and `PRIVACY.md` cover Claude: where Claude conversations are stored (Margin's `claude-threads` folder, plain JSON, not encrypted), and that ⌘I context goes to Anthropic for Claude chats.
- [ ] **Step 7: Commit.** `git commit -m "feat(claude): run claude chats with streaming and side chats"`

### Task 20: Model and reasoning pickers

**Files:**
- Create: `src/renderer/components/ModelPicker.tsx`, `src/renderer/components/ReasoningPicker.tsx`, `tests/renderer/pickers.test.tsx`
- Modify: `src/shared/chat-provider.ts`, `src/codex/codex-provider.ts`, `src/claude/claude-provider.ts`, `src/renderer/components/Composer.tsx`

**Interfaces:**
- Produces:
  - `type ModelOption = Readonly<{ provider: ProviderId; id: string; label: string; reasoningLevels: ReadonlyArray<string>; defaultReasoning: string; acceptsImages: boolean; acceptsPdfs: boolean }>`
  - `ChatProvider.listModels(): Promise<ReadonlyArray<ModelOption>>`. Codex maps `model/list` (`supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`); `acceptsPdfs` is `false` for Codex. Claude lists `CLAUDE_MODELS`, a constant naming `claude-opus-5-5` (levels `low` to `max`, default `CLAUDE_DEFAULT_EFFORT`, images and PDFs accepted) and any further model Helen adds; each entry is checked once against `client.models.retrieve(id)` at sign-in.
  - `startTurn` input gains `model: string` and `reasoning: string`. Codex sends them as `turn/start` `model` and `effort`; Claude sends `model` and `output_config.effort`.
  - The chat's last choice is stored with the chat and preselected next time.

- [ ] **Step 1: Write the failing tests.**
  - `reasoning_choices_follow_the_chosen_model`: switching from a model with levels `["low","medium","high"]` to one with `["medium","high"]` while `low` is selected selects that model's default and shows the note "Reasoning set to medium; this model has no low".
  - `codex_turn_carries_model_and_effort`; `claude_turn_carries_model_and_effort`.
  - `provider_picker_is_only_on_a_new_chat`.
  - `unknown_reasoning_value_is_rejected_before_sending`: a stored value `"turbo"` fails with ``reasoning level `turbo` is not offered by `claude-opus-5-5`; choose low, medium, high, xhigh or max``.
- [ ] **Step 2–4: Fail, implement, pass.** Commit: `git commit -m "feat(composer): pick model and reasoning level per message"`

### Task 21: File and image attachments

**Files:**
- Create: `src/main/attachments.ts`, `src/renderer/components/AttachmentChips.tsx`, `tests/main/attachments.test.ts`, `tests/renderer/attachments.test.tsx`, `tests/fixtures/attachments/` (a PNG, a 2-page PDF, a `.py` file, a binary `.zip`)
- Modify: `src/codex/codex-provider.ts`, `src/claude/claude-provider.ts`, `src/renderer/components/Composer.tsx`

**Interfaces:**
- Produces:
  - `ATTACHMENT_LIMITS = { imageBytes: 20 * 1024 * 1024, pdfBytes: 32 * 1024 * 1024, textBytes: 1 * 1024 * 1024, perMessage: 10 }` (the PDF limit is Claude's request limit; the others keep a message well under it).
  - `type Attachment = Readonly<{ id: string; kind: "image" | "pdf" | "text"; name: string; storedPath: string; bytes: number; mediaType: string }>`. Files are copied into `~/Library/Application Support/Margin/attachments/<chat id>/` when attached, so later edits to the original do not change a sent message.
  - `function classifyAttachment(name: string, firstBytes: Uint8Array): Attachment["kind"]` decides by content signature, not by extension alone; anything else is rejected with ``cannot attach `{name}`; Margin accepts images, PDFs and text files``.
  - Codex: an image becomes `{ type: "localImage", path: storedPath }`; a text file becomes a text item headed `ATTACHED FILE {name}`; a PDF becomes a text item of its extracted text (with `pdfjs-dist`), headed `ATTACHED PDF {name} (text only)`. A model whose `acceptsImages` is false rejects images before sending.
  - Claude: an image becomes a base64 `image` block, a PDF a base64 `document` block, a text file a `text` block headed as above. Attachments come before the ⌘I context block, which comes before the question.

- [ ] **Step 1: Write the failing tests.**
  - `each_fixture_is_classified_by_content`; `zip_is_rejected_with_the_accepted_kinds`.
  - `limits_are_enforced_at_each_boundary`: sizes limit − 1, limit, limit + 1 for each kind.
  - `codex_image_becomes_local_image_with_the_copied_path`; `codex_pdf_becomes_extracted_text`.
  - `claude_pdf_becomes_a_document_block`.
  - `order_is_attachments_then_context_then_question` for both providers.
  - `image_sent_to_a_text_only_model_is_refused_before_sending`, with the model name in the message.
- [ ] **Step 2–4: Fail, implement, pass.** Commit: `git commit -m "feat(composer): attach images, pdfs and text files"`

### Task 22: Push-to-talk dictation

**Files:**
- Create: `src/main/speech/transcriber.ts`, `src/renderer/voice/push-to-talk.ts`, `tests/main/transcriber.test.ts`, `tests/renderer/push-to-talk.test.ts`, `scripts/fetch-whisper-model.sh`
- Modify: `electron-builder.yml` (microphone usage description), `src/renderer/components/Composer.tsx`

**Interfaces:**
- Produces:
  - Transcription runs on the Mac with whisper.cpp (MIT licence, free) and the `base.en` model, downloaded once by `scripts/fetch-whisper-model.sh` with its SHA-256 checked. `function transcribe(wavPath: string, options: Readonly<{ binary: string; model: string; exec?: ExecFile }>): Promise<string>` with a timeout of `TRANSCRIBE_TIMEOUT_MS = 30 * 1000`.
  - `PUSH_TO_TALK_KEY` is a named setting (default: hold the right ⌥ key). Holding it records 16 kHz mono audio with `getUserMedia`; releasing it transcribes, puts the text in the composer and sends it. Whether a spoken message carries ⌘I context is the setting `VOICE_SENDS_CONTEXT` (open question below). When it does, the context is read at the moment the key goes down, because that is when the user was reading.
  - `MAX_RECORDING_MS = 2 * 60 * 1000`; recording stops there with the note "Recording stopped at 2 minutes".
  - Microphone permission is requested with `systemPreferences.askForMediaAccess("microphone")`; a refusal shows "Margin needs microphone access. Open System Settings › Privacy & Security › Microphone" and records nothing.

- [ ] **Step 1: Write the failing tests** (fake recorder, fake transcriber exec).
  - `release_transcribes_and_sends`; `release_after_under_300_ms_sends_nothing`.
  - `context_is_read_at_key_down_not_key_up` (scroll between the two must not change it).
  - `denied_microphone_shows_the_settings_path`.
  - `transcriber_timeout_names_the_limit`.
  - `whisper_model_with_a_wrong_hash_is_rejected`.
- [ ] **Step 2–4: Fail, implement, pass.** Manual check: dictate the film's question "does this look right?" five times and record the word error and the time from key release to send in `docs/spikes/voice.md`.
- [ ] **Step 5: Commit.** `git commit -m "feat(voice): add push-to-talk dictation"`

### Task 23: Read answers aloud

**Files:**
- Create: `src/renderer/voice/read-aloud.ts`, `tests/renderer/read-aloud.test.ts`

**Interfaces:**
- Produces: a speaker button on each answer, and the setting `READ_ANSWERS_ALOUD` (default off; on means every spoken question's answer is read). Speech uses the macOS system voices through the Web Speech API `speechSynthesis`; code blocks are skipped and replaced by "code block, N lines". Pressing Esc stops speech.

- [ ] **Step 1: Tests** `code_blocks_are_not_read_verbatim`, `escape_stops_speech`, `answers_to_typed_questions_are_not_read_by_default`. Fail, implement, pass. Confirm by hand that `speechSynthesis.getVoices()` returns system voices inside Electron on macOS 14; if it does not, stop and report rather than add another speech engine.
- [ ] **Step 2: Commit.** `git commit -m "feat(voice): read answers aloud"`

### Task 24 (optional): Live spoken conversation with Codex

This uses an experimental Codex API and works only for Codex chats. Do it after Tasks 22 and 23 have been used for a while.

**Files:**
- Create: `spikes/probe-realtime.mjs`, `docs/spikes/realtime.md`, `src/codex/realtime-session.ts`, `tests/codex/realtime-session.test.ts`

- [ ] **Step 1: Spike.** Regenerate bindings with `--experimental`. Start `thread/realtime/start` with `transport: { type: "webrtc", sdp }`, `outputModality` audio, and a voice from `thread/realtime/listVoices`. Record whether Helen's ChatGPT plan allows it, the delay from end of speech to first audio, and whether ⌘I context can be added with `thread/realtime/appendText` before speaking. Stop and report if the plan does not allow it.
- [ ] **Step 2: Build** a "Talk" button on Codex chats that opens a realtime session for the current thread, shows the live transcript from `thread/realtime/transcript/delta`, and ends with `thread/realtime/stop`. Tests use `FakeAppServer` for start, transcript, error and close; a `thread/realtime/error` notification shows its message and ends the session.
- [ ] **Step 3: Commit.** `git commit -m "feat(voice): add live spoken conversation for codex chats"`

## Risks and open questions

| Risk | Effect | What the plan does |
| --- | --- | --- |
| OpenAI's terms do not clearly allow a non-Codex app to use a ChatGPT plan through Codex sign-in. Reports say OpenAI allows this flow for Codex tooling; Margin is a chat app. | The ChatGPT sign-in path could be blocked or against the terms. | API-key sign-in works through the same app-server and is always offered. Check OpenAI's current terms before a public release and state the position in `README.md`. |
| The app-server protocol is labelled experimental and may change between Codex releases. | An upgrade could break Margin. | Exact version pin, generated bindings, `bindings:check` in CI, protocol tests against `FakeAppServer`. |
| The shell tool may not be removable (Task 0). | The model could run read-only commands in Margin's empty folder. | `cwd` is an empty Margin-owned folder, the sandbox is read-only, approvals are declined, and instructions forbid commands. Command items are hidden from the thread and logged. |
| First-token delay is unmeasured. | The product's main promise could fail. | Task 0 measures it and gates the build. |
| Codex shares `~/.codex` with the user's own Codex CLI. | Signing out in Margin signs out the CLI too. | Settings says so next to the Sign out button. A separate `CODEX_HOME` is a later option, not in this plan. |
| Claude Pro and Max subscribers expect to sign in with claude.ai. | They may think Claude sign-in is missing. | The sign-in screen says that Anthropic does not allow claude.ai login in other apps, and that Max, Ultra and Team plans include monthly API credits usable through a Claude Console sign-in. Ask Anthropic for approval before ever adding claude.ai login. |
| Thinking cannot be turned off on `claude-opus-5-5`. | The first text token may arrive later than with Codex. | Task 16 measures it at effort `low` and `medium`; the effort setting is exposed in Settings. The model is not changed without Helen's decision. |
| Codex takes no PDF input. | A PDF sent to a Codex chat loses its figures and layout. | Margin sends the extracted text and labels it "text only"; Claude chats receive the PDF itself. |
| Should a spoken message carry ⌘I context by default? | Wrong default either surprises the user or loses the reading context. | Open question for Helen; `VOICE_SENDS_CONTEXT` is a setting until she decides. |
| Live voice relies on an experimental Codex API and an unknown plan entitlement. | It may change or be unavailable. | Task 24 is optional, starts with a spike, and stops if the plan does not allow it. |
| Claude conversations live in Margin's own files, not on a server. | Losing the folder loses the history; the files hold the user's text in plain JSON. | Atomic writes; `PRIVACY.md` names the folder; deleting a chat deletes its file. |

## Out of scope for this plan

- Reading other apps' windows (would need macOS Accessibility permission or screenshots).
- Windows and Linux builds.
- Code signing and notarisation (needed before distributing to people who do not build it themselves).
- A separate `CODEX_HOME` for Margin.
- claude.ai (Pro, Max) sign-in, unless Anthropic approves it for Margin.
- Plugins, skills, MCP servers, apps and artifacts.
- Copying OpenAI's logos, icons or other brand assets; Margin matches Codex's layout only.
- Live spoken conversation with Claude (the Messages API has no audio).
- Claude through Amazon Bedrock, Google Cloud or Microsoft Foundry.
