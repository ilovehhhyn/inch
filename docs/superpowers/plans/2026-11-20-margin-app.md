# Margin desktop app implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Margin, an open-source macOS desktop chat app in which pressing ⌘I sends the question together with the text visible in the pane the user scrolled last, using the local Codex app-server for ChatGPT sign-in and model calls.

**Architecture:** An Electron app. The main process starts `codex app-server` as a child process and speaks its JSON-RPC protocol over stdio, using TypeScript bindings generated from the pinned Codex version. The renderer draws every pane itself (main chat, side chats, code diff), so on ⌘I it reads the exact visible text from its own DOM, with no screenshot and no text recognition. Pure functions choose and format that context; the input/output shell around them is thin.

**Tech stack:** Electron, TypeScript, React, Vite (`electron-vite`), Vitest with Testing Library, Playwright for Electron end-to-end tests, `electron-builder` for the `.dmg`. Codex CLI 0.146.0 as an external, user-installed dependency.

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

## Product spec

1. Margin looks like a standard chat app: a sidebar of chats, a centred main thread, a rounded composer. It shows **no Margin logo, avatar or name** inside answers or the composer.
2. **Enter** sends the message without screen context. **⌘I** sends it with screen context. Nothing on screen changes when ⌘I is pressed: no chip, no scan effect, no attachment.
3. The context is the text visible in **the pane the user scrolled last**. If the user has not scrolled any pane since their previous message, the context comes from the pane that has keyboard focus.
4. Inside that pane, visible blocks are weighted by distance from the pane's vertical centre; the centre block is always included.
5. Panes: the main chat; any number of side chats (each forked from the main chat); one code-diff pane showing `git diff` for a folder the user chooses. The right-hand panel stacks the diff above the side chats.
6. The answer appears in the thread where the user typed. The assistant names what it read in its first sentence (section, message, file and line).
7. Diff context carries file names and new-file line numbers, so answers can cite `get_lr()` on line 39.
8. Sign-in goes through the Codex app-server: ChatGPT browser login, ChatGPT device code, or an OpenAI API key typed by the user.
9. Margin never runs commands or edits files on the user's behalf.
10. Nothing on screen is read until ⌘I. Only the chosen pane is read.

## Global constraints

- Platform: macOS 14 or later on Apple silicon for the first release.
- Codex: require exactly `codex-cli 0.146.0` (`SUPPORTED_CODEX_VERSION`). A different or missing version is a hard error at startup naming the install command. Upgrading Codex means regenerating bindings and rerunning the protocol tests in the same commit.
- Pin every npm dependency to an exact version in `package.json` and commit `package-lock.json`. Versions are chosen in Task 1 and recorded there; no ranges.
- Context budget: `CONTEXT_BUDGET_CHARS = 12_000` (about 3,000 tokens), a named constant with that reason beside it.
- Capture budget: reading context on ⌘I must take under `CAPTURE_BUDGET_MS = 20` on the end-to-end fixture.
- Every thread Margin creates uses `sandbox: "read-only"`, `approvalPolicy: "never"`, and `cwd` set to Margin's own empty directory `~/Library/Application Support/Margin/empty-workspace`.
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
    main/
      main.ts                       Electron entry: window, menus, lifecycle.
      ipc.ts                        Typed IPC handlers that expose the Codex client to the renderer.
      git-diff.ts                   Runs `git diff` for a chosen folder with bounded output.
      layout-store.ts               Atomic read/write of panel layout and diff folder.
    shared/
      ipc-contract.ts               Channel names and payload types shared by main and renderer.
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
  - `function reduceThread(state: ThreadView, notification: ServerNotification): ThreadView` where `ThreadView = Readonly<{ messages: ReadonlyArray<DisplayMessage>; activeTurn: TurnId | null; error: string | null }>` and `DisplayMessage = Readonly<{ id: string; role: "user" | "assistant"; text: string; status: "streaming" | "done" | "failed" }>`
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

## Risks and open questions

| Risk | Effect | What the plan does |
| --- | --- | --- |
| OpenAI's terms do not clearly allow a non-Codex app to use a ChatGPT plan through Codex sign-in. Reports say OpenAI allows this flow for Codex tooling; Margin is a chat app. | The ChatGPT sign-in path could be blocked or against the terms. | API-key sign-in works through the same app-server and is always offered. Check OpenAI's current terms before a public release and state the position in `README.md`. |
| The app-server protocol is labelled experimental and may change between Codex releases. | An upgrade could break Margin. | Exact version pin, generated bindings, `bindings:check` in CI, protocol tests against `FakeAppServer`. |
| The shell tool may not be removable (Task 0). | The model could run read-only commands in Margin's empty folder. | `cwd` is an empty Margin-owned folder, the sandbox is read-only, approvals are declined, and instructions forbid commands. Command items are hidden from the thread and logged. |
| First-token delay is unmeasured. | The product's main promise could fail. | Task 0 measures it and gates the build. |
| Codex shares `~/.codex` with the user's own Codex CLI. | Signing out in Margin signs out the CLI too. | Settings says so next to the Sign out button. A separate `CODEX_HOME` is a later option, not in this plan. |

## Out of scope for this plan

- Reading other apps' windows (would need macOS Accessibility permission or screenshots).
- Windows and Linux builds.
- Code signing and notarisation (needed before distributing to people who do not build it themselves).
- A separate `CODEX_HOME` for Margin.
