// Drives the page in headless Chrome at phone width (390 px) against a running local server, over the DevTools
// protocol with no extra packages: a typed request end to end, a recorded voice note (Chrome's fake microphone) checked
// with ffprobe, a photo shrunk in the browser, and the "Book it" step up to the request it sends. The booking answer
// itself is a stand-in, so this check never books anything.
// Usage: CHROME="/path/to/Google Chrome for Testing" BASE=http://localhost:3999 node scripts/page-check.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME;
const BASE = process.env.BASE || "http://localhost:3000";
if (!CHROME || !existsSync(CHROME)) throw new Error("Set CHROME to a Chrome or Chrome for Testing binary.");
const dir = mkdtempSync(join(tmpdir(), "page-check-"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "profile")}`, "--no-first-run",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank",
], { stdio: "ignore" });

try {
  const portFile = join(dir, "profile", "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++seq;
    pending.set(id, (d) => (d.error ? fail(new Error(`${method}: ${d.error.message}`)) : done(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await js(expression)) return true;
    throw new Error(`timed out waiting for ${expression}`);
  };
  const noSideways = () => js("document.documentElement.scrollWidth <= window.innerWidth");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.enable");
  await send("Page.navigate", { url: BASE });
  await until("document.readyState === 'complete' && !!document.getElementById('ask')");

  const key = await until("!document.getElementById('key-note').hidden", 10_000).then(() => js("document.getElementById('key-note').textContent"));
  check(/Meta key not connected yet/.test(key), "the page says the Meta key is not connected (stand-in mode)");
  const page1 = await js("document.body.innerText");
  check(/Muse/.test(page1) && /CommonTape/.test(page1) && /pretend business/.test(page1), "the page names Muse and CommonTape and states the demo's limits");
  check(await noSideways(), "390 px: no sideways scroll before a request");

  // Record the request bodies the page sends (this wrapper lives only in this check, not in the page).
  await js("window.__bodies = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.__bodies.push(JSON.parse(o.body)); return f(u, o); }; true");

  // Typed request, end to end against the local server (stand-in model, live CommonTape, dry run).
  await js("document.querySelector('[data-example]').click(); document.getElementById('go').click(); true");
  await until("/The plan/.test(document.getElementById('result').innerText)");
  const typed = await js("({ text: document.getElementById('result').innerText, cards: document.querySelectorAll('#result .card').length, book: !!document.getElementById('book-open') })");
  check(typed.cards >= 1 && /\$\d+/.test(typed.text), `typed request: ${typed.cards} priced option(s) shown`);
  check(/dry run, so nothing was booked/.test(typed.text) && typed.book, "the plan says nothing was booked and offers \"Book this\"");
  check(/How the agent worked \(2 steps\)/.test(typed.text), "the trace is shown (2 steps)");
  check(await noSideways(), "390 px: no sideways scroll with results");

  // Book it: the form, the sample details, and the request it sends; the answer is a stand-in, so nothing is booked.
  await js("document.getElementById('book-open').click(); [...document.querySelectorAll('#book button')].find(b => /sample/.test(b.textContent)).click(); true");
  await js(`window.__realFetch = window.fetch; window.fetch = async (u, o) => { const b = JSON.parse(o.body); window.__bodies.push(b);
    return new Response(JSON.stringify({ dry_run: false, transcript: null, job: {}, options: [], trace: [], plan: { action: "book", reason: "Booking (stand-in answer).", choice: { timezone: "America/New_York" } },
      booked: { transaction_id: "00000000-check", state: "booked", business: "CommonTape Demo Cleaning", price: { amount: 140, currency: "USD" }, window_start: "2026-11-02T13:00:00Z" } }), { status: 200 }); }; true`);
  await js("document.getElementById('book-go').click(); true");
  await until("/Booked: CommonTape Demo Cleaning/.test(document.getElementById('result').innerText)", 10_000);
  const sent = await js("window.__bodies.at(-1)");
  const shown = await js("window.__bodies[0]");
  check(sent.dry_run === false && sent.customer?.name === "Sam Rivera" && /10001/.test(sent.customer?.service_address) && sent.text === shown.text,
    "\"Book it\" resends the same request with dry_run false and the customer's details");
  check(sent.confirm?.slug === "commontape-demo-cleaning" && typeof sent.confirm?.amount === "number" && Boolean(sent.confirm?.allocation_id),
    `"Book it" names the option the person saw (${sent.confirm?.amount} at ${sent.confirm?.allocation_id?.slice(0, 8)})`);
  await js("window.fetch = window.__realFetch; true");

  // Voice note: Chrome's fake microphone, about 2 seconds, then the WAV the page would send goes through ffprobe.
  await js("document.getElementById('record').click(); true");
  await until("document.getElementById('record').classList.contains('recording')", 10_000);
  await sleep(2200);
  await js("document.getElementById('record').click(); true");
  await until("/Voice note:/.test(document.getElementById('attached').innerText)", 15_000);
  await js("document.getElementById('go').click(); true");
  await until("window.__bodies.some(b => b.audio_base64)", 15_000);
  const wav = Buffer.from(await js("window.__bodies.find(b => b.audio_base64).audio_base64"), "base64");
  writeFileSync(join(dir, "recorded.wav"), wav);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate,bits_per_sample", "-of", "compact=p=0:nk=1", join(dir, "recorded.wav")]).toString().trim();
  check(probe === "pcm_s16le|24000|1|16", `the recorded voice note is mono 16-bit 24 kHz WAV (${probe}, ${wav.length} bytes)`);
  await until("/Muse Voice Transcribe/.test(document.getElementById('result').innerText)", 30_000);
  check(true, "without a key the page says voice notes need Muse Voice Transcribe");

  // Photo: a 4000x3000 test image is shrunk in the browser to 1280 px on its longest side.
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=4000x3000:rate=1", "-frames:v", "1", join(dir, "big.jpg")]);
  const { root } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#photo" });
  await send("DOM.setFileInputFiles", { nodeId, files: [join(dir, "big.jpg")] });
  await until("/Photo:/.test(document.getElementById('attached').innerText)", 15_000);
  const photo = await js("document.getElementById('attached').innerText");
  const kb = Number(photo.match(/(\d+) KB/)?.[1]);
  check(/1280×960/.test(photo) && kb > 0 && kb < 1000, `the photo is shrunk in the browser (${photo.match(/Photo: [^R]+/)?.[0].trim()})`);
  check(await noSideways(), "390 px: no sideways scroll with a voice note and a photo attached");

  writeFileSync(join(dir, "page-390.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
  console.log(`screenshot: ${join(dir, "page-390.png")}`);
  ws.close();
} catch (err) {
  console.log(`FAIL ${err.message}`);
  failed++;
} finally {
  chrome.kill();
}
console.log(`page-check: ${failed ? `FAIL (${failed})` : "PASS"}`);
process.exitCode = failed ? 1 : 0;
if (!failed && !process.env.KEEP) rmSync(join(dir, "profile"), { recursive: true, force: true });
