// Names the audio settings that the recorder in the window and the transcriber in the main process must agree on.

/** whisper.cpp reads 16 kHz mono audio (Helen, 2026-11-21: record 16 kHz mono). */
export const SAMPLE_RATE_HZ = 16_000;
export const BYTES_PER_SAMPLE = 2;
/** Recording stops here with the note "Recording stopped at 2 minutes". */
export const MAX_RECORDING_MS = 2 * 60 * 1000;
/** A press shorter than this is an accidental tap and sends nothing. */
export const MIN_RECORDING_MS = 300;
