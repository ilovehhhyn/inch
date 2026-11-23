# Privacy

This page says what Margin reads, where it sends it, and what it keeps on your Mac.

## What Margin reads

Margin reads text from its own window only, and only when you press ⌘I. It reads the pane you scrolled last, or the pane that has keyboard focus when you have not scrolled. It reads no other pane, no other app and no file on your disk. It takes no screenshot and runs no text recognition.

Enter sends your question alone. Nothing is read.

## Where it goes

For an OpenAI chat, the question and the text read on ⌘I go to OpenAI through the Codex app-server on your Mac, as one message. Codex's own privacy terms and your OpenAI account settings apply to that message. Margin does not send it anywhere else.

## What Margin stores on your Mac

| What | Where | Contents |
| --- | --- | --- |
| Chat history | `~/.codex/sessions` (kept by Codex) | Your questions, the context sent with ⌘I, and the answers. Margin's chats appear in your Codex history. |
| OpenAI credentials | `~/.codex` (kept by Codex) | Margin never reads or stores them. |
| Window layout | `~/Library/Application Support/Margin/layout.json` | Panel width, the folder chosen for the diff pane, and which side chats are open. |
| Timing metrics | `~/Library/Application Support/Margin/metrics.jsonl` | One line per ⌘I send: time, pane kind, block count, context length and three durations in milliseconds. No text. |
| Empty working directory | `~/Library/Application Support/Margin/empty-workspace` | Nothing. Codex threads start here so there is no project of yours to read. |

Margin sends no analytics and makes no network request of its own for OpenAI chats.

## What this page does not cover

It does not describe what OpenAI does with a message after it arrives. Read OpenAI's terms for that.
