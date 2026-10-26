// CommonTape's public agent connection (https://commontape.com/docs), the same one any AI assistant uses.
// The published demo key reaches only "CommonTape Demo Cleaning", a pretend business, so nothing here can book a real cleaner.

export const CT_BASE = "https://commontape.com";
export const DEMO_KEY = "ct_demo_nQz4WaXqJvMoL8A6FYCaRtpJnsF7UrZh";

const READS = ["search", "discover", "quote", "status"];
const WRITES = ["hold", "book", "cancel"];
// The longest a call waits for CommonTape to say "try again", so one request stays inside the function's 60 seconds.
const MAX_WAIT_MS = 10_000;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// A client is read-only unless it is made with readOnly: false, so a dry run cannot hold or book even by mistake.
// Every call answers { ok, status, body }; status 0 means CommonTape could not be reached.
export function createClient({ base = CT_BASE, key = DEMO_KEY, readOnly = true, fetch = globalThis.fetch, gapMs = 250, retries = 2, sleep = pause, now = Date.now } = {}) {
  let last = -Infinity;

  async function post(name, body) {
    for (let attempt = 0; ; attempt++) {
      // The demo key is shared by everyone trying CommonTape, so calls are spaced out.
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      let res, data;
      try {
        res = await fetch(`${base}/api/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        if (attempt < retries) continue;
        return { ok: false, status: 0, body: { error: { code: "UNREACHABLE", message: `CommonTape could not be reached: ${err.message}` } } };
      }
      if (res.status === 429 && attempt < retries) {
        const seconds = Number(data?.error?.retry_after_seconds ?? res.headers.get("retry-after") ?? attempt + 1);
        if (seconds * 1000 <= MAX_WAIT_MS) { await sleep(seconds * 1000); continue; }
      }
      return { ok: res.ok, status: res.status, body: data };
    }
  }

  const client = {};
  for (const name of READS) client[name] = (body) => post(name, body);
  for (const name of WRITES) {
    client[name] = (body) => {
      if (readOnly) throw new Error(`This is a dry run, so CommonTape's ${name} is never called.`);
      // One key per write, kept across retries, so a retry can never hold or book twice.
      return post(name, { ...body, idempotency_key: body.idempotency_key ?? crypto.randomUUID() });
    };
  }
  return client;
}

// The agent's options: one per business and service CommonTape priced, at CommonTape's exact price, with an open time.
// pickWindow chooses the time from the business's open windows (the first one unless the job asks for something else).
export function optionsFrom(search, pickWindow = (windows) => windows[0]) {
  const options = [];
  for (const m of search?.matches ?? []) {
    if (typeof m.quote?.amount !== "number") continue;
    const w = pickWindow(m.available_windows ?? []);
    if (!w?.allocation_id) continue;
    options.push({
      slug: m.slug,
      display_name: m.display_name,
      service_key: m.service_key,
      price: { amount: m.quote.amount, currency: m.quote.currency },
      window_start: w.window_start,
      window_end: w.window_end,
      allocation_id: w.allocation_id,
    });
  }
  return options;
}

// Businesses that could not take the job, with CommonTape's own reasons (over_max_total when it is over the budget).
export function nearMissesFrom(search) {
  return (search?.near_misses ?? []).map((m) => ({
    slug: m.slug,
    display_name: m.display_name,
    service_key: m.service_key,
    reasons: (m.reasons ?? []).map((r) => ({ code: r.code, label: r.label })),
  }));
}
