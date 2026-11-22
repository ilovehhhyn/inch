# Margin

Margin is a concept for a desktop chat app that answers questions about whatever you were reading when you pressed ⌘I.

You type a question as usual. Enter sends it on its own. ⌘I sends it together with the text visible in the pane you scrolled last: an earlier answer in the same chat, a side chat, or a code diff. Nothing on screen changes when you press ⌘I.

This repository holds the concept film and the build plan. The app itself is not built yet.

## Contents

| Path | What it is |
| --- | --- |
| `demo/margin-demo.mp4` | The 52-second concept film, 1920×1080, 30 fps. |
| `demo/margin-launch.html` | The film as a web page, with play and scrub controls, the product brainstorm, and the prompt that describes the film. Open it in a browser. |
| `demo/render-film.mjs` | Renders the page to the MP4 by seeking its timeline frame by frame. |
| `docs/superpowers/plans/2026-11-20-margin-app.md` | The implementation plan: an Electron app with two sign-in options, OpenAI through the local Codex app-server and Claude through the Anthropic API, plus attachments, model and reasoning pickers and voice, in 25 test-first tasks. |
| `spikes/probe-app-server.mjs` | A probe that starts `codex app-server` and checks sign-in, the model list and thread creation without sending a model turn. |

## Render the film again

The render script uses Google Chrome at its default macOS path and an ffmpeg binary from npm.

```bash
cd demo && npm install && npm run render
```

## Run the app-server probe

It needs Codex CLI 0.146.0 on your `PATH`.

```bash
node spikes/probe-app-server.mjs
```

## Status and limits

- The plan's first task measures the delay before the first word of an answer. That number has not been measured yet.
- OpenAI's terms do not clearly allow a non-Codex app to use a ChatGPT plan through Codex sign-in. The plan keeps API-key sign-in as an alternative.
