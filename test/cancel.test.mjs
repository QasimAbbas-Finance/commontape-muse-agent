import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../api/cancel.js";
import { cancel } from "../lib/handler.js";
import { createThrottle } from "../lib/throttle.js";

const ID = "4b032081-3228-4606-ad46-3851f9a82cc7";

// A stand-in CommonTape: cancel answers as given, status says what the booking is now.
function fakeCommonTape({ cancelled = { ok: true, status: 200, body: { state: "cancelled" } }, state = "cancelled" } = {}) {
  const made = [], calls = [];
  const api = {
    cancel: async (body) => { calls.push({ name: "cancel", body }); return cancelled; },
    status: async (body) => { calls.push({ name: "status", body }); return { ok: true, status: 200, body: { state } }; },
  };
  return { made, calls, client: (readOnly) => { made.push(readOnly); return api; } };
}
const post = (body, deps) => cancel(new Request("http://localhost/api/cancel", { method: "POST", body }), deps);

test("cancelling a booking: CommonTape cancel with one key per booking, then its own status read back, both in the trace", async () => {
  const ct = fakeCommonTape();
  const res = await post(JSON.stringify({ transaction_id: ID }), { client: ct.client });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.cancelled, true);
  assert.equal(a.state, "cancelled");
  assert.match(a.reason, /^Cancelled\./);
  assert.deepEqual(a.trace, [{ step: "tool", name: "cancel" }, { step: "tool", name: "status" }]);
  assert.deepEqual(ct.calls, [
    { name: "cancel", body: { transaction_id: ID, idempotency_key: `cancel-${ID}` } },
    { name: "status", body: { transaction_id: ID } },
  ]);
  assert.deepEqual(ct.made, [false], "one writable client");
  await post(JSON.stringify({ transaction_id: ID }), { client: ct.client });
  assert.equal(ct.calls[2].body.idempotency_key, ct.calls[0].body.idempotency_key, "pressing cancel twice sends the same key");
});

test("when CommonTape does not cancel, the answer says so in its words and gives the status it reports", async () => {
  const ct = fakeCommonTape({ cancelled: { ok: false, status: 409, body: { error: { code: "NOT_CANCELLABLE", message: "This booking cannot be cancelled" } } }, state: "booked" });
  const a = await (await post(JSON.stringify({ transaction_id: ID }), { client: ct.client })).json();
  assert.equal(a.cancelled, false);
  assert.equal(a.state, "booked");
  assert.equal(a.reason, "CommonTape did not cancel it (This booking cannot be cancelled). Its status says booked.");
});

test("a request without a booking's id is refused before CommonTape is asked", async () => {
  const ct = fakeCommonTape();
  for (const body of ["{}", "not json", JSON.stringify({ transaction_id: "../../status" }), JSON.stringify({ transaction_id: 42 }), JSON.stringify([ID])]) {
    assert.equal((await post(body, { client: ct.client })).status, 400, body);
  }
  assert.equal(ct.calls.length, 0);
  assert.equal(typeof POST, "function");
});

test("cancelling has the same polite limit, and a refused one says nothing was cancelled", async () => {
  const ct = fakeCommonTape();
  const deps = { client: ct.client, throttle: createThrottle({ clock: () => 0, perPerson: 1 }) };
  assert.equal((await post(JSON.stringify({ transaction_id: ID }), deps)).status, 200);
  const res = await post(JSON.stringify({ transaction_id: ID }), deps);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /Nothing was cancelled\.$/);
  assert.equal(ct.calls.filter((c) => c.name === "cancel").length, 1);
});
