import { test } from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../api/agent.js";

const CONTRACT_KEYS = ["dry_run", "transcript", "job", "options", "plan", "trace", "booked"];

function post(body) {
  return POST(new Request("http://localhost/api/agent", { method: "POST", body }));
}

test("a dry-run request answers 200 with every contract key and books nothing", async () => {
  const res = await post(JSON.stringify({ text: "Standard clean, 2 bed 1 bath, ZIP 10001", dry_run: true }));
  assert.equal(res.status, 200);
  const answer = await res.json();
  for (const key of CONTRACT_KEYS) assert.ok(key in answer, `missing ${key}`);
  assert.equal(answer.dry_run, true);
  assert.equal(answer.booked, null);
  assert.deepEqual(answer.options, []);
  assert.equal(answer.plan.action, "none");
  assert.ok(answer.plan.reason.length > 0);
});

test("dry run is the default when the caller does not say", async () => {
  const answer = await (await post(JSON.stringify({ text: "Deep clean please" }))).json();
  assert.equal(answer.dry_run, true);
});

test("only dry_run: false turns dry run off", async () => {
  assert.equal((await (await post(JSON.stringify({ dry_run: "false" }))).json()).dry_run, true);
  assert.equal((await (await post(JSON.stringify({ dry_run: 0 }))).json()).dry_run, true);
  const live = await (await post(JSON.stringify({ dry_run: false }))).json();
  assert.equal(live.dry_run, false);
  assert.equal(live.booked, null);
});

test("bad bodies get a plain 400", async () => {
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post("null")).status, 400);
});

test("an oversized body gets a plain 413", async () => {
  const res = await post(JSON.stringify({ image_base64: "a".repeat(4_100_000) }));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
});

test("GET is refused with 405", async () => {
  assert.equal(GET().status, 405);
});
