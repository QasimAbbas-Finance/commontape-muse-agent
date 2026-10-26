import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, optionsFrom, nearMissesFrom, DEMO_KEY } from "../lib/commontape.js";

// A stand-in for CommonTape: answers from a list, records every request, and never sleeps for real.
function fake(answers) {
  const calls = [], slept = [];
  let clock = 0;
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: a.headers });
  };
  const sleep = async (ms) => { slept.push(ms); clock += ms; };
  return { calls, slept, opts: { fetch, sleep, now: () => clock } };
}

// Shapes as CommonTape's demo key answered a search on 26 Oct 2026, trimmed.
const SEARCH = {
  matches: [
    {
      slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard",
      timezone: "America/New_York",
      quote: { status: "priced", amount: 140, currency: "USD", quote_token: "tok" },
      available_windows: [
        { allocation_id: "a1", window_start: "2026-10-27T13:00:00+00:00", window_end: "2026-10-27T16:00:00+00:00" },
        { allocation_id: "a2", window_start: "2026-10-28T13:00:00+00:00", window_end: "2026-10-28T16:00:00+00:00" },
      ],
    },
    { slug: "no-price", service_key: "house_cleaning.standard", quote: { status: "owner_must_quote" }, available_windows: [{ allocation_id: "x" }] },
    { slug: "no-time", service_key: "house_cleaning.standard", quote: { amount: 99, currency: "USD" }, available_windows: [] },
  ],
  near_misses: [{ slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard",
    reasons: [{ code: "over_max_total", label: "Price $140 is $100 over the $40 cap." }], trust: {} }],
};

test("a search goes to CommonTape's public connection with the demo key", async () => {
  const f = fake([{ body: SEARCH }]);
  const r = await createClient(f.opts).search({ zip: "10001" });
  assert.equal(r.ok, true);
  assert.equal(r.body.matches.length, 3);
  assert.equal(f.calls[0].url, "https://commontape.com/api/v1/search");
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].headers.authorization, `Bearer ${DEMO_KEY}`);
  assert.deepEqual(f.calls[0].body, { zip: "10001" });
});

test("a client is read-only unless asked otherwise: hold, book and cancel never reach CommonTape", async () => {
  const f = fake([]);
  const ct = createClient(f.opts);
  for (const name of ["hold", "book", "cancel"]) assert.throws(() => ct[name]({ transaction_id: "t" }), /dry run/);
  assert.equal(f.calls.length, 0);
});

test("a write carries one idempotency key, and a retry after 429 reuses it", async () => {
  const f = fake([{ status: 429, body: { error: { code: "RATE_LIMITED", retry_after_seconds: 2 } } }, { body: { transaction_id: "t1", state: "held" } }]);
  const r = await createClient({ ...f.opts, readOnly: false }).hold({ quote_token: "tok", allocation_id: "a1" });
  assert.equal(r.body.state, "held");
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].body.idempotency_key, /^[0-9a-f-]{36}$/);
  assert.equal(f.calls[1].body.idempotency_key, f.calls[0].body.idempotency_key);
  assert.ok(f.slept.includes(2000));
});

test("a 429 that asks for a long wait is handed back, not waited out", async () => {
  const f = fake([{ status: 429, body: { error: { code: "RATE_LIMITED", retry_after_seconds: 3600 } } }]);
  const r = await createClient(f.opts).search({ zip: "10001" });
  assert.equal(r.status, 429);
  assert.equal(f.calls.length, 1);
});

test("with a deadline, no call is sent and no wait is taken that would run past it, and a slow answer is cut off", async () => {
  const late = fake([]);
  const gone = await createClient({ ...late.opts, deadline: 500 }).search({ zip: "10001" });
  assert.deepEqual([gone.status, gone.body.error.code, late.calls.length], [0, "TIMEOUT", 0]);
  const busy = fake([{ status: 429, body: { error: { code: "RATE_LIMITED", retry_after_seconds: 5 } } }]);
  const r = await createClient({ ...busy.opts, deadline: 4_000 }).search({ zip: "10001" });
  assert.deepEqual([r.status, busy.calls.length, busy.slept], [429, 1, []]);
  const hanging = (url, init) => new Promise((_, fail) => init.signal.addEventListener("abort", () => fail(init.signal.reason)));
  const cut = await createClient({ fetch: hanging, callMs: 50 }).search({ zip: "10001" });
  assert.deepEqual([cut.status, cut.body.error.code], [0, "TIMEOUT"]);
});

test("calls are spaced out, and an unreachable CommonTape answers status 0 after its retries", async () => {
  const f = fake([new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")]);
  const r = await createClient(f.opts).search({ zip: "10001" });
  assert.equal(r.status, 0);
  assert.equal(r.body.error.code, "UNREACHABLE");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.slept, [250, 250]);
});

test("options carry CommonTape's exact price and an open time; unpriced or full businesses are left out", () => {
  assert.deepEqual(optionsFrom(SEARCH), [{
    slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard",
    price: { amount: 140, currency: "USD" },
    window_start: "2026-10-27T13:00:00+00:00", window_end: "2026-10-27T16:00:00+00:00", timezone: "America/New_York", allocation_id: "a1",
  }]);
  assert.equal(optionsFrom(SEARCH, (ws) => ws[1])[0].allocation_id, "a2");
  assert.deepEqual(optionsFrom({}), []);
});

test("near misses keep CommonTape's own reason codes", () => {
  assert.deepEqual(nearMissesFrom(SEARCH), [{ slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning",
    service_key: "house_cleaning.standard", reasons: [{ code: "over_max_total", label: "Price $140 is $100 over the $40 cap." }] }]);
});
