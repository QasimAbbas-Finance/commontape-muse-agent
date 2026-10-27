// The endpoint's work, apart from the Vercel file so tests can hand it a stand-in model and CommonTape.
import { runAgent } from "./agent.js";
import { createClient } from "./commontape.js";
import { createModel, ModelError, STUB_NAME } from "./model.js";
import { createThrottle, personFrom } from "./throttle.js";

// Vercel refuses request bodies over 4.5 MB; stay under it with room for the JSON around a photo or voice note.
const MAX_BODY_CHARS = 4_000_000;
const MAX_TEXT_CHARS = 2_000;
// A cancel is two CommonTape calls: the cancel, cut off at 8 seconds, then the status read, at 15.
const CANCEL_MS = 25_000;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Kept for as long as this copy of the function stays warm.
const throttle = createThrottle();

function reply(status, body, headers = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

// The polite limit, for booking and cancelling alike: null when the request may go on, else the 429 to send.
function tooMany(request, deps, nothing) {
  const allowed = (deps.throttle ?? throttle)(personFrom(request));
  if (allowed.ok) return null;
  return reply(429, { error: `That is a lot of requests in a minute, and the demo is shared by everyone trying it. Wait ${allowed.retryAfter} seconds and try again. ${nothing}` },
    { "retry-after": String(allowed.retryAfter) });
}

// What this copy can do, for the page to say before anyone asks: which model reads requests, and whether it can
// hear voice notes and see photos. No key or setting value is ever in it.
export function status(env = process.env) {
  let model;
  try {
    model = createModel(env);
  } catch (err) {
    return reply(200, { ready: false, reason: err.message });
  }
  return reply(200, {
    ready: true,
    model: model.name,
    meta_model_connected: model.name !== STUB_NAME,
    models: [model.name, model.asrName].filter(Boolean),
    hears_voice: Boolean(model.transcribe || model.hearsAudio),
    sees_photos: model.seesImages,
    how: "POST JSON with text, audio_base64 (mono 16-bit WAV) or image_base64, and dry_run (on unless false).",
  });
}

// deps: { model, client, now, clock, deadline, throttle }, each optional; the model comes from the environment unless one is given.
export async function handle(request, deps = {}) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return reply(413, { error: "That request is too large. Send a shorter voice note or a smaller photo." });
  }
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return reply(400, { error: "Send the request as JSON." });
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return reply(400, { error: "Send the request as a JSON object." });
  }
  for (const field of ["text", "audio_base64", "image_base64"]) {
    if (input[field] != null && typeof input[field] !== "string") return reply(400, { error: `${field} must be a string.` });
  }
  if (!input.text?.trim() && !input.audio_base64 && !input.image_base64) {
    return reply(400, { error: "Send what you need cleaned: in words, as a voice note or as a photo." });
  }
  if ((input.text ?? "").length > MAX_TEXT_CHARS) return reply(400, { error: `Keep the request under ${MAX_TEXT_CHARS} characters.` });
  for (const field of ["customer", "confirm"]) {
    if (input[field] != null && (typeof input[field] !== "object" || Array.isArray(input[field]))) {
      return reply(400, { error: field === "customer" ? "customer must be an object with name, phone and service_address." : "confirm must be an object with slug, allocation_id and amount." });
    }
  }

  const limited = tooMany(request, deps, "Nothing was booked.");
  if (limited) return limited;

  try {
    const model = deps.model ?? createModel(process.env);
    return reply(200, await runAgent(input, { ...deps, model }));
  } catch (err) {
    if (err instanceof ModelError) return reply(502, { error: err.message });
    console.error(err);
    return reply(500, { error: "Something went wrong on our side, and nothing was booked." });
  }
}

// Cancels a booking made from the page, by its CommonTape transaction id, then reads CommonTape's own status back.
// The demo key reaches only the pretend business, so this can only ever cancel a demo booking.
// deps: { client, clock, throttle }, each optional; client(readOnly, { deadline }) makes a CommonTape client.
export async function cancel(request, deps = {}) {
  let input;
  try {
    input = JSON.parse((await request.text()) || "{}");
  } catch {
    return reply(400, { error: "Send the request as JSON." });
  }
  const id = input?.transaction_id;
  if (typeof id !== "string" || !TRANSACTION_ID.test(id)) return reply(400, { error: "Send the booking's transaction_id." });
  const limited = tooMany(request, deps, "Nothing was cancelled.");
  if (limited) return limited;

  const clock = deps.clock ?? Date.now;
  const make = deps.client ?? ((readOnly, options) => createClient({ readOnly, ...options }));
  const ct = make(false, { deadline: clock() + CANCEL_MS });
  const trace = [];
  // One key per booking, so pressing cancel twice is one cancel.
  const done = await ct.cancel({ transaction_id: id, idempotency_key: `cancel-${id}` });
  trace.push({ step: "tool", name: "cancel" });
  const now = await ct.status({ transaction_id: id });
  trace.push({ step: "tool", name: "status" });
  const state = now.body?.state ?? done.body?.state ?? null;
  if (state === "cancelled") {
    return reply(200, { cancelled: true, state, reason: "Cancelled. CommonTape's status for it now says cancelled, so the time is free again.", trace });
  }
  const why = done.body?.error?.message ?? `it answered ${done.status}`;
  return reply(200, { cancelled: false, state, reason: `CommonTape did not cancel it (${why}). Its status says ${state ?? "nothing"}.`, trace });
}
