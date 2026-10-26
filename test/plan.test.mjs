import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, bookingKeys, when } from "../lib/plan.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ASKED = { about_cleaning: true, zip: "10001", service_key: "house_cleaning.standard", home_type: "property.apartment", bedrooms: 2, full_bathrooms: 1 };
const CUSTOMER = { name: "Sam Rivera", phone: "+1 (212) 555-0147", service_address: "350 W 31st St, Apt 4, New York, NY 10001" };
const option = (over) => ({
  slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard",
  price: { amount: 140, currency: "USD" }, window_start: "2026-10-27T13:00:00+00:00", window_end: "2026-10-27T16:00:00+00:00",
  timezone: "America/New_York", allocation_id: "a1", ...over,
});
const real = (over) => decide({ dryRun: false, understood: ASKED, customer: CUSTOMER, now: NOW, ...over });

test("a budget below every price: no booking, and CommonTape's own reason in plain words", () => {
  const plan = decide({
    understood: { ...ASKED, max_total: 40 }, options: [], now: NOW,
    nearMisses: [{ slug: "commontape-demo-cleaning", display_name: "CommonTape Demo Cleaning", service_key: "house_cleaning.standard",
      reasons: [{ code: "over_max_total", label: "Price $140 is $100 over the $40 cap." }] }],
  });
  assert.equal(plan.action, "none");
  assert.match(plan.reason, /CommonTape Demo Cleaning: Price \$140 is \$100 over the \$40 cap\./);
  assert.equal(plan.choice, undefined);
});

test("two options that fit: the cheapest, and the earlier of two at the same price", () => {
  const plan = real({
    understood: { ...ASKED, max_total: 150 },
    options: [
      option({ slug: "over-budget", price: { amount: 160, currency: "USD" }, window_start: "2026-10-27T12:00:00+00:00" }),
      option({ slug: "later", window_start: "2026-10-28T13:00:00+00:00" }),
      option({ slug: "wrong-service", service_key: "house_cleaning.deep", price: { amount: 90, currency: "USD" } }),
      option({ slug: "earlier" }),
    ],
  });
  assert.equal(plan.action, "book");
  assert.equal(plan.choice.slug, "earlier");
  assert.equal(plan.reason, "Booking CommonTape Demo Cleaning, a standard clean, $140, Tue, Oct 27, 9:00 AM EDT.");
});

test("a dry run never books, but says what it would book (and dry run is the default)", () => {
  const asked = [undefined, true, "false", 0, null].map((dryRun) => decide({ dryRun, understood: ASKED, customer: CUSTOMER, options: [option()], now: NOW }));
  for (const plan of asked) {
    assert.equal(plan.action, "none");
    assert.match(plan.reason, /^This was a dry run, so nothing was booked\. I would book CommonTape Demo Cleaning/);
    assert.equal(plan.choice.slug, "commontape-demo-cleaning");
  }
});

test("a request that is not about cleaning, or not understood, is never booked", () => {
  assert.equal(real({ understood: { ...ASKED, about_cleaning: false }, options: [option()] }).action, "none");
  assert.match(real({ understood: undefined, options: [option()] }).reason, /only book home cleaning/);
  assert.equal(real({ understood: { ...ASKED, about_cleaning: undefined }, options: [option()] }).action, "none");
});

test("no ZIP, or a job CommonTape would refuse: no booking, the reason says what is missing", () => {
  assert.deepEqual(real({ understood: { ...ASKED, zip: undefined }, options: [option()] }), { action: "none", reason: "A 5-digit US ZIP code is needed." });
  assert.equal(real({ understood: { ...ASKED, bedrooms: -2 }, options: [option()] }).action, "none");
});

test("nothing that fits: no booking", () => {
  assert.equal(real({ options: [] }).reason, "No cleaner on CommonTape can do a standard clean in ZIP 10001 at the times asked.");
  assert.equal(real({ understood: { ...ASKED, max_total: 100 }, options: [option()] }).reason, "No cleaner can do this for $100 or less.");
  for (const bad of [
    option({ window_start: "2026-10-26T11:00:00+00:00" }),
    option({ price: { amount: 140, currency: "EUR" } }),
    option({ price: { amount: 0, currency: "USD" } }),
    option({ allocation_id: undefined }),
  ]) assert.equal(real({ options: [bad] }).action, "none", JSON.stringify(bad));
});

test("a real booking needs the customer's name, phone and an address in the ZIP searched", () => {
  assert.equal(real({ customer: undefined, options: [option()] }).reason, "To book, I need your name, a phone number and the address to clean.");
  assert.equal(real({ customer: { ...CUSTOMER, phone: "555-01" }, options: [option()] }).reason, "To book, I need a phone number.");
  assert.equal(real({ customer: { ...CUSTOMER, service_address: "12 Main St, Brooklyn, NY 11201" }, options: [option()] }).reason,
    "The address is in ZIP 11201, but the cleaners found are for ZIP 10001.");
  assert.equal(real({ customer: { ...CUSTOMER, service_address: "10450 Broadway, New York, NY 10001" }, options: [option()] }).action, "book");
});

test("one hold and one book per request: the same request always gets the same keys", () => {
  const a = bookingKeys({ text: "a clean", customer: { name: "Sam", phone: "2125550147" }, dry_run: false });
  const b = bookingKeys({ customer: { phone: "2125550147", name: "Sam" }, text: "a clean" });
  assert.deepEqual(a, b);
  assert.notEqual(a.hold, a.book);
  assert.notDeepEqual(bookingKeys({ text: "a clean", customer: { name: "Ana", phone: "2125550147" } }), a);
  for (const k of Object.values(a)) assert.ok(k.length >= 8 && k.length <= 128);
});

test("times are in the business's own time zone", () => {
  assert.equal(when(option({ window_start: "2026-11-02T14:00:00+00:00" })), "Mon, Nov 2, 9:00 AM EST");
});
