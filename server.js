"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const database = require("./src/database");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const LEGACY_DATA_FILE = process.env.LEGACY_DATA_FILE || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 16 * 1024;
const RESERVED = new Set(["api", "health", "ready", "assets", "favicon.ico"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
}

function requestOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) reject(Object.assign(new Error("Request is too large"), { status: 413 }));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function cleanUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw Object.assign(new Error("Enter a valid URL"), { status: 400 });
  let parsed;
  try { parsed = new URL(value.trim()); }
  catch { throw Object.assign(new Error("Enter a valid URL, including https://"), { status: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Object.assign(new Error("Only HTTP and HTTPS links are supported"), { status: 400 });
  if (!parsed.hostname || parsed.username || parsed.password) throw Object.assign(new Error("This URL cannot be shortened"), { status: 400 });
  return parsed.toString();
}

function cleanSlug(value) {
  if (value === undefined || value === null || value === "") return "";
  const slug = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(slug)) throw Object.assign(new Error("Custom name must be 3–32 letters, numbers, dashes, or underscores"), { status: 400 });
  if (RESERVED.has(slug)) throw Object.assign(new Error("That custom name is reserved"), { status: 409 });
  return slug;
}

function generateSlug() {
  const alphabet = "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(7);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

async function apiCreate(req, res) {
  try {
    if (!await database.allowCreation(clientIp(req))) return json(res, 429, { error: "Too many links created. Try again in a minute." });
    const body = await readJson(req);
    const target = cleanUrl(body.url);
    const requested = cleanSlug(body.slug);
    let link = null;

    if (requested) {
      link = await database.createLink(requested, target);
      if (!link) return json(res, 409, { error: "That custom name is already taken" });
    } else {
      for (let attempt = 0; attempt < 8 && !link; attempt += 1) link = await database.createLink(generateSlug(), target);
      if (!link) throw new Error("Could not generate a unique link");
    }

    json(res, 201, { slug: link.slug, shortUrl: `${requestOrigin(req)}/${link.slug}`, url: link.url });
  } catch (error) {
    console.error("Could not create link:", error.message);
    json(res, error.status || 500, { error: error.status ? error.message : "Something went wrong" });
  }
}

function serveStatic(urlPath, res, status = 200) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return send(res, 404, "Not found");
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, "Not found");
    send(res, status, data, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": requested === "/index.html" ? "no-cache" : "public, max-age=86400"
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(parsed.pathname);

    if (req.method === "GET" && pathname === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && pathname === "/ready") {
      const ready = await database.isReady();
      return json(res, ready ? 200 : 503, { status: ready ? "ready" : "unavailable" });
    }
    if (req.method === "POST" && pathname === "/api/links") return apiCreate(req, res);
    if (req.method === "GET" && (pathname === "/" || pathname.startsWith("/assets/") || pathname === "/favicon.svg")) return serveStatic(pathname, res);

    if (req.method === "GET" && /^\/[A-Za-z0-9_-]+$/.test(pathname)) {
      const link = await database.resolveLink(pathname.slice(1));
      if (!link) return serveStatic("/404.html", res, 404);
      return send(res, 302, "Redirecting…", { Location: link.url, "Cache-Control": "no-store" });
    }

    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!res.headersSent) json(res, 500, { error: "Something went wrong" });
    else res.end();
  }
});

async function start() {
  await database.initialize();
  if (LEGACY_DATA_FILE) await database.importLegacyFile(LEGACY_DATA_FILE);
  server.listen(PORT, "0.0.0.0", () => console.log(`Blink is running on port ${PORT}`));
}

function shutdown() {
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((error) => {
  console.error("Could not start Blink:", error);
  process.exit(1);
});
