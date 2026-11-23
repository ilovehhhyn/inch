# Interface reference

Margin's window follows the concept film in `demo/margin-launch.html` at 1:1 scale. This table lists each value in `src/renderer/theme.css`, the rule in the film that it comes from, and what differs. The product shows no logo, avatar or name inside answers or the composer (spec rule 1).

| Property | Value | Source rule in the film | Note |
| --- | --- | --- | --- |
| UI font | Geist, then Inter, then the system font | `:root --font-ui` | Geist 1.9.2 ships with the `geist` package and loads from the app. |
| Code font | Geist Mono, then the system monospace | `:root --font-mono` | Same package. |
| Window background | `#ffffff` | `:root --app` | The film's window frame and title bar are not drawn; the Electron window supplies them. |
| Soft background | `#f7f7f5` | `:root --app-soft` | Sidebar and file rows. |
| Line colour | `#e8e7e3` | `:root --app-line` | Sidebar edge and panel edge. |
| Ink | `#1d1d1b` | `:root --ink` | Text and the send button. |
| Sidebar width | 240 px | `.sidebar` | Padding 18 px 12 px, items 16 px. |
| Sidebar item | padding 9 px 10 px, radius 10 px, text `#55544f` | `.side-item` | The selected item is `#ebeae6`, weight 500 (`.side-item.on`). |
| Thread column | 720 px | `.main-col` | Centred in the space between the sidebar and the right panel; the film pins it 320 px from the area's left edge. |
| Thread text | 19 px, line height 1.62 | `.thread` | Padding 36 px 20 px above, gap 28 px between messages. |
| User bubble | `#f1f0ed`, radius 22 px, padding 11 px 20 px, at most 470 px wide | `.u` | Aligned to the right. |
| Answer paragraph | margin 0 0 14 px | `.a p` | Headings are 19 px, weight 600, margin 22 px 0 6 px (`.a h4`). |
| Inline code | Geist Mono 0.88 em on `#f1f0ed`, radius 4 px | `code, .w.c` | |
| Composer | height 64 px, radius 32 px, border `#e3e1db`, 24 px from the bottom, 10 px from each side | `.composer` | Grows with several lines; the film's composer is one line. |
| Composer text | 20 px | `.input` | Placeholder "Ask anything" in `#a7a6a0` (`.input.is-empty::before`). |
| Send button | 40 px circle, `#1d1d1b` | `.send` | |
| Right panel | 600 px, background `#fbfbf9`, left border `#e8e7e3` | `.side` | |
| Panel header | 48 px, 22 px side padding, weight 600 | `.pane-head` | |
| Diff pane | 430 px high, white | `.diff-pane` | |
| Diff row | Geist Mono 15 px, line height 26 px, text `#24292f` | `.diff` | |
| File row | 36 px, `#f6f8fa`, 14 px, weight 500 | `.file` | |
| Added row | `#e6ffec`, sign `#1a7f37` | `.dl.add` | |
| Deleted row | `#ffebe9`, sign `#cf222e` | `.dl.del` | |
| Line number gutter | 46 px, right aligned, `#8c959f` | `.dl .n` | Drawn with CSS content so it is not part of the row's text. |
| Side chat thread | 17 px, gap 18 px, padding 20 px 22 px 0 | `.chat-pane .thread` | |
| Side chat composer | 52 px high, radius 26 px, 16 px from each side, 14 px from the bottom | `.chat-pane .composer` | |
