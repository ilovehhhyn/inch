// Reads the test-only setting that skips the macOS microphone prompt, which blocks until a person answers it.

/** Read once at start-up. End-to-end tests set it to `1` and replace `getUserMedia` in the window; unset means Margin asks macOS. */
export function readAssumedMicrophoneAccess(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env["MARGIN_ASSUME_MICROPHONE_ACCESS"];
  if (value === undefined) return false;
  if (value !== "1") throw new Error(`MARGIN_ASSUME_MICROPHONE_ACCESS must be 1 or unset, got \`${value}\`; unset it to let Margin ask macOS`);
  return true;
}
