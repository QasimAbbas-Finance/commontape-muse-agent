// Read-only check of the CommonTape connection against the live service with the demo key: searches only,
// nothing is held or booked. Prints "ct-search: PASS" when the demo business answers with a steady, exact price.
import { createClient, optionsFrom, nearMissesFrom } from "../lib/commontape.js";
import { searchBody } from "../lib/job.js";
import { decide } from "../lib/plan.js";

const ct = createClient();
const asked = { about_cleaning: true, zip: "10001", service_key: "house_cleaning.standard", home_type: "property.apartment", bedrooms: 2, full_bathrooms: 1 };
const job = searchBody(asked);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const first = await ct.search(job);
const second = await ct.search(job);
const over = await ct.search({ ...job, max_total: 40 });
check(first.ok && second.ok && over.ok, `CommonTape answers every search (${first.status}, ${second.status}, ${over.status})`);

const options = optionsFrom(first.body), again = optionsFrom(second.body);
const demo = options.find((o) => o.slug === "commontape-demo-cleaning");
check((first.body.matches ?? []).length === 1 && demo, `one match, the demo business (${(first.body.matches ?? []).map((m) => m.slug).join(", ") || "none"})`);
check(typeof demo?.price.amount === "number", `an exact price: ${demo?.price.amount} ${demo?.price.currency}`);
check(demo?.allocation_id && demo?.window_start, `an open time: ${demo?.window_start}`);
check(again[0]?.price.amount === demo?.price.amount, `the same price twice (${demo?.price.amount}, ${again[0]?.price.amount})`);

const misses = nearMissesFrom(over.body);
check(optionsFrom(over.body).length === 0 && misses.some((m) => m.reasons.some((r) => r.code === "over_max_total")),
  `a $40 budget is refused as over_max_total: ${misses.flatMap((m) => m.reasons.map((r) => r.label)).join("; ") || "no near miss"}`);

// The safety check on CommonTape's real answers: a dry run picks the demo business but books nothing; $40 is refused.
const plan = decide({ understood: asked, options, nearMisses: nearMissesFrom(first.body) });
check(plan.action === "none" && plan.choice?.slug === "commontape-demo-cleaning", `dry run plan: ${plan.reason}`);
const budget = decide({ understood: { ...asked, max_total: 40 }, options: optionsFrom(over.body), nearMisses: misses });
check(budget.action === "none" && !budget.choice && /over the \$40 cap/.test(budget.reason), `budget plan: ${budget.reason}`);

console.log(`what CommonTape read: ${(first.body.job?.read_back ?? []).join(" ")}`);
console.log(`ct-search: ${failed ? `FAIL (${failed})` : "PASS"}`);
process.exitCode = failed ? 1 : 0;
