// Invariant: a recording is written as a 16 kHz mono 16-bit PCM WAV file that whisper.cpp reads: a 44-byte header that states the sizes exactly, then the clamped samples.
import { expect, test } from "vitest";

import { encodeWav } from "../../src/shared/wav";
import { BYTES_PER_SAMPLE, SAMPLE_RATE_HZ } from "../../src/shared/speech";

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder("latin1").decode(bytes.subarray(start, start + length));
}

test("the_header_states_pcm_mono_16_khz_and_exact_sizes", () => {
  const wav = encodeWav(new Float32Array(100));
  const header = view(wav);

  expect(wav.length).toBe(44 + 100 * BYTES_PER_SAMPLE);
  expect(ascii(wav, 0, 4)).toBe("RIFF");
  expect(header.getUint32(4, true)).toBe(wav.length - 8);
  expect(ascii(wav, 8, 4)).toBe("WAVE");
  expect(ascii(wav, 12, 4)).toBe("fmt ");
  expect(header.getUint32(16, true)).toBe(16);
  expect(header.getUint16(20, true)).toBe(1);
  expect(header.getUint16(22, true)).toBe(1);
  expect(header.getUint32(24, true)).toBe(SAMPLE_RATE_HZ);
  expect(header.getUint32(28, true)).toBe(SAMPLE_RATE_HZ * BYTES_PER_SAMPLE);
  expect(header.getUint16(32, true)).toBe(BYTES_PER_SAMPLE);
  expect(header.getUint16(34, true)).toBe(16);
  expect(ascii(wav, 36, 4)).toBe("data");
  expect(header.getUint32(40, true)).toBe(100 * BYTES_PER_SAMPLE);
});

test("samples_are_scaled_to_signed_16_bit_and_clamped_at_full_scale", () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -3]));
  const header = view(wav);
  const samples = Array.from({ length: 7 }, (_, index) => header.getInt16(44 + index * 2, true));

  expect(samples).toEqual([0, 16383, -16384, 32767, -32768, 32767, -32768]);
});

test("an_empty_recording_is_a_valid_header_with_no_samples", () => {
  const wav = encodeWav(new Float32Array(0));

  expect(wav.length).toBe(44);
  expect(view(wav).getUint32(40, true)).toBe(0);
});
