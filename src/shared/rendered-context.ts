// Names the finished screen-context text a question carries to a provider; the renderer builds it, providers only send it.

/** `text` is the finished MARGIN SCREEN CONTEXT block, already trimmed to the context budget. */
export type RenderedContext = Readonly<{ text: string }>;
