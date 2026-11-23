# Privacy

This page says what Margin reads, where it sends it, and what it keeps on your Mac.

## What Margin reads

Margin reads text from its own window only, and only when you press ⌘I. It reads the pane you scrolled last, or the pane that has keyboard focus when you have not scrolled. It reads no other pane, no other app and no file on your disk. It takes no screenshot and runs no text recognition.

Enter sends your question alone. Nothing is read.

## Where it goes

For an OpenAI chat, the question and the text read on ⌘I go to OpenAI through the Codex app-server on your Mac, as one message. Codex's own privacy terms and your OpenAI account settings apply to that message. Margin does not send it anywhere else.

For a Claude chat, the question and the text read on ⌘I go to Anthropic through the Anthropic API, in one user message. The whole earlier conversation of that chat is sent again with every message, because the API keeps no conversation. Anthropic's terms for the API and your Anthropic account settings apply. A request may also ask Anthropic to retry on another model when the first one declines it.

## What Margin stores on your Mac

| What | Where | Contents |
| --- | --- | --- |
| Chat history | `~/.codex/sessions` (kept by Codex) | Your questions, the context sent with ⌘I, and the answers. Margin's chats appear in your Codex history. |
| OpenAI credentials | `~/.codex` (kept by Codex) | Margin never reads or stores them. |
| Claude chats | `~/Library/Application Support/Margin/claude-threads`, one JSON file per chat | Your questions, the context sent with ⌘I, and Claude's answers, as plain JSON that is not encrypted. Anyone who can read your home folder can read these files. Delete a file to delete that chat. |
| Anthropic API key | `~/Library/Application Support/Margin/secrets` | The key, encrypted with Electron safeStorage (your macOS keychain protects the encryption key). The key is never sent to the window and never written to a log. |
| Claude Console login | `~/.config/anthropic` (kept by `ant`) | A short-lived token in the `margin` profile. Margin reads it through `ant`. Signing out of Claude logs out of that profile only. |
| Window layout | `~/Library/Application Support/Margin/layout.json` | Panel width, the folder chosen for the diff pane, and which side chats are open. |
| Timing metrics | `~/Library/Application Support/Margin/metrics.jsonl` | One line per ⌘I send: time, pane kind, block count, context length and three durations in milliseconds. No text. |
| Empty working directory | `~/Library/Application Support/Margin/empty-workspace` | Nothing. Codex threads start here so there is no project of yours to read. |

Margin sends no analytics. Its own network requests are the Claude requests above, and one model-list request that checks a typed Anthropic API key before it is saved.

## What this page does not cover

It does not describe what OpenAI or Anthropic does with a message after it arrives. Read their terms for that.
