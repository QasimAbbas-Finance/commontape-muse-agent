// The agent's one endpoint. POST a cleaning request (text, a voice note or a photo) and get back the job it understood,
// the priced options CommonTape gives, the plan (book or not, and why) and a trace of every model and tool call.
// For now the answer has its final shape but the agent is not built, so it never searches or books anything.

// Vercel refuses request bodies over 4.5 MB; stay under it with room for the JSON around a photo or voice note.
const MAX_BODY_CHARS = 4_000_000;

export function emptyAnswer({ dryRun, reason }) {
  return {
    dry_run: dryRun,
    transcript: null,
    job: null,
    options: [],
    plan: { action: "none", reason },
    trace: [],
    booked: null,
  };
}

function reply(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request) {
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
  // A booking is only ever made when the caller sends dry_run: false in so many words.
  const dryRun = input.dry_run !== false;
  return reply(200, emptyAnswer({ dryRun, reason: "The agent is not built yet, so nothing was searched or booked." }));
}

export function GET() {
  return reply(405, { error: "Send a POST with your cleaning request." });
}
