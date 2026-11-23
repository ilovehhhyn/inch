# Margin

Margin is a desktop chat app that answers questions about whatever you were reading when you pressed ⌘I.

You type a question as usual. Enter sends it on its own. ⌘I sends it together with the text visible in the pane you scrolled last: an earlier answer in the same chat, a side chat, or a code diff. Nothing on screen changes when you press ⌘I.

Margin works with two providers. OpenAI chats run through the Codex app-server on your Mac. Claude chats run through the Anthropic API. Each chat belongs to one provider, chosen when the chat is created.

## Requirements

- macOS 14 or later on Apple silicon.
- `codex-cli 0.146.0`, installed with `npm install -g @openai/codex@0.146.0`. Margin refuses to start with any other version and says so in the window. This holds even if you only use Claude.
- For OpenAI chats: an OpenAI account that Codex can use, either a ChatGPT plan or an OpenAI API key.
- For Claude chats: an Anthropic API key, or a Claude Console account with the `ant` command installed (`brew install anthropics/tap/ant`).

## Install

1. Build the disk image (see Build below) or take `Margin-<version>-arm64.dmg` from a tagged build.
2. Open the disk image and drag Margin to Applications.
3. The app is not signed or notarized. On the first launch, open it from the Applications folder with a right click and choose Open.

## Sign in

The sign-in page lists both providers. You need one of them. The Accounts button in the sidebar opens the page again, so you can add the second provider or sign out.

**OpenAI.** Margin reuses your Codex login. If `codex` is already signed in, Margin opens straight to the chat. Otherwise the page offers ChatGPT in the browser, a ChatGPT device code, or an OpenAI API key. Margin never stores an OpenAI token. Codex keeps its credentials in `~/.codex`.

**Claude.** The page offers two ways. "Sign in with Claude Console" runs `ant auth login --profile margin`, which opens your browser and keeps a short-lived token in the `margin` profile of `ant`. "Use an Anthropic API key" checks the key with Anthropic (a model-list request, which uses no tokens) and then stores it encrypted with Electron safeStorage in `~/Library/Application Support/Margin/secrets`. Margin ignores `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the other `ANTHROPIC_` variables, and signing out touches only the `margin` profile. Margin does not offer a claude.ai (Pro or Max) login, because Anthropic does not allow that in third-party products without approval.

## The ⌘I rule

1. Enter sends the message with no screen context.
2. ⌘I sends the message with the text visible in the pane you scrolled last. If you have not scrolled any pane since your previous message, it reads the pane that has keyboard focus.
3. Inside that pane the blocks nearest the vertical centre are kept first. The context is at most 12,000 characters.
4. Panes are the main chat, each side chat and the code diff. Only the chosen pane is read, and only when you press ⌘I.
5. The answer begins by naming what it read, such as `train.py line 39`.

## What Margin does not do

- It does not read the screen outside its own window.
- It does not run commands or edit files. Every Codex thread is read-only, with approvals declined, in an empty working directory. Claude chats have no tools at all.
- It offers no plugins, skills, MCP servers or apps. Margin switches off the shell tool, apps, plugins and every MCP server found in your Codex configuration for its own threads.
- It does not read anything before you press ⌘I.

## Build

```bash
npm ci
npm run build
npx electron-builder --mac dmg --arm64
```

The disk image is written to `dist/Margin-<version>-arm64.dmg`. Signing and notarization are not configured.

## Development

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (Vitest). |
| `npm run typecheck` | TypeScript check. |
| `npm run lint` | ESLint. |
| `npm run bindings:check` | Checks that the committed Codex bindings match `codex-cli 0.146.0`. |
| `npm run test:e2e` | Builds the app and runs the Playwright tests against a scripted stand-in for Codex and a fake local Anthropic service. |

Two environment variables exist for the end-to-end tests. `MARGIN_CODEX_PATH` makes Margin run that executable instead of searching the `PATH`; it must still report `codex-cli 0.146.0`. `MARGIN_ANTHROPIC_BASE_URL` sends Claude requests to `http://127.0.0.1:<port>` or `http://localhost:<port>`; any other address is an error. Margin removes every other `ANTHROPIC_` variable from its own environment at start-up.

Each Command-I send appends one line of numbers to `metrics.jsonl` in `~/Library/Application Support/Margin`: the pane kind, block count, context length and three durations. It holds no text.

## Repository contents

| Path | What it is |
| --- | --- |
| `src/` | The app: `codex/` (app-server client), `claude/` (Anthropic client, chat files, `ant` and credentials), `main/` (Electron main process), `renderer/` (window), `shared/` (types both sides use). |
| `tests/` | Unit tests, fakes, and `e2e/` Playwright tests. |
| `docs/spec.md` | The product rules. |
| `docs/spikes/` | Measurements that settled design questions, with raw data. |
| `docs/superpowers/plans/2026-11-20-margin-app.md` | The implementation plan. |
| `demo/` | The 52-second concept film (`margin-demo.mp4`), the page it is rendered from (`margin-launch.html`) and the render script (`render-film.mjs`). |
| `spikes/` | Scripts that probe Codex and Claude. `probe-claude.mjs` sends paid requests and refuses to run without `MARGIN_SPIKE_USD_CAP`. |

To render the film again, run `cd demo && npm install && npm run render`. It needs Google Chrome at its default macOS path.

## Status and limits

- Time to the first word of an answer was measured for Codex on one machine with a small sample. See `docs/spikes/codex-app-server.md` for the numbers and their limit. For Claude it was not measured, and neither was the effort setting that Margin uses by default (`low`, provisional). See `docs/spikes/claude.md`.
- Claude sign-in through `ant` and through a Console account was tested only against a scripted stand-in, because `ant` is not installed on the development machine. Claude requests were tested against a fake local service and a mocked client, and never sent to Anthropic.
- A Claude chat that Anthropic declines is shown as declined. A request on `claude-opus-5-5` asks for the server-side fallback `default`, so Anthropic may answer on another model when it declines.
- Codex keeps its own OpenAI credentials in `~/.codex`. Margin stores no OpenAI secret.
- Terms question, open: OpenAI's terms do not clearly say whether a non-Codex app may use a ChatGPT plan through Codex sign-in. API-key sign-in is the alternative that avoids the question.
- The Codex app-server and its generated bindings are marked experimental by Codex. A different Codex version needs regenerated bindings and a rerun of the protocol tests.
- Thread history of Margin's chats appears in your Codex history under `~/.codex/sessions`.
