// The agent: request -> (voice note to text) -> the job -> CommonTape search -> the safety check -> hold and book,
// only when the check says book and it is not a dry run. Every model and tool call goes in the trace, in order.
import { createClient, optionsFrom, nearMissesFrom } from "./commontape.js";
import { searchBody, JobError } from "./job.js";
import { decide, bookingKeys, customerRef, windowPicker } from "./plan.js";

// input: the request ({ text?, audio_base64?, image_base64?, customer?, dry_run }). deps: { model, client, now }.
// client(readOnly) makes a CommonTape client; it is made writable only when this is not a dry run.
export async function runAgent(input, { model, client = (readOnly) => createClient({ readOnly }), now = Date.now() }) {
  const dryRun = input.dry_run !== false;
  const trace = [];
  const answer = (fields) => ({ dry_run: dryRun, transcript: null, job: null, options: [], plan: null, trace, booked: null, ...fields });

  let transcript = null;
  if (input.audio_base64) {
    if (!model.transcribe) {
      return answer({ plan: { action: "none", reason: "Voice notes need Meta's Muse Voice Transcribe, and this copy has no Meta key yet. Type the request instead." } });
    }
    transcript = await model.transcribe(input.audio_base64);
    trace.push({ step: "model", name: model.asrName, input: "audio" });
  }
  const text = [input.text, transcript].filter(Boolean).join("\n");
  if (input.image_base64 && !model.seesImages && !text) {
    return answer({ transcript, plan: { action: "none", reason: "Photos need Meta's Muse Spark, and this copy has no Meta key yet. Describe the home in words instead." } });
  }

  const understood = await model.understand({ text, image_base64: model.seesImages ? input.image_base64 : undefined });
  trace.push({ step: "model", name: model.name, input: input.image_base64 && model.seesImages ? "image" : "text" });

  let job = null;
  try {
    if (understood?.about_cleaning === true) job = searchBody(understood);
  } catch (err) {
    if (!(err instanceof JobError)) throw err;
  }
  if (!job) return answer({ transcript, understood, plan: decide({ dryRun, understood, now }) });

  // For a real booking, CommonTape gets a label for this customer, so two people booking the same job are told apart.
  if (!dryRun && input.customer) job.customer_ref = customerRef(input.customer);
  const reader = client(true);
  const found = await reader.search(job);
  trace.push({ step: "tool", name: "search", input: job });
  if (!found.ok) {
    const why = found.body?.error?.message ?? `it answered ${found.status}`;
    return answer({ transcript, understood, job, plan: { action: "none", reason: `CommonTape's search did not work (${why}), so nothing was booked.` } });
  }
  const options = optionsFrom(found.body, windowPicker(understood, now));
  const nearMisses = nearMissesFrom(found.body);
  const plan = decide({ dryRun, understood, options, nearMisses, customer: input.customer, now });
  const fields = { transcript, understood, job, options, near_misses: nearMisses, read_back: found.body.job?.read_back ?? [] };
  if (plan.action !== "book" || dryRun) return answer({ ...fields, plan });
  // A booking the person confirmed on the page must still be the one they saw: same business, time and price.
  const seen = input.confirm;
  if (seen && (seen.slug !== plan.choice.slug || seen.allocation_id !== plan.choice.allocation_id || seen.amount !== plan.choice.price.amount)) {
    return answer({ ...fields, plan: { action: "none", reason: `The cleaner, time or price changed since you looked, so nothing was booked. Now: ${plan.reason.replace(/^Booking /, "")}`, choice: plan.choice } });
  }

  // A real booking: one hold, then one book, with keys made from the request so a repeat never books twice.
  const match = found.body.matches.find((m) => m.slug === plan.choice.slug && m.service_key === plan.choice.service_key);
  const keys = bookingKeys(input);
  const writer = client(false);
  const held = await writer.hold({ quote_token: match.quote.quote_token, allocation_id: plan.choice.allocation_id, idempotency_key: keys.hold });
  trace.push({ step: "tool", name: "hold" });
  if (!held.ok || !held.body.transaction_id) {
    const why = held.body?.error?.message ?? `it answered ${held.status}`;
    return answer({ ...fields, plan: { action: "none", reason: `CommonTape would not hold that time (${why}), so nothing was booked.`, choice: plan.choice } });
  }
  const booked = await writer.book({ transaction_id: held.body.transaction_id, customer: input.customer, idempotency_key: keys.book });
  trace.push({ step: "tool", name: "book" });
  if (!booked.ok) {
    const why = booked.body?.error?.message ?? `it answered ${booked.status}`;
    // Give the held time back at once rather than leave it to run out.
    await writer.cancel({ transaction_id: held.body.transaction_id, idempotency_key: `${keys.book}-undo` });
    trace.push({ step: "tool", name: "cancel" });
    return answer({ ...fields, plan: { action: "none", reason: `CommonTape did not take the booking (${why}).`, choice: plan.choice } });
  }
  return answer({
    ...fields,
    plan,
    booked: { transaction_id: held.body.transaction_id, state: booked.body.state ?? null, business: plan.choice.display_name, price: plan.choice.price, window_start: plan.choice.window_start },
  });
}
