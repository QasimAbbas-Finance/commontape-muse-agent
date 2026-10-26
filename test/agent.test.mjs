import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../api/agent.js";
import { handle, status } from "../lib/handler.js";
import { runAgent } from "../lib/agent.js";
import { createModel, ModelError, stubUnderstand } from "../lib/model.js";
import { bookingKeys } from "../lib/plan.js";

const CONTRACT_KEYS = ["dry_run", "transcript", "job", "options", "plan", "trace", "booked"];
const NOW = Date.parse("2026-10-26T12:00:00Z");
const TYPED = "I need a standard clean for my 2-bedroom, 1-bathroom apartment in ZIP 10001, any morning next week.";
const BUDGET = "Standard clean for my 2-bedroom, 1-bathroom apartment in ZIP 10001 next week, but I can only pay 40 dollars in total.";
const CUSTOMER = { name: "Sam Rivera", phone: "212 555 0147", service_address: "350 W 31st St, New York, NY 10001" };

// A stand-in CommonTape that answers like the demo business and records which clients were made and what they were asked.
function fakeCommonTape({ search, hold, book } = {}) {
  const made = [], calls = [];
  const answer = (name, fallback) => async (body) => { calls.push({ name, body }); return fallback(body); };
  const api = {
    search: answer("search", (body) => search ?? (body.max_total < 140
      ? { ok: true, status: 200, body: { matches: [], near_misses: [{ slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning",
        service_key: "house_cleaning.standard", reasons: [{ code: "over_max_total", label: "Price $140 is $100 over the $40 cap." }] }] } }
      : { ok: true, status: 200, body: { job: { read_back: ["Service: Standard clean, in ZIP 10001."] }, near_misses: [], matches: [{
        slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard", timezone: "America/New_York",
        quote: { amount: 140, currency: "USD", quote_token: "qt" },
        available_windows: [
          { allocation_id: "this-week", window_start: "2026-10-27T13:00:00+00:00", window_end: "2026-10-27T16:00:00+00:00" },
          { allocation_id: "next-week-morning", window_start: "2026-11-03T14:00:00+00:00", window_end: "2026-11-03T17:00:00+00:00" },
        ] }] } })),
    hold: answer("hold", () => hold ?? { ok: true, status: 200, body: { transaction_id: "t1", state: "held" } }),
    book: answer("book", () => book ?? { ok: true, status: 200, body: { transaction_id: "t1", state: "booked" } }),
    cancel: answer("cancel", () => ({ ok: true, status: 200, body: { state: "cancelled" } })),
  };
  return { made, calls, client: (readOnly) => { made.push(readOnly); return api; } };
}

const stub = createModel({});
const run = (input, ct) => runAgent(input, { model: stub, client: ct.client, now: NOW });
const post = (body, deps) => handle(new Request("http://localhost/api/agent", { method: "POST", body }), deps);

test("typed request, dry run: CommonTape's exact price at a morning next week, a trace, nothing held or booked", async () => {
  const ct = fakeCommonTape();
  const a = await run({ text: TYPED }, ct);
  for (const key of CONTRACT_KEYS) assert.ok(key in a, `missing ${key}`);
  assert.equal(a.dry_run, true);
  assert.deepEqual(a.job, { zip: "10001", service_key: "house_cleaning.standard", property: { type: "property.apartment", spaces: { "space.bedroom": 2, "space.bathroom.full": 1 } } });
  assert.deepEqual(ct.calls.map((c) => c.name), ["search"]);
  assert.deepEqual(ct.calls[0].body, a.job, "the job in the answer is exactly what CommonTape was asked");
  assert.equal(a.options[0].price.amount, 140);
  assert.equal(a.options[0].allocation_id, "next-week-morning");
  assert.equal(a.plan.action, "none");
  assert.match(a.plan.reason, /dry run.*I would book CommonTape Demo Cleaning, a standard clean, \$140, Tue, Nov 3, 9:00 AM EST/);
  assert.deepEqual(a.trace, [{ step: "model", name: "stub-no-key", input: "text" }, { step: "tool", name: "search", input: a.job }]);
  assert.equal(a.booked, null);
  assert.deepEqual(ct.made, [true], "only a read-only client was made");
  assert.equal("customer_ref" in a.job, false, "a dry run sends no customer label");
});

test("a budget below every price: plan none with CommonTape's reason", async () => {
  const a = await run({ text: BUDGET }, fakeCommonTape());
  assert.equal(a.job.max_total, 40);
  assert.deepEqual(a.options, []);
  assert.equal(a.plan.action, "none");
  assert.match(a.plan.reason, /\$100 over the \$40 cap/);
  assert.equal(a.near_misses[0].reasons[0].code, "over_max_total");
});

test("without a Meta key a voice note or a lone photo is answered honestly, with no search", async () => {
  const ct = fakeCommonTape();
  const voice = await run({ audio_base64: "UklGRgAAAA" }, ct);
  assert.match(voice.plan.reason, /Voice notes need a Meta model/);
  const photo = await run({ image_base64: "/9j/AAAA" }, ct);
  assert.match(photo.plan.reason, /Photos need a Meta model/);
  assert.equal(ct.calls.length, 0);
});

test("a model that hears audio gets the voice note itself, and what it heard is the transcript", async () => {
  const got = [];
  const hearing = { name: "muse-spark-open-1026", seesImages: true, hearsAudio: true, transcribe: null,
    understand: async (req) => { got.push(req); return { ...stubUnderstand(TYPED), heard: ` ${TYPED} ` }; } };
  const ct = fakeCommonTape();
  const a = await runAgent({ audio_base64: "UklGRgAAAA" }, { model: hearing, client: ct.client, now: NOW });
  assert.deepEqual(got, [{ text: "", image_base64: undefined, audio_base64: "UklGRgAAAA" }]);
  assert.equal(a.transcript, TYPED);
  assert.deepEqual(a.trace[0], { step: "model", name: "muse-spark-open-1026", input: "audio" });
  assert.equal(a.options[0].price.amount, 140);
  const s = await status({ BASETEN_API_KEY: "test-key" }).json();
  assert.deepEqual([s.meta_model_connected, s.models, s.hears_voice, s.sees_photos], [true, ["muse-spark-open-1026"], true, true]);
  assert.doesNotMatch(JSON.stringify(s), /test-key/);
});

test("a request with no ZIP or not about cleaning is never searched", async () => {
  const ct = fakeCommonTape();
  assert.equal((await run({ text: "A standard clean for my flat please" }, ct)).plan.reason, "A 5-digit US ZIP code is needed.");
  assert.match((await run({ text: "Book a table for two in 10001" }, ct)).plan.reason, /only book home cleaning/);
  assert.equal(ct.calls.length, 0);
});

test("when CommonTape's search fails, nothing is booked and the reason says so", async () => {
  const ct = fakeCommonTape({ search: { ok: false, status: 0, body: { error: { message: "CommonTape could not be reached" } } } });
  const a = await run({ text: TYPED, dry_run: false, customer: CUSTOMER }, ct);
  assert.equal(a.plan.action, "none");
  assert.match(a.plan.reason, /could not be reached/);
});

test("a real booking: one hold and one book, with keys from the request, and the booking in the answer", async () => {
  const ct = fakeCommonTape();
  const input = { text: TYPED, dry_run: false, customer: CUSTOMER };
  const a = await run(input, ct);
  assert.equal(a.plan.action, "book");
  assert.deepEqual(ct.calls.map((c) => c.name), ["search", "hold", "book"]);
  const keys = bookingKeys(input);
  assert.deepEqual(ct.calls[1].body, { quote_token: "qt", allocation_id: "next-week-morning", idempotency_key: keys.hold });
  assert.deepEqual(ct.calls[2].body, { transaction_id: "t1", customer: CUSTOMER, idempotency_key: keys.book });
  assert.deepEqual(a.booked, { transaction_id: "t1", state: "booked", business: "CommonTape Demo Cleaning", price: { amount: 140, currency: "USD" }, window_start: "2026-11-03T14:00:00+00:00" });
  assert.deepEqual(a.trace.map((t) => t.name), ["stub-no-key", "search", "hold", "book"]);
  assert.deepEqual(ct.made, [true, false]);
  assert.match(ct.calls[0].body.customer_ref, /^cust-[0-9a-f]{24}$/, "a real booking labels the customer for CommonTape");
  assert.equal(JSON.stringify(ct.calls[0].body).includes("Sam"), false, "the label says nothing about them");
});

test("the same request sent again is not booked twice, and the reason says so in plain words", async () => {
  const ct = fakeCommonTape({ hold: { ok: false, status: 409, body: { error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "This idempotency key was already used with a different request." } } } });
  const a = await run({ text: TYPED, dry_run: false, customer: CUSTOMER }, ct);
  assert.equal(a.booked, null);
  assert.equal(a.plan.reason, "This exact request was already booked once, so it was not booked again.");
  assert.deepEqual(ct.calls.map((c) => c.name), ["search", "hold"]);
});

test("with nothing said about the home, CommonTape cannot price it, and the plan asks for the rooms", async () => {
  const ct = fakeCommonTape({ search: { ok: true, status: 200, body: { merchants: [{ slug: "commontape-demo-cleaning" }] } } });
  const a = await run({ text: "Please clean my place in ZIP 10001", dry_run: false, customer: CUSTOMER }, ct);
  assert.equal(a.plan.action, "none");
  assert.match(a.plan.reason, /how many bedrooms and bathrooms/);
  assert.deepEqual(ct.calls.map((c) => c.name), ["search"]);
});

test("a real request without the customer's details is not booked", async () => {
  const ct = fakeCommonTape();
  const a = await run({ text: TYPED, dry_run: false }, ct);
  assert.equal(a.plan.reason, "To book, I need your name, a phone number and the address to clean.");
  assert.deepEqual(ct.calls.map((c) => c.name), ["search"]);
});

test("if CommonTape refuses the book, the hold is given back and nothing is booked", async () => {
  const ct = fakeCommonTape({ book: { ok: false, status: 409, body: { error: { message: "That time was just taken." } } } });
  const a = await run({ text: TYPED, dry_run: false, customer: CUSTOMER }, ct);
  assert.equal(a.booked, null);
  assert.match(a.plan.reason, /did not take the booking \(That time was just taken\.\)/);
  assert.deepEqual(ct.calls.map((c) => c.name), ["search", "hold", "book", "cancel"]);
  assert.equal(ct.calls[3].body.transaction_id, "t1");
});

test("the endpoint: dry run unless dry_run is false, plain 400s, 413 when too big, 502 when the model fails", async () => {
  const deps = { model: stub, client: fakeCommonTape().client, now: NOW };
  for (const dry_run of [undefined, "false", 0]) assert.equal((await (await post(JSON.stringify({ text: TYPED, dry_run }), deps)).json()).dry_run, true);
  assert.equal((await (await post(JSON.stringify({ text: TYPED, dry_run: false }), deps)).json()).dry_run, false);
  for (const bad of ["not json", "[]", "null", "{}", JSON.stringify({ text: 5 }), JSON.stringify({ text: "x".repeat(2001) }), JSON.stringify({ text: TYPED, customer: "Sam" })]) {
    assert.equal((await post(bad, deps)).status, 400, bad.slice(0, 40));
  }
  assert.equal((await post("x".repeat(4_000_001), deps)).status, 413);
  const failing = { ...deps, model: { name: "muse-spark-1.3", seesImages: true, understand: async () => { throw new ModelError("Muse Spark did not answer: 401"); } } };
  const res = await post(JSON.stringify({ text: TYPED }), failing);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "Muse Spark did not answer: 401");
});

test("a booking confirmed on the page goes ahead only if it is still the one the person saw", async () => {
  const input = { text: TYPED, dry_run: false, customer: CUSTOMER };
  const same = await run({ ...input, confirm: { slug: "commontape-demo-cleaning", allocation_id: "next-week-morning", amount: 140 } }, fakeCommonTape());
  assert.equal(same.plan.action, "book");
  const ct = fakeCommonTape();
  const moved = await run({ ...input, confirm: { slug: "commontape-demo-cleaning", allocation_id: "next-week-morning", amount: 120 } }, ct);
  assert.equal(moved.plan.action, "none");
  assert.match(moved.plan.reason, /changed since you looked, so nothing was booked\. Now: CommonTape Demo Cleaning, a standard clean, \$140/);
  assert.deepEqual(ct.calls.map((c) => c.name), ["search"]);
  assert.equal((await post(JSON.stringify({ ...input, confirm: "yes" }), { model: stub, client: ct.client, now: NOW })).status, 400);
});

test("GET says what this copy can do, with no key in it", async () => {
  const answer = await (await GET()).json();
  assert.deepEqual([answer.ready, answer.model, answer.meta_model_connected, answer.hears_voice, answer.sees_photos], [true, "stub-no-key", false, false, false]);
  assert.doesNotMatch(JSON.stringify(answer), /LLM\||api_key|MODEL_/);
});
