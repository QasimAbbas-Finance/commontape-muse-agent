import { test } from "node:test";
import assert from "node:assert/strict";
import { createModel, stubUnderstand, ModelError, STUB_NAME } from "../lib/model.js";
import { windowPicker } from "../lib/plan.js";

test("the stand-in reads the typed request the witness sends", () => {
  assert.deepEqual(stubUnderstand("I need a standard clean for my 2-bedroom, 1-bathroom apartment in ZIP 10001, any morning next week."), {
    about_cleaning: true, zip: "10001", service_key: "house_cleaning.standard", home_type: "property.apartment",
    bedrooms: 2, full_bathrooms: 1, part_of_day: "morning", next_week: true,
  });
});

test("the stand-in reads a budget, a spoken ZIP, half bathrooms and the kind of clean", () => {
  assert.equal(stubUnderstand("Standard clean for my 2-bedroom, 1-bathroom apartment in ZIP 10001 next week, but I can only pay 40 dollars in total.").max_total, 40);
  assert.equal(stubUnderstand("A clean, budget $95.50").max_total, 95.5);
  assert.equal(stubUnderstand("hi i need a clean in zip code one zero zero zero one").zip, "10001");
  const house = stubUnderstand("Deep clean of my house, three bedrooms, two full bathrooms and one half bath");
  assert.deepEqual([house.service_key, house.home_type, house.bedrooms, house.full_bathrooms, house.half_bathrooms],
    ["house_cleaning.deep", "property.detached_house", 3, 2, 1]);
  assert.equal(stubUnderstand("Move-out clean please").service_key, "house_cleaning.move_in_out");
  assert.equal(stubUnderstand("I need house cleaning").home_type, undefined);
});

test("the stand-in does not take a request that is not about cleaning", () => {
  assert.equal(stubUnderstand("Book me a table for two in ZIP 10001").about_cleaning, false);
});

test("the stand-in is chosen without a key and names itself, so it is never mistaken for Muse", () => {
  const stub = createModel({});
  assert.equal(stub.name, STUB_NAME);
  assert.equal(stub.transcribe, null);
  assert.throws(() => createModel({ MODEL_MODE: "muse" }), ModelError);
  assert.equal(createModel({ MODEL_API_KEY: "test-key" }).name, "muse-spark-1.3");
  assert.equal(createModel({ MODEL_API_KEY: "test-key", MODEL_MODE: "stub" }).name, STUB_NAME);
});

test("Muse Spark gets the search tool and the photo, and its tool call is the job", async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), auth: new Headers(init.headers).get("authorization") });
    return Response.json({ id: "c1", object: "chat.completion", created: 0, model: "muse-spark-1.3", choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "search_cleaners",
        arguments: JSON.stringify({ about_cleaning: true, zip: "10001", bedrooms: 2, seen_in_photo: "A messy kitchen." }) } }] } }] });
  };
  const muse = createModel({ MODEL_API_KEY: "test-key" }, { fetch });
  const job = await muse.understand({ text: "Clean this, ZIP 10001", image_base64: "/9j/AAAA" });
  assert.deepEqual(job, { about_cleaning: true, zip: "10001", bedrooms: 2, seen_in_photo: "A messy kitchen." });
  assert.equal(sent[0].url, "https://api.meta.ai/v1/chat/completions");
  assert.equal(sent[0].auth, "Bearer test-key");
  assert.equal(sent[0].body.model, "muse-spark-1.3");
  assert.equal(sent[0].body.tools[0].function.name, "search_cleaners");
  assert.deepEqual(sent[0].body.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } });
});

test("Muse Spark answering without the tool means the request is not a cleaning job", async () => {
  const fetch = async () => Response.json({ id: "c2", object: "chat.completion", created: 0, model: "muse-spark-1.3",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "I can only help with cleaning." } }] });
  assert.equal((await createModel({ MODEL_API_KEY: "k" }, { fetch }).understand({ text: "a table for two" })).about_cleaning, false);
});

test("a voice note goes to Muse Voice Transcribe as the cookbook sends it: a JSON part, then the WAV", async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url, init }; return Response.json({ sessionId: "s", transcript: " a clean in ZIP 10001 ", turns: [] }); };
  const muse = createModel({ MODEL_API_KEY: "k" }, { fetch });
  assert.equal(await muse.transcribe(Buffer.from("RIFF-audio").toString("base64")), "a clean in ZIP 10001");
  assert.equal(sent.url, "https://api.meta.ai/v1/asr/transcribe");
  assert.equal(sent.init.headers.authorization, "Bearer k");
  const body = sent.init.body.toString("latin1");
  const boundary = sent.init.headers["content-type"].match(/boundary=(.+)$/)[1];
  assert.match(body, /name="request"\r\nContent-Type: application\/json\r\n\r\n\{"mode":"PUSH_TO_TALK","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"/);
  assert.match(body, /name="audio"; filename="voice-note.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF-audio\r\n/);
  assert.ok(body.endsWith(`--${boundary}--\r\n`));
  await assert.rejects(createModel({ MODEL_API_KEY: "k" }, { fetch: async () => new Response("no", { status: 401 }) }).transcribe("AAAA"), ModelError);
});

test("times asked for are matched in the business's own time zone", () => {
  const now = Date.parse("2026-10-26T12:00:00Z"); // Monday 8 AM in New York
  const windows = [
    { allocation_id: "past", window_start: "2026-10-26T11:00:00+00:00" },
    { allocation_id: "this-week-morning", window_start: "2026-10-27T13:00:00+00:00" },
    { allocation_id: "next-week-afternoon", window_start: "2026-11-02T19:00:00+00:00" },
    { allocation_id: "next-week-morning", window_start: "2026-11-03T14:00:00+00:00" },
    { allocation_id: "week-after", window_start: "2026-11-09T14:00:00+00:00" },
  ];
  const match = { timezone: "America/New_York" };
  const pick = (u) => windowPicker(u, now)(windows, match)?.allocation_id;
  assert.equal(pick({}), "this-week-morning");
  assert.equal(pick({ part_of_day: "morning", next_week: true }), "next-week-morning");
  assert.equal(pick({ part_of_day: "afternoon", next_week: true }), "next-week-afternoon");
  assert.equal(pick({ part_of_day: "evening" }), undefined);
});
