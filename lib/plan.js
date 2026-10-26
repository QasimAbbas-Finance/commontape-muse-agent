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

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// A moment as the business's own calendar sees it: which day (counted from 1970), the weekday (Mon = 0) and the hour.
function local(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: Date.UTC(+p.year, +p.month - 1, +p.day) / 86_400_000, weekday: WEEKDAYS.indexOf(p.weekday), hour: +p.hour };
}

const PARTS = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] };

// Chooses the open window that matches the times asked for (part_of_day, next_week), in the business's time zone:
// the soonest one that fits, or none, so a business with no time that fits is never offered.
export function windowPicker(understood = {}, now = Date.now()) {
  return (windows, match) => {
    const tz = match?.timezone || "America/New_York";
    const today = local(now, tz);
    const monday = today.day - today.weekday + 7;
    const part = PARTS[understood.part_of_day];
    return [...windows].sort((a, b) => Date.parse(a.window_start) - Date.parse(b.window_start)).find((w) => {
      const start = Date.parse(w.window_start);
      if (!(start > now)) return false;
      const at = local(start, tz);
      if (understood.next_week === true && !(at.day >= monday && at.day < monday + 7)) return false;
      return !part || (at.hour >= part[0] && at.hour < part[1]);
    });
  };
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

// A short label for one customer that says nothing about them: what CommonTape asks for to tell apart two people
// booking the same job at the same business (it allows letters, digits and . _ : - up to 64 characters).
export function customerRef(customer) {
  const { name, phone, service_address, email } = customer ?? {};
  return `cust-${createHash("sha256").update(JSON.stringify([name, phone, service_address, email])).digest("hex").slice(0, 24)}`;
}
