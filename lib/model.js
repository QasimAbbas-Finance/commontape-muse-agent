// The model that understands the request, one of three:
// - muse: with a Meta key, Muse Spark through the Meta Model API (OpenAI-compatible chat completions, tools and vision)
//   and Muse Voice Transcribe for voice notes. Shapes from Meta's own cookbook (github.com/meta-models/meta-model-cookbook).
// - open: with a Baseten key, Meta's open-weights Muse Spark Open on Baseten's Model APIs (the same chat completions, tools,
//   photos as image_url and voice notes as audio_url, so it hears the voice note itself). Shapes from docs.baseten.co.
// - stub: with no key, a stand-in made of plain rules, named "stub-no-key" in the trace so it is never mistaken for Muse.
// All read 26 Oct 2026.
import OpenAI from "openai";
import { SERVICES, HOME_TYPES } from "./job.js";

export const STUB_NAME = "stub-no-key";

export class ModelError extends Error {}

// The one tool Muse Spark gets: its arguments are the job as it understood it, in CommonTape's words.
export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_cleaners",
    description: "Search CommonTape for home cleaning businesses that can do this job, with their exact prices and open times.",
    parameters: {
      type: "object",
      properties: {
        about_cleaning: { type: "boolean", description: "true only if the person wants their home cleaned." },
        zip: { type: "string", description: "The home's 5-digit US ZIP code, only if the person gave it." },
        service_key: { type: "string", enum: SERVICES, description: "standard unless they ask for a deep clean or a move-in or move-out clean." },
        home_type: { type: "string", enum: HOME_TYPES },
        bedrooms: { type: "integer", minimum: 0, maximum: 20 },
        full_bathrooms: { type: "integer", minimum: 0, maximum: 20, description: "Bathrooms with a shower or a bath." },
        half_bathrooms: { type: "integer", minimum: 0, maximum: 20, description: "Bathrooms with only a toilet and a sink." },
        max_total: { type: "number", description: "The most they will pay in all, in US dollars, only if they said so." },
        part_of_day: { type: "string", enum: ["morning", "afternoon", "evening"] },
        next_week: { type: "boolean", description: "true if they asked for next week." },
        seen_in_photo: { type: "string", description: "If there is a photo: the rooms and the state they are in, in one sentence." },
        heard: { type: "string", description: "If there is a voice note: what the person said, word for word." },
      },
      required: ["about_cleaning"],
    },
  },
};

const SYSTEM = `You book home cleaning through CommonTape. Read the person's request (their words, their voice note and their
photo, whichever they sent) and call search_cleaners once with the job as they described it. Use only facts they gave or that
the photo plainly shows; never invent a ZIP code, a budget or a room count. If the request is not about cleaning a home, call
search_cleaners with about_cleaning false.`;

const imageType = (b64) => (b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("UklGR") ? "image/webp" : "image/jpeg");

export function createModel(env = process.env, { fetch = globalThis.fetch } = {}) {
  const mode = env.MODEL_MODE || (env.MODEL_API_KEY ? "muse" : env.BASETEN_API_KEY ? "open" : "stub");
  if (mode === "stub") return stubModel();
  if (mode === "muse") {
    if (!env.MODEL_API_KEY) throw new ModelError("MODEL_MODE is muse but MODEL_API_KEY is not set.");
    return museModel({
      key: env.MODEL_API_KEY,
      base: env.MODEL_BASE_URL || "https://api.meta.ai/v1",
      model: env.MODEL_ID || "muse-spark-1.3",
      asr: env.ASR_MODEL || "muse-voice-transcribe-1.0",
      fetch,
    });
  }
  if (mode === "open") {
    if (!env.BASETEN_API_KEY) throw new ModelError("MODEL_MODE is open but BASETEN_API_KEY is not set.");
    return openModel({
      key: env.BASETEN_API_KEY,
      base: env.OPEN_BASE_URL || "https://inference.baseten.co/v1",
      model: env.OPEN_MODEL_ID || "meta-models/muse-spark-open-1026",
      fetch,
    });
  }
  throw new ModelError(`MODEL_MODE must be muse, open or stub, not ${mode}.`);
}

// One chat completion with the search tool: the request's words, plus its photo and voice note when there are any.
async function understandWith(client, model, label, { text, image_base64, audio_base64 }) {
  const content = [{ type: "text", text: text || (audio_base64 ? "(The request is in the voice note.)" : "(No words: only a photo of the home.)") }];
  if (image_base64) content.push({ type: "image_url", image_url: { url: `data:${imageType(image_base64)};base64,${image_base64}` } });
  if (audio_base64) content.push({ type: "audio_url", audio_url: { url: `data:audio/wav;base64,${audio_base64}` } });
  let reply;
  try {
    reply = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
      tools: [SEARCH_TOOL],
    });
  } catch (err) {
    throw new ModelError(`${label} did not answer: ${err.message}`);
  }
  const message = reply.choices?.[0]?.message ?? {};
  const call = (message.tool_calls ?? []).find((c) => c.function?.name === "search_cleaners");
  if (!call) return { about_cleaning: false, said: message.content ?? "" };
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new ModelError(`${label}'s job could not be read.`);
  }
}

// Muse Spark Open on Baseten hears the voice note itself, in the same call that works out the job.
function openModel({ key, base, model, fetch }) {
  const client = new OpenAI({ apiKey: key, baseURL: base, fetch, maxRetries: 1, timeout: 45_000 });
  return {
    name: model.split("/").pop(),
    asrName: null,
    seesImages: true,
    hearsAudio: true,
    transcribe: null,
    understand: (request) => understandWith(client, model, "Muse Spark Open", request),
  };
}

function museModel({ key, base, model, asr, fetch }) {
  const client = new OpenAI({ apiKey: key, baseURL: base, fetch, maxRetries: 1, timeout: 40_000 });
  return {
    name: model,
    asrName: asr,
    seesImages: true,
    hearsAudio: false,
    understand: ({ text, image_base64 }) => understandWith(client, model, "Muse Spark", { text, image_base64 }),
    async transcribe(audio_base64) {
      // A multipart upload: the settings as a JSON part, then the WAV file, as in Meta's cookbook.
      const boundary = `muse-${crypto.randomUUID()}`;
      const settings = JSON.stringify({ mode: "PUSH_TO_TALK", model: asr, audioEncoding: "WAV", keywords: ["ZIP code", "bedroom", "bathroom", "CommonTape"] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${settings}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice-note.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        Buffer.from(audio_base64, "base64"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      let res;
      try {
        res = await fetch(`${base}/asr/transcribe`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(40_000),
        });
      } catch (err) {
        throw new ModelError(`Muse Voice Transcribe did not answer: ${err.message}`);
      }
      if (!res.ok) throw new ModelError(`Muse Voice Transcribe answered ${res.status}.`);
      return String((await res.json()).transcript ?? "").trim();
    },
  };
}

// The stand-in: plain rules over the words. It cannot hear a voice note or see a photo, and says so.
const NUMBERS = { no: 0, zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DIGITS = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const COUNT = `(\\d+|${Object.keys(NUMBERS).join("|")})`;
const count = (text, after) => {
  const m = text.match(new RegExp(`\\b${COUNT}[\\s-]*${after}`, "i"));
  return m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1].toLowerCase()]) : undefined;
};

export function stubUnderstand(text = "") {
  const t = text.replace(/\s+/g, " ");
  const job = { about_cleaning: /\b(clean|cleaner|cleaning|maid|housekeep|tidy|scrub)/i.test(t) };
  const spoken = t.match(new RegExp(`\\b(?:zip|postcode|postal code)(?: code)?(?: is)?,? ((?:(?:${Object.keys(DIGITS).join("|")})\\b[\\s,-]*){5})`, "i"));
  const zip = t.match(/\b\d{5}\b/)?.[0] ?? (spoken ? spoken[1].trim().split(/[\s,-]+/).map((w) => DIGITS[w.toLowerCase()]).join("") : undefined);
  if (zip) job.zip = zip;
  job.service_key = /\bdeep\b/i.test(t) ? "house_cleaning.deep" : /\bmov(e|ing)[\s-]*(in|out)\b/i.test(t) ? "house_cleaning.move_in_out" : "house_cleaning.standard";
  const home = [
    [/\bstudio\b/i, "property.studio"], [/\b(apartment|flat|apt)\b/i, "property.apartment"], [/\bcondo/i, "property.condo"],
    [/\btown ?house\b/i, "property.townhouse"], [/\bduplex\b/i, "property.duplex"], [/\bvilla\b/i, "property.villa"],
    [/\bhouse\b(?! ?clean)/i, "property.detached_house"],
  ].find(([re]) => re.test(t));
  if (home) job.home_type = home[1];
  const bedrooms = count(t, "(?:bed(?:room)?s?|br)\\b");
  if (bedrooms !== undefined) job.bedrooms = bedrooms;
  const half = count(t, "half[\\s-]*bath");
  if (half !== undefined) job.half_bathrooms = half;
  const full = count(t.replace(new RegExp(`\\b${COUNT}[\\s-]*half[\\s-]*bath\\w*`, "gi"), ""), "(?:full[\\s-]*)?bath(?:room)?s?\\b");
  if (full !== undefined) job.full_bathrooms = full;
  const money = t.match(/\$\s?(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s?(?:dollars|bucks|usd)\b/i);
  if (money) job.max_total = Number(money[1] ?? money[2]);
  const part = t.match(/\b(morning|afternoon|evening)/i);
  if (part) job.part_of_day = part[1].toLowerCase();
  if (/\bnext week\b/i.test(t)) job.next_week = true;
  return job;
}

function stubModel() {
  return {
    name: STUB_NAME,
    asrName: null,
    seesImages: false,
    hearsAudio: false,
    async understand({ text }) {
      return stubUnderstand(text);
    },
    transcribe: null,
  };
}
