import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAX_BYTES = 1_000_000;
const PHOTO = new URL("../fixtures/home-photo.jpg", import.meta.url);

// The request the witness builds from a fixture: the file as base64 inside a dry-run JSON request.
const wrap = (bytes, field, text) => JSON.parse(JSON.stringify({ dry_run: true, [field]: bytes.toString("base64"), ...(text && { text }) }));

test("the voice note is a WAV that muse-voice-transcribe takes: PCM, mono, 16-bit, 24 kHz", () => {
  const wav = readFileSync(new URL("../fixtures/voice-note.wav", import.meta.url));
  assert.ok(wav.length > 1000 && wav.length < MAX_BYTES, `${wav.length} bytes`);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "one channel");
  assert.equal(wav.readUInt32LE(24), 24000, "24 kHz");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  const seconds = (wav.length - 44) / (24000 * 2);
  assert.ok(seconds > 3 && seconds < 30, `${seconds.toFixed(1)} s`);
  assert.equal(wrap(wav, "audio_base64").audio_base64.length, Math.ceil(wav.length / 3) * 4);
});

test("the home photo is a JPEG under 1 MB with no camera details", () => {
  const jpg = readFileSync(PHOTO);
  assert.ok(jpg.length > 1000 && jpg.length < MAX_BYTES, `${jpg.length} bytes`);
  assert.equal(jpg.readUInt16BE(0), 0xffd8, "JPEG");
  assert.equal(jpg.includes(Buffer.from("Exif\0\0")), false, "no EXIF");
  assert.ok(wrap(jpg, "image_base64", "Please clean this place.").image_base64.length > 1000);
});
