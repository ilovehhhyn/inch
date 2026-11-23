# Margin product spec

Copied from the "Product spec" section of docs/superpowers/plans/2026-11-20-margin-app.md (Task 0, 2026-11-23). The plan is the source until this file is edited on its own.

1. Margin's interface is the one in the concept film, `demo/margin-launch.html` (Helen, 2026-11-21): a sidebar of chats, a centred thread, a rounded composer, and the right-hand panel with the diff above the side chat. Task 6 takes its measurements from that file. It shows **no Margin logo, avatar or name** inside answers or the composer.
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
13. Voice: hold the right ⌥ key to talk; the speech is transcribed on the Mac into the composer and sent with ⌘I context when the key is released. Answers can be read aloud. This works for both providers. A live spoken conversation (Task 24) is available for Codex chats only.
14. Margin offers no plugins, skills, MCP servers, apps or artifacts, even though the Codex app-server supports some of them.
9. Margin never runs commands or edits files on the user's behalf.
10. Nothing on screen is read until ⌘I. Only the chosen pane is read.
