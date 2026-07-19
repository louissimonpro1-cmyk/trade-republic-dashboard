// Password protection, active only when DASHBOARD_PASSWORD is set (Internet hosting).
// Stateless: the cookie holds an HMAC token derived from the password, so it stays
// valid across serverless cold starts and server restarts.
import crypto from "node:crypto";

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
export const AUTH_ENABLED = PASSWORD.length > 0;

const AUTH_TOKEN = AUTH_ENABLED
  ? crypto.createHmac("sha256", PASSWORD).update("tr-dashboard-auth-v1").digest("hex")
  : null;

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export function verifyPassword(candidate) {
  return AUTH_ENABLED && safeEqual(candidate || "", PASSWORD);
}

export function isAuthedCookie(cookieHeader) {
  if (!AUTH_ENABLED) return true;
  if (!cookieHeader) return false;
  const m = cookieHeader.split(/;\s*/).find((c) => c.startsWith("auth="));
  return !!m && safeEqual(m.slice(5), AUTH_TOKEN);
}

export function makeCookie(secure) {
  return `auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${secure ? "; Secure" : ""}`;
}
export function clearCookie(secure) {
  return `auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// naive per-IP brute-force throttle (in-memory, per instance)
const attempts = new Map(); // ip -> { count, resetAt }
export function rateLimited(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  e.count++;
  return e.count > 10;
}
export function clearAttempts(ip) {
  attempts.delete(ip);
}

// shared login endpoint logic (plain Node req/res, works locally and on Vercel)
export async function handleLogin(req, res, readBody) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");
  const fail = (code, error) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error }));
  };
  if (!AUTH_ENABLED) return fail(400, "Aucun mot de passe configuré sur ce serveur.");
  if (rateLimited(ip)) return fail(429, "Trop de tentatives, réessaie dans 15 minutes.");
  const body = await readBody(req).catch(() => ({}));
  if (!verifyPassword(body?.password)) return fail(401, "Mot de passe incorrect.");
  clearAttempts(ip);
  res.statusCode = 204;
  res.setHeader("Set-Cookie", makeCookie(secure));
  res.end();
}
