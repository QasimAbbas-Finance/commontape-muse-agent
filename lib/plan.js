// The safety check: the last word before anything is booked. It is plain code, not a model, so a model that gets the
// job wrong can never book something that does not match what was asked. action is "book" only when a booking will
// really be made; every other answer is "none" with the reason in plain words.
import { createHash } from "node:crypto";
import { searchBody, JobError } from "./job.js";

const SERVICE_WORDS = {
  "house_cleaning.standard": "a standard clean",
  "house_cleaning.deep": "a deep clean",
  "house_cleaning.move_in_out": "a move-in or move-out clean",
};

const none = (reason, choice) => (choice ? { action: "none", reason, choice } : { action: "none", reason });

// A time in the business's own time zone, like "Tue, Oct 27, 9:00 AM EDT".
export function when(option) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: option.timezone || "America/New_York",
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(option.window_start));
}

const describe = (o) => `${o.display_name}, ${SERVICE_WORDS[o.service_key] ?? o.service_key}, $${o.price.amount}, ${when(o)}`;

// An option fits only if it is the service asked for, at a real price within the budget, at a time still ahead.
function fits(option, job, now) {
  const start = Date.parse(option.window_start);
  return option.service_key === job.service_key
    && typeof option.price?.amount === "number" && option.price.amount > 0 && option.price.currency === "USD"
    && (job.max_total == null || option.price.amount <= job.max_total)
    && Boolean(option.allocation_id) && start > now;
}

// What is missing or wrong in the customer's details for a real booking, or null when they will do.
function customerProblem(customer, job) {
  const c = customer ?? {};
  const missing = [];
  if (typeof c.name !== "string" || c.name.trim().length < 2) missing.push("your name");
  const digits = typeof c.phone === "string" ? c.phone.replace(/\D/g, "") : "";
  if (digits.length < 10 || digits.length > 15) missing.push("a phone number");
  if (typeof c.service_address !== "string" || c.service_address.trim().length < 5) missing.push("the address to clean");
  if (missing.length) return `To book, I need ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  const zip = c.service_address.match(/\b\d{5}\b/g)?.at(-1);
  if (zip && zip !== job.zip) return `The address is in ZIP ${zip}, but the cleaners found are for ZIP ${job.zip}.`;
  return null;
}

// understood: the job as the agent understood it (searchBody's fields, plus about_cleaning).
// options and nearMisses: from CommonTape's search for that job. customer: needed only for a real booking.
export function decide({ dryRun = true, understood, options = [], nearMisses = [], customer, now = Date.now() } = {}) {
  // Anything but dryRun: false is a dry run, and only a job the agent said in so many words is about cleaning goes on.
  if (dryRun !== false) dryRun = true;
  if (understood?.about_cleaning !== true) {
    return none("I only book home cleaning, and this request is not about cleaning a home.");
  }
  let job;
  try {
    job = searchBody(understood);
  } catch (err) {
    if (err instanceof JobError) return none(err.message);
    throw err;
  }

  const fitting = options.filter((o) => fits(o, job, now))
    .sort((a, b) => a.price.amount - b.price.amount || Date.parse(a.window_start) - Date.parse(b.window_start));
  if (!fitting.length) {
    const said = nearMisses.flatMap((m) => m.reasons.map((r) => `${m.display_name}: ${r.label}`));
    if (said.length) return none(`No cleaner fits this request. ${said.join(" ")}`);
    if (options.length && job.max_total != null) return none(`No cleaner can do this for $${job.max_total} or less.`);
    return none(`No cleaner on CommonTape can do ${SERVICE_WORDS[job.service_key]} in ZIP ${job.zip} at the times asked.`);
  }
  const choice = fitting[0];

  if (dryRun) return none(`This was a dry run, so nothing was booked. I would book ${describe(choice)}.`, choice);
  const problem = customerProblem(customer, job);
  if (problem) return none(problem, choice);
  return { action: "book", reason: `Booking ${describe(choice)}.`, choice };
}

// One hold and one book per request: the keys come from the request itself, so sending the same request again
// gets CommonTape's first answer back instead of a second booking.
export function bookingKeys(request) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  const { text, audio_base64, image_base64, customer } = request ?? {};
  const hash = createHash("sha256").update(JSON.stringify(canonical({ text, audio_base64, image_base64, customer }))).digest("hex").slice(0, 40);
  return { hold: `muse-hold-${hash}`, book: `muse-book-${hash}` };
}
