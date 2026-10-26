import { test } from "node:test";
import assert from "node:assert/strict";
import { searchBody, JobError } from "../lib/job.js";

test("a described home becomes CommonTape's own words", () => {
  const body = searchBody({ zip: "10001", service_key: "house_cleaning.standard", home_type: "property.apartment", bedrooms: 2, full_bathrooms: 1 });
  assert.deepEqual(body, {
    zip: "10001",
    service_key: "house_cleaning.standard",
    property: { type: "property.apartment", spaces: { "space.bedroom": 2, "space.bathroom.full": 1 } },
  });
});

test("only the facts given go in, and a clean with no kind named is a standard clean", () => {
  assert.deepEqual(searchBody({ zip: 10001 }), { zip: "10001", service_key: "house_cleaning.standard" });
  assert.deepEqual(searchBody({ zip: "10001", max_total: 40, arrive_by: "2026-11-02T10:00" }),
    { zip: "10001", service_key: "house_cleaning.standard", max_total: 40, arrive_by: "2026-11-02T10:00" });
});

test("a studio with no bedroom keeps the 0", () => {
  assert.deepEqual(searchBody({ zip: "10001", home_type: "property.studio", bedrooms: 0 }).property,
    { type: "property.studio", spaces: { "space.bedroom": 0 } });
});

test("anything CommonTape would refuse is stopped with a plain reason", () => {
  for (const bad of [
    null,
    {},
    { zip: "1000" },
    { zip: "10001", service_key: "house_cleaning.windows" },
    { zip: "10001", home_type: "property.castle" },
    { zip: "10001", bedrooms: 2.5 },
    { zip: "10001", full_bathrooms: -1 },
    { zip: "10001", max_total: "40" },
    { zip: "10001", max_total: 0 },
    { zip: "10001", finish_by: "next Tuesday" },
  ]) assert.throws(() => searchBody(bad), JobError, JSON.stringify(bad));
});
