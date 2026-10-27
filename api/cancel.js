// Cancels a booking made from the page: POST {"transaction_id": "..."} and get back CommonTape's status for it.
// The demo key reaches only the pretend business, so this can only ever cancel a demo booking.
import { cancel } from "../lib/handler.js";

export function POST(request) {
  return cancel(request);
}
