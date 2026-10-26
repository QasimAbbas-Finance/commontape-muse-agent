// The page: sends the request to the agent as a dry run, shows what came back, and books only when the person asks.
// Voice notes are recorded in the browser and sent as mono 16-bit 24 kHz WAV, the format Muse Voice Transcribe takes;
// photos are shrunk in the browser (which also drops their camera details) to stay well under the host's body limit.
const API = "/api/agent";
const MAX_RECORD_MS = 45_000;
const PHOTO_EDGE = 1280;
const RATE = 24_000;
const SERVICE_WORDS = {
  "house_cleaning.standard": "Standard clean",
  "house_cleaning.deep": "Deep clean",
  "house_cleaning.move_in_out": "Move-in or move-out clean",
};
const SAMPLE = { name: "Sam Rivera", phone: "212 555 0147", service_address: "350 W 31st St, Apt 4, New York, NY 10001", email: "" };

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}

const attached = { audio: null, audioSeconds: 0, image: null, imageSize: "" };
let last = null; // the request last sent as a dry run, and its answer

// What this copy can do: say so before anyone asks.
fetch(API).then((r) => r.json()).then((s) => {
  if (s.meta_key_connected) return;
  const note = $("key-note");
  note.hidden = false;
  note.textContent = "Meta key not connected yet. Until it is, a stand-in that follows simple rules reads typed requests, and the trace says so (stub-no-key). Voice notes and photos need Muse.";
}).catch(() => {});

for (const chip of document.querySelectorAll("[data-example]")) {
  chip.addEventListener("click", () => { $("text").value = chip.dataset.example; $("text").focus(); });
}

// Voice notes: record, then turn whatever the browser recorded into mono 16-bit WAV at 24 kHz.
async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { wav: new Blob([view.buffer], { type: "audio/wav" }), seconds: decoded.duration };
}

const toBase64 = (blob) => new Promise((done, fail) => {
  const reader = new FileReader();
  reader.onload = () => done(String(reader.result).split(",")[1]);
  reader.onerror = () => fail(reader.error);
  reader.readAsDataURL(blob);
});

let recorder = null;
$("record").addEventListener("click", async () => {
  const button = $("record");
  if (recorder) { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showAttached("The microphone is not available here, so type the request instead.");
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const timer = setTimeout(() => recorder?.stop(), MAX_RECORD_MS);
  recorder.onstop = async () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    button.textContent = "Record a voice note";
    button.classList.remove("recording");
    try {
      const { wav, seconds } = await toWav(new Blob(chunks, { type: chunks[0]?.type }));
      attached.audio = await toBase64(wav);
      attached.audioSeconds = seconds;
    } catch {
      attached.audio = null;
      showAttached("That recording could not be read. Try again, or type the request.");
      return;
    }
    showAttached();
  };
  recorder.start();
  button.textContent = "Stop recording";
  button.classList.add("recording");
});

// Photos: shrink so the longest side is at most 1280 px, as a JPEG.
$("photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const image = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, PHOTO_EDGE / Math.max(image.width, image.height));
    const canvas = el("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.82));
    attached.image = await toBase64(jpeg);
    attached.imageSize = `${canvas.width}×${canvas.height}, ${Math.round(jpeg.size / 1024)} KB`;
  } catch {
    attached.image = null;
    showAttached("That photo could not be read. Try a JPEG or PNG.");
    return;
  }
  showAttached();
});

function showAttached(message) {
  const box = $("attached");
  box.replaceChildren();
  if (message) box.append(el("span", { class: "error" }, message), " ");
  if (attached.audio) {
    box.append(el("div", {}, `Voice note: ${attached.audioSeconds.toFixed(0)} s `,
      el("button", { type: "button", class: "chip", onclick: () => { attached.audio = null; showAttached(); } }, "Remove")));
  }
  if (attached.image) {
    box.append(el("div", {}, `Photo: ${attached.imageSize} `,
      el("button", { type: "button", class: "chip", onclick: () => { attached.image = null; $("photo").value = ""; showAttached(); } }, "Remove")));
  }
}

async function ask(request) {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const answer = await res.json().catch(() => ({ error: `The agent answered ${res.status}.` }));
  if (!res.ok) throw new Error(answer.error || `The agent answered ${res.status}.`);
  return answer;
}

$("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const request = { dry_run: true };
  const text = $("text").value.trim();
  if (text) request.text = text;
  if (attached.audio) request.audio_base64 = attached.audio;
  if (attached.image) request.image_base64 = attached.image;
  if (!text && !attached.audio && !attached.image) { showResult(el("p", { class: "error" }, "Type what you need, record a voice note or add a photo.")); return; }
  const go = $("go");
  go.disabled = true;
  go.textContent = "Looking…";
  showResult(el("p", { class: "muted" }, "The agent is reading your request and asking CommonTape…"));
  try {
    const answer = await ask(request);
    last = { request, answer };
    render(answer);
  } catch (err) {
    showResult(el("p", { class: "error" }, err.message));
  } finally {
    go.disabled = false;
    go.textContent = "Find a cleaner";
  }
});

const showResult = (...nodes) => $("result").replaceChildren(...nodes);
const money = (p) => (p.currency === "USD" ? `$${p.amount}` : `${p.amount} ${p.currency}`);
const when = (o) => new Intl.DateTimeFormat("en-US", {
  timeZone: o.timezone || "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(o.window_start));
const sameChoice = (o, c) => c && o.slug === c.slug && o.allocation_id === c.allocation_id;

function stepWords(t) {
  if (t.step === "model" && t.name === "stub-no-key") return `A stand-in with no Meta key read the ${t.input} (stub-no-key)`;
  if (t.step === "model") return `Meta's ${t.name} read the ${t.input === "audio" ? "voice note" : t.input}`;
  return `CommonTape ${t.name}`;
}

function render(answer) {
  const nodes = [];
  if (answer.transcript) nodes.push(el("h2", {}, "What I heard"), el("p", {}, `“${answer.transcript}”`));
  if (answer.understood?.seen_in_photo) nodes.push(el("h2", {}, "What Muse saw in the photo"), el("p", {}, answer.understood.seen_in_photo));
  if (answer.read_back?.length) nodes.push(el("h2", {}, "What CommonTape understood"), el("ul", {}, answer.read_back.map((line) => el("li", {}, line))));
  if (answer.options?.length) {
    nodes.push(el("h2", {}, "Cleaners that can do it"));
    for (const o of answer.options) {
      nodes.push(el("div", { class: sameChoice(o, answer.plan?.choice) ? "card chosen" : "card" },
        el("div", {}, el("strong", {}, o.display_name), " · ", SERVICE_WORDS[o.service_key] ?? o.service_key),
        el("div", {}, el("span", { class: "price" }, money(o.price)), " in all · ", when(o))));
    }
  } else if (answer.near_misses?.length) {
    nodes.push(el("h2", {}, "Close, but not a fit"), el("ul", {}, answer.near_misses.flatMap((m) => m.reasons.map((r) => el("li", {}, `${m.display_name}: ${r.label}`)))));
  }
  if (answer.plan) nodes.push(el("h2", {}, "The plan"), el("p", { class: answer.booked ? "plan-book" : "" }, answer.plan.reason));
  if (answer.booked) {
    nodes.push(el("div", { class: "card chosen" },
      el("div", {}, el("strong", {}, `Booked: ${answer.booked.business}`)),
      el("div", {}, `${money(answer.booked.price)} · ${when({ window_start: answer.booked.window_start, timezone: answer.plan.choice?.timezone })}`),
      el("div", { class: "small muted" }, `CommonTape says: ${answer.booked.state}. Reference ${String(answer.booked.transaction_id).slice(0, 8)}.`)));
  } else if (answer.dry_run && answer.plan?.choice) {
    nodes.push(el("div", { class: "row" }, el("button", { type: "button", class: "primary", id: "book-open", onclick: openBooking }, "Book this")));
  }
  if (answer.trace?.length) {
    nodes.push(el("details", {}, el("summary", {}, `How the agent worked (${answer.trace.length} steps)`),
      el("ol", {}, answer.trace.map((t) => el("li", {}, stepWords(t), t.input && typeof t.input === "object" ? el("div", {}, el("code", {}, JSON.stringify(t.input))) : null)))));
  }
  showResult(...nodes);
}

function openBooking() {
  $("book-open")?.remove();
  const field = (id, label, type, extra = {}) => [el("label", { for: id }, label), el("input", { id, type, ...extra })];
  const form = el("form", { id: "book" },
    el("h2", {}, "Book it"),
    el("p", { class: "small muted" }, "This books the pretend demo business, so made-up details are fine. The address has to be in ZIP 10001."),
    field("c-name", "Name", "text", { autocomplete: "name", required: "" }),
    field("c-phone", "Phone", "tel", { autocomplete: "tel", required: "" }),
    field("c-address", "Address to clean", "text", { autocomplete: "street-address", required: "", placeholder: SAMPLE.service_address }),
    field("c-email", "Email (optional)", "email", { autocomplete: "email" }),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: () => { $("c-name").value = SAMPLE.name; $("c-phone").value = SAMPLE.phone; $("c-address").value = SAMPLE.service_address; } }, "Use sample details"),
      el("button", { type: "submit", class: "primary", id: "book-go" }, "Book it")),
    el("p", { id: "book-error", class: "error", "aria-live": "polite" }));
  form.addEventListener("submit", book);
  $("result").append(form);
  $("c-name").focus();
}

async function book(e) {
  e.preventDefault();
  const choice = last.answer.plan.choice;
  const customer = { name: $("c-name").value.trim(), phone: $("c-phone").value.trim(), service_address: $("c-address").value.trim() };
  if ($("c-email").value.trim()) customer.email = $("c-email").value.trim();
  const go = $("book-go");
  go.disabled = true;
  go.textContent = "Booking…";
  try {
    const answer = await ask({ ...last.request, dry_run: false, customer, confirm: { slug: choice.slug, allocation_id: choice.allocation_id, amount: choice.price.amount } });
    render(answer);
  } catch (err) {
    $("book-error").textContent = err.message;
    go.disabled = false;
    go.textContent = "Book it";
  }
}
