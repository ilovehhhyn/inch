// Names the logging callback that Margin's main-process code receives, so tests can read what was logged.

export type Logger = (line: string) => void;
