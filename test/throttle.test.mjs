import { test } from "node:test";
import assert from "node:assert/strict";
import { createThrottle, personFrom } from "../lib/throttle.js";
import { handle } from "../lib/handler.js";
import { createModel } from "../lib/model.js";

const TYPED = "I need a standard clean for my 2-bedroom, 1-bathroom apartment in ZIP 10001, any morning next week.";

test("one person gets 12 a minute, someone else is not held up, and a refused request is not counted", () => {
  let t = 0;
  const allow = createThrottle({ clock: () => t });
  for (let i = 0; i < 12; i++, t += 1000) assert.equal(allow("a").ok, true);
  assert.deepEqual(allow("a"), { ok: false, retryAfter: 48 }, "the first of the 12 is a minute old 48 seconds from now");
  assert.equal(allow("b").ok, true);
  t = 60_001;
  assert.equal(allow("a").ok, true, "a place frees a minute after the first request, refusals not counted");
  assert.equal(allow("a").ok, false);
});

test("the whole copy lets 25 a minute through, across people", () => {
  const allow = createThrottle({ clock: () => 0 });
  for (let i = 0; i < 25; i++) assert.equal(allow(`p${i}`).ok, true);
  assert.deepEqual(allow("p99"), { ok: false, retryAfter: 60 });
});

test("the person is the address Vercel gives, or one local person", () => {
  assert.equal(personFrom(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } })), "203.0.113.7");
  assert.equal(personFrom(new Request("http://x")), "local");
});

test("35 quick requests from one person: 12 answered, the rest a polite 429 before CommonTape is asked", async () => {
  let searches = 0;
  const api = { search: async () => { searches++; return { ok: true, status: 200, body: { matches: [], near_misses: [] } }; } };
  const deps = { model: createModel({}), client: () => api, throttle: createThrottle({ clock: () => 0 }) };
  const statuses = [];
  let last;
  for (let i = 0; i < 35; i++) {
    last = await handle(new Request("http://localhost/api/agent", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ text: TYPED }) }), deps);
    statuses.push(last.status);
  }
  assert.deepEqual([statuses.filter((s) => s === 200).length, statuses.filter((s) => s === 429).length], [12, 23]);
  assert.equal(searches, 12);
  assert.equal(last.headers.get("retry-after"), "60");
  assert.match((await last.json()).error, /Wait 60 seconds and try again\. Nothing was booked\./);
});
