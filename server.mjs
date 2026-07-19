// Trade Republic dashboard - local server.
// Zero-dependency: Node built-ins only. Run with `node server.mjs` then open
// http://localhost:3457. Set DASHBOARD_PASSWORD to require a login (Internet use).
// The business logic lives in lib/service.mjs, shared with the Vercel functions.
import http from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboard, getPerf, getLogo, PERF_RANGES } from "./lib/service.mjs";
import { AUTH_ENABLED, isAuthedCookie, handleLogin, clearCookie } from "./lib/auth.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3457;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// paths reachable without login (static shell, login flow, PWA assets)
const PUBLIC_PATHS = new Set([
  "/login.html", "/style.css", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/api/login",
]);

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined) return resolve(req.body); // pre-parsed (Vercel-style)
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 4096) reject(new Error("body trop long")); });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/login" && req.method === "POST") return handleLogin(req, res, readJsonBody);
    if (url.pathname === "/api/logout") {
      res.writeHead(302, { "Set-Cookie": clearCookie(false), Location: "/login.html" });
      return res.end();
    }

    if (AUTH_ENABLED && !isAuthedCookie(req.headers.cookie) && !PUBLIC_PATHS.has(url.pathname)) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "non authentifié" });
      res.writeHead(302, { Location: "/login.html" });
      return res.end();
    }

    if (url.pathname === "/api/dashboard") return json(res, 200, await getDashboard());
    if (url.pathname === "/api/perf") {
      const range = url.searchParams.get("range") || "max";
      if (!PERF_RANGES.includes(range)) return json(res, 400, { error: "range invalide" });
      return json(res, 200, await getPerf(range));
    }
    const logo = url.pathname.match(/^\/api\/logo\/([A-Z0-9]{12})$/);
    if (logo) {
      const hit = await getLogo(logo[1], url.searchParams.get("theme"));
      if (hit.ok) {
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
        return res.end(hit.body);
      }
      res.writeHead(404, { "Cache-Control": "public, max-age=86400" });
      return res.end();
    }

    // static files
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const body = await fs.readFile(full);
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Introuvable");
    }
  } catch (e) {
    console.error(`[erreur] ${url.pathname}:`, e.message);
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard Trade Republic : http://localhost:${PORT}`);
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  for (const ip of lan) console.log(`Sur le reseau local (telephone) : http://${ip}:${PORT}`);
  console.log(AUTH_ENABLED ? "Mot de passe : ACTIF" : "Mot de passe : inactif (definir DASHBOARD_PASSWORD pour proteger)");
  console.log("Premier chargement : recuperation des cours Yahoo Finance (~15-30 s), ensuite mis en cache.");
});
