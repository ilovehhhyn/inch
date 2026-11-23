// Writes decoded audio as the 16 kHz mono 16-bit PCM WAV file that whisper.cpp reads.
import { BYTES_PER_SAMPLE, SAMPLE_RATE_HZ } from "../../shared/speech";

const HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const CHANNELS = 1;
const BITS_PER_SAMPLE = BYTES_PER_SAMPLE * 8;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
}

/** Scales each sample s in [-1, 1] to round-toward-zero s * 32768 for s < 0 and s * 32767 otherwise, clamping values outside that range. */
export function encodeWav(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE_HZ, true);
  view.setUint32(28, SAMPLE_RATE_HZ * BYTES_PER_SAMPLE * CHANNELS, true);
  view.setUint16(32, BYTES_PER_SAMPLE * CHANNELS, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(HEADER_BYTES + index * BYTES_PER_SAMPLE, Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  });
  return bytes;
}
