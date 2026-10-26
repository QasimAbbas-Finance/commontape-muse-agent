// Judges one agent answer the way the hackathon entry's own acceptance check does, read-only: Meta models in the trace,
// nothing held or booked in a dry run, and the business and price equal to CommonTape's own search for the job the agent
// sent (replayed with the demo key). Usage: curl ... /api/agent | node scripts/judge.mjs typed|voice|photo|budget
import { readFileSync } from "node:fs";
import { CT_BASE, DEMO_KEY } from "../lib/commontape.js";

process.env.CT ??= CT_BASE;
process.env.DEMO_KEY ??= DEMO_KEY;
const [mode, raw] = [process.argv[2], readFileSync(0, "utf8")];

try {
  // From here to the end of the try block: the acceptance check's rules, word for word.
  const a = JSON.parse(raw), trace = a.trace || [];
  const used = (re, input) => trace.some(t => t.step === "model" && re.test(t.name || "") && (!input || t.input === input));
  if (a.booked || trace.some(t => t.step === "tool" && /^(hold|book)$/.test(t.name || ""))) throw new Error("dry run held or booked");
  if (!used(/^muse-spark/)) throw new Error("no muse-spark call");
  if (mode === "voice" && !((used(/^muse-voice-transcribe/) || used(/^muse-spark-open/, "audio")) && (a.transcript || "").trim().length > 10)) throw new Error("no transcript");
  if (mode === "photo" && !used(/^muse-spark/, "image")) throw new Error("photo not read by muse-spark");
  const r = await fetch(process.env.CT + "/api/v1/search", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.DEMO_KEY }, body: JSON.stringify(a.job) });
  const s = await r.json();
  if (mode === "budget") {
    if (a.plan?.action !== "none" || !a.plan?.reason) throw new Error("did not refuse with a reason");
    if (!JSON.stringify(s.near_misses || []).includes("over_max_total")) throw new Error("CommonTape does not call it over_max_total");
    console.log(`judge ${mode}: PASS`);
    process.exit(0);
  }
  const o = (a.options || [])[0];
  if (!o || typeof o.price?.amount !== "number" || !o.window_start) throw new Error("no priced option with a window");
  const m = (s.matches || []).find(x => x.slug === o.slug && x.service_key === o.service_key);
  if (!m || m.quote?.amount !== o.price.amount) throw new Error("business or price differs from CommonTape");
  console.log(`judge ${mode}: PASS`);
} catch (err) {
  console.log(`judge ${mode}: FAIL ${err.message}`);
  process.exitCode = 1;
}
