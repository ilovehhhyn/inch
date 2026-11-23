# Margin

Margin is a desktop chat app that answers questions about whatever you were reading when you pressed ⌘I.

You type a question as usual. Enter sends it on its own. ⌘I sends it together with the text visible in the pane you scrolled last: an earlier answer in the same chat, a side chat, or a code diff. Nothing on screen changes when you press ⌘I.

## Requirements

- macOS 14 or later on Apple silicon.
- `codex-cli 0.146.0`, installed with `npm install -g @openai/codex@0.146.0`. Margin refuses to start with any other version and says so in the window.
- An OpenAI account that Codex can use: a ChatGPT plan or an OpenAI API key.

## Install

1. Build the disk image (see Build below) or take `Margin-<version>-arm64.dmg` from a tagged build.
2. Open the disk image and drag Margin to Applications.
3. The app is not signed or notarized. On the first launch, open it from the Applications folder with a right click and choose Open.

## Sign in

Margin reuses your Codex login. If `codex` is already signed in, Margin opens straight to the chat. Otherwise the sign-in screen offers three ways: ChatGPT in the browser, a ChatGPT device code, or an OpenAI API key. Margin never stores an OpenAI token. Codex keeps its credentials in `~/.codex`.

## The ⌘I rule

1. Enter sends the message with no screen context.
2. ⌘I sends the message with the text visible in the pane you scrolled last. If you have not scrolled any pane since your previous message, it reads the pane that has keyboard focus.
3. Inside that pane the blocks nearest the vertical centre are kept first. The context is at most 12,000 characters.
4. Panes are the main chat, each side chat and the code diff. Only the chosen pane is read, and only when you press ⌘I.
5. The answer begins by naming what it read, such as `train.py line 39`.

## What Margin does not do

- It does not read the screen outside its own window.
- It does not run commands or edit files. Every thread is read-only, with approvals declined, in an empty working directory.
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
| `npm run test:e2e` | Builds the app and runs the Playwright tests against a scripted stand-in for Codex. |

The environment variable `MARGIN_CODEX_PATH` makes Margin run that executable instead of searching the `PATH`. The end-to-end tests set it. The executable must still report `codex-cli 0.146.0`.

Each Command-I send appends one line of numbers to `metrics.jsonl` in `~/Library/Application Support/Margin`: the pane kind, block count, context length and three durations. It holds no text.

## Repository contents

| Path | What it is |
| --- | --- |
| `src/` | The app: `codex/` (app-server client), `main/` (Electron main process), `renderer/` (window), `shared/` (types both sides use). |
| `tests/` | Unit tests, fakes, and `e2e/` Playwright tests. |
| `docs/spec.md` | The product rules. |
| `docs/spikes/` | Measurements that settled design questions, with raw data. |
| `docs/superpowers/plans/2026-11-20-margin-app.md` | The implementation plan. |
| `demo/` | The 52-second concept film (`margin-demo.mp4`), the page it is rendered from (`margin-launch.html`) and the render script (`render-film.mjs`). |
| `spikes/` | Scripts that probe Codex. |

To render the film again, run `cd demo && npm install && npm run render`. It needs Google Chrome at its default macOS path.

## Status and limits

- Time to the first word of an answer was measured on one machine with a small sample. See `docs/spikes/codex-app-server.md` for the numbers and their limit.
- Codex keeps its own OpenAI credentials in `~/.codex`. Margin stores no OpenAI secret.
- Terms question, open: OpenAI's terms do not clearly say whether a non-Codex app may use a ChatGPT plan through Codex sign-in. API-key sign-in is the alternative that avoids the question.
- The Codex app-server and its generated bindings are marked experimental by Codex. A different Codex version needs regenerated bindings and a rerun of the protocol tests.
- Thread history of Margin's chats appears in your Codex history under `~/.codex/sessions`.
