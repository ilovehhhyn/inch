// Names the screen context a question carries; the renderer builds it, providers only send it.

/** `text` is the finished MARGIN SCREEN CONTEXT block, already trimmed to the context budget. */
export type ScreenContext = Readonly<{ text: string }>;
