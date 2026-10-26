// Local stand-in for Vercel: serves public/ and routes /api/agent to the same handlers Vercel runs.
// Usage: npm run dev  (PORT defaults to 3000)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = resolve(import.meta.dirname, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav" };

async function api(req, res) {
  const handlers = await import("../api/agent.js");
  const handler = handlers[req.method];
  if (typeof handler !== "function") {
    res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: "half",
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function file(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  const target = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!target.startsWith(PUBLIC)) return res.writeHead(404).end();
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": TYPES[extname(target)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

createServer((req, res) => {
  const route = req.url.startsWith("/api/agent") ? api : file;
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong on our side." }));
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
