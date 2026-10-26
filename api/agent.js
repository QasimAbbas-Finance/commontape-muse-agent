// The agent's one endpoint. POST a cleaning request (text, a voice note or a photo) and get back the job it understood,
// the priced options CommonTape gives, the plan (book or not, and why) and a trace of every model and tool call.
// A booking is only ever made when the request says "dry_run": false in so many words.
import { handle } from "../lib/handler.js";

export function POST(request) {
  return handle(request);
}

export function GET() {
  return Response.json({ error: "Send a POST with your cleaning request." }, { status: 405, headers: { "cache-control": "no-store" } });
}
