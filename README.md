# CommonTape Muse Agent

Ask Meta's AI for a cleaner, get a real booking.

A person sends a voice note or a photo of their home. A Muse-powered agent
works out the job, finds local cleaning businesses that can do it, gets an
exact price, checks the booking before it makes it, and books a slot.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon),
26 Oct – 4 Nov 2026, startup track, theme "Build for Your World".

## What is new in this hackathon

Everything in this repository was written during the hackathon, starting
26 Oct 2026. The commit history is the record of it.

## What existed before

[CommonTape](https://commontape.com) is a live service where small cleaning
businesses publish their prices, service area and open times so AI agents
can book them. It is a separate, private product built before the
hackathon. This agent talks to it only through its public agent connection,
the same one any AI assistant uses. No CommonTape code is copied here.

## Meta models used

Through the Meta Model API (`https://api.meta.ai/v1`):

- `muse-spark-1.3`: the agent itself. It turns a request into a job,
  calls CommonTape's tools, reads photos of the home, and explains its plan.
- `muse-voice-transcribe-1.0`: turns a voice note into text.

## How it works

One endpoint, `POST /api/agent`, takes `text`, `audio_base64` or
`image_base64`, plus `dry_run`. Dry run is on unless the request says
`"dry_run": false`, and in a dry run nothing is ever held or booked. The
answer always has the same shape:

| Field | What it holds |
|---|---|
| `transcript` | the voice note as text, when there was one |
| `job` | the job the agent understood, as a CommonTape search |
| `options` | businesses that can do it, each with CommonTape's exact price and a time |
| `plan` | `book` or `none`, with the reason in plain words |
| `trace` | every model and tool call, in order |
| `booked` | the booking, when one was made |

## Run it locally

Needs Node 24 or newer.

```sh
npm install
npm test
npm run dev   # http://localhost:3000
npm run ct-search   # read-only: searches CommonTape's demo business, never holds or books
```

The CommonTape connection (`lib/commontape.js`) uses the demo key that
CommonTape publishes on its docs page. That key reaches only a pretend
business, "CommonTape Demo Cleaning", so trying this agent never books a
real cleaner. The client is read-only unless it is made otherwise, and a
dry run never makes it otherwise.

The sample voice note in `fixtures/` is made by `scripts/make-voice-note.sh`
with eSpeak NG's own voice, which anyone may use (the macOS voices are for
personal, non-commercial use only). The sample home photo will be made with
Muse Image, so no one's real home is published.

Copy `.env.example` to `.env.local` for settings. Never commit a key.

## Status

Day 1: the agent works end to end in its stand-in mode, which needs no Meta
key: a typed request becomes a CommonTape search, gets the demo business's
exact price at a time that fits, and goes through the safety check. The
stand-in names itself `stub-no-key` in the trace, so it is never mistaken
for Muse. Muse Spark and Muse Voice Transcribe are wired in and switch on
with the Meta key. Build log follows in the commits.
