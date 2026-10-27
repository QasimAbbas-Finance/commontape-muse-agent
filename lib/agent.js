// The agent: request -> (voice note to text) -> the job -> CommonTape search -> the safety check -> hold and book,
// only when the check says book and it is not a dry run. Every model and tool call goes in the trace, in order.
import { createClient, optionsFrom, nearMissesFrom } from "./commontape.js";
import { searchBody, JobError } from "./job.js";
import { decide, bookingKeys, customerRef, windowPicker } from "./plan.js";
import { ModelError } from "./model.js";

// The function may run 60 seconds (vercel.json). The agent finishes by 55, and the model gets only the time left after
// what CommonTape's steps need (a search is cut off at 15 seconds, a hold or a book at 8).
const DEADLINE_MS = 55_000;
const MODEL_MS = 40_000;
const SEARCH_MS = 16_000; // one search, with its spacing
const HOLD_MS = 20_000; // the hold, the book and, if the book fails, giving the hold back
const BOOK_MS = 17_000; // the book and, if it fails, giving the hold back
const RETRY_MIN_MS = 10_000;
const ZIP = /^\d{5}$/;
const TOO_LATE = "This took too long to finish safely, so nothing was booked. Try again.";

// input: the request ({ text?, audio_base64?, image_base64?, customer?, dry_run }).
// deps: { model, client, now, clock, deadline }. client(readOnly, { deadline }) makes a CommonTape client; it is made
// writable only when this is not a dry run. now is the time used for choosing open times; clock and deadline keep the
// request inside the function's time limit.
export async function runAgent(input, { model, client = (readOnly, options) => createClient({ readOnly, ...options }), now = Date.now(), clock = Date.now, deadline = clock() + DEADLINE_MS }) {
  const dryRun = input.dry_run !== false;
  const trace = [];
  const answer = (fields) => ({ dry_run: dryRun, transcript: null, job: null, options: [], plan: null, trace, booked: null, ...fields });
  const left = () => deadline - clock();
  // The model's time: what is left once CommonTape's steps (and anything else still to come) are set aside.
  const modelTime = (setAside = 0) => {
    const timeoutMs = Math.min(MODEL_MS, left() - SEARCH_MS - (dryRun ? 0 : HOLD_MS) - setAside);
    if (timeoutMs < 3_000) throw new ModelError(TOO_LATE);
    return { timeoutMs };
  };
  // A second listen to a voice note happens only with at least 10 seconds for it.
  const retryTime = () => {
    const timeoutMs = Math.min(MODEL_MS, left() - SEARCH_MS - (dryRun ? 0 : HOLD_MS));
    return timeoutMs >= RETRY_MIN_MS ? { timeoutMs } : null;
  };

  // A voice note is either written down first (Muse Voice Transcribe) or heard by the model itself (Muse Spark Open).
  let transcript = null;
  const hears = Boolean(input.audio_base64 && model.hearsAudio);
  if (input.audio_base64 && !hears) {
    if (!model.transcribe) {
      return answer({ plan: { action: "none", reason: "Voice notes need a Meta model, and this copy has none connected yet. Type the request instead." } });
    }
    // Muse Spark still has to read the transcript, so it keeps at least 10 seconds.
    transcript = await model.transcribe(input.audio_base64, modelTime(10_000));
    trace.push({ step: "model", name: model.asrName, input: "audio" });
  }
  const text = [input.text, transcript].filter(Boolean).join("\n");
  if (input.image_base64 && !model.seesImages && !text) {
    return answer({ transcript, plan: { action: "none", reason: "Photos need a Meta model, and this copy has none connected yet. Describe the home in words instead." } });
  }

  const asked = {
    text,
    image_base64: model.seesImages ? input.image_base64 : undefined,
    audio_base64: hears ? input.audio_base64 : undefined,
  };
  let understood = await model.understand(asked, modelTime());
  trace.push({ step: "model", name: model.name, input: hears ? "audio" : input.image_base64 && model.seesImages ? "image" : "text" });
  // Muse Spark Open now and then hears a voice note without its ZIP, or not at all: ask it once more while there is
  // time, and keep the first answer if the second is too slow.
  const again = hears && !ZIP.test(String(understood?.zip ?? "")) && retryTime();
  if (again) {
    try {
      understood = await model.understand(asked, again);
      trace.push({ step: "model", name: model.name, input: "audio", again: true });
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
    }
  }
  if (hears) transcript = understood?.heard?.trim() || null;

  let job = null;
  try {
    if (understood?.about_cleaning === true) job = searchBody(understood);
  } catch (err) {
    if (!(err instanceof JobError)) throw err;
  }
  if (!job) return answer({ transcript, understood, plan: decide({ dryRun, understood, now }) });

  // For a real booking, CommonTape gets a label for this customer, so two people booking the same job are told apart.
  if (!dryRun && input.customer) job.customer_ref = customerRef(input.customer);
  const reader = client(true, { deadline });
  const found = await reader.search(job);
  trace.push({ step: "tool", name: "search", input: job });
  if (!found.ok) {
    const why = found.body?.error?.message ?? `it answered ${found.status}`;
    return answer({ transcript, understood, job, plan: { action: "none", reason: `CommonTape's search did not work (${why}), so nothing was booked.` } });
  }
  // With nothing said about the home, CommonTape lists the cleaners for the ZIP but cannot price the job.
  if (!Array.isArray(found.body.matches)) {
    return answer({ transcript, understood, job, needs: ["home_type"], plan: { action: "none", reason: "To get an exact price, say what kind of home it is and how many bedrooms and bathrooms it has." } });
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
  if (left() < HOLD_MS) return answer({ ...fields, plan: { action: "none", reason: TOO_LATE, choice: plan.choice } });
  const writer = client(false, { deadline });
  const held = await writer.hold({ quote_token: match.quote.quote_token, allocation_id: plan.choice.allocation_id, idempotency_key: keys.hold });
  trace.push({ step: "tool", name: "hold" });
  if (!held.ok || !held.body.transaction_id) {
    const code = held.body?.error?.code;
    const why = code === "IDEMPOTENCY_KEY_CONFLICT" ? "This exact request was already booked once, so it was not booked again."
      : code === "HOLD_EXISTS" ? "This customer already has this job held at that business, so it was not booked again."
      : `CommonTape would not hold that time (${held.body?.error?.message ?? `it answered ${held.status}`}), so nothing was booked.`;
    return answer({ ...fields, plan: { action: "none", reason: why, choice: plan.choice } });
  }
  if (left() < BOOK_MS) {
    await writer.cancel({ transaction_id: held.body.transaction_id, idempotency_key: `${keys.book}-undo` });
    trace.push({ step: "tool", name: "cancel" });
    return answer({ ...fields, plan: { action: "none", reason: TOO_LATE, choice: plan.choice } });
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
