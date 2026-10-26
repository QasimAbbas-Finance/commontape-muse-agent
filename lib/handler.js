// The endpoint's work, apart from the Vercel file so tests can hand it a stand-in model and CommonTape.
import { runAgent } from "./agent.js";
import { createModel, ModelError } from "./model.js";

// Vercel refuses request bodies over 4.5 MB; stay under it with room for the JSON around a photo or voice note.
const MAX_BODY_CHARS = 4_000_000;
const MAX_TEXT_CHARS = 2_000;

function reply(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// deps: { model, client, now }, each optional; the model comes from the environment unless one is given.
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
  if (input.customer != null && (typeof input.customer !== "object" || Array.isArray(input.customer))) {
    return reply(400, { error: "customer must be an object with name, phone and service_address." });
  }

  try {
    const model = deps.model ?? createModel(process.env);
    return reply(200, await runAgent(input, { ...deps, model }));
  } catch (err) {
    if (err instanceof ModelError) return reply(502, { error: err.message });
    console.error(err);
    return reply(500, { error: "Something went wrong on our side, and nothing was booked." });
  }
}
