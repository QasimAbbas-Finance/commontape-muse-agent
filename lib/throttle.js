// A polite limit in front of the agent, so one person or a crowd cannot use up the demo key everyone shares
// (CommonTape allows it 30 calls a minute). One-minute sliding windows, kept in this copy's memory: per person, by the
// address Vercel puts in x-forwarded-for (Vercel overwrites it, so it cannot be faked), and for the whole copy.
// Vercel may run several copies at once, so this is a first line; CommonTape's own limit stays the last word.

export function createThrottle({ perPerson = 12, total = 25, windowMs = 60_000, clock = Date.now, maxPeople = 5_000 } = {}) {
  const seen = new Map(); // key -> times of the requests let through, oldest first

  const recent = (key, t) => {
    const times = (seen.get(key) ?? []).filter((at) => at > t - windowMs);
    if (times.length) seen.set(key, times);
    else seen.delete(key);
    return times;
  };

  // Answers { ok: true }, or { ok: false, retryAfter } in whole seconds. Nothing is counted for a refused request.
  return function allow(person) {
    const t = clock();
    if (seen.size > maxPeople) for (const key of [...seen.keys()]) recent(key, t);
    const mine = recent(`person:${person}`, t);
    const all = recent("total", t);
    // A full window frees a place when its oldest counted request is a window old.
    const waitFor = (times, limit) => (times.length < limit ? 0 : times[times.length - limit] + windowMs - t);
    const wait = Math.max(waitFor(mine, perPerson), waitFor(all, total));
    if (wait > 0) return { ok: false, retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
    seen.set(`person:${person}`, [...mine, t]);
    seen.set("total", [...all, t]);
    return { ok: true };
  };
}

// The person's address as Vercel gives it; anything else (a local run) counts as one person.
export function personFrom(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}
