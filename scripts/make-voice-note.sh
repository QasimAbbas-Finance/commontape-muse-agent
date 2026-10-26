#!/usr/bin/env bash
# Makes fixtures/voice-note.wav, the sample voice note the agent is tested with: mono, 16-bit, 24 kHz, the format
# muse-voice-transcribe-1.0 takes. Spoken by eSpeak NG's own voice (brew install espeak-ng ffmpeg), whose output
# anyone may use; not the macOS voices, whose licence allows personal, non-commercial use only. No MBROLA voices.
set -euo pipefail
cd "$(dirname "$0")/.."
TEXT="Hi. I need a standard clean for my two bedroom, one bathroom apartment, in zip code one zero zero zero one. Any morning next week works for me."
tmp=$(mktemp -t voice-note).wav
trap 'rm -f "$tmp"' EXIT
espeak-ng -v en-us -s 145 -w "$tmp" "$TEXT"
mkdir -p fixtures
ffmpeg -loglevel error -y -i "$tmp" -ac 1 -ar 24000 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact fixtures/voice-note.wav
echo "fixtures/voice-note.wav: $(wc -c < fixtures/voice-note.wav | tr -d ' ') bytes"
