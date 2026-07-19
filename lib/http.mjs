// Small helpers shared by the Vercel functions (plain Node req/res API).
import { AUTH_ENABLED, isAuthedCookie } from "./auth.mjs";

export function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

// returns true when the request may proceed; otherwise responds 401 itself
export function guard(req, res) {
  if (!AUTH_ENABLED || isAuthedCookie(req.headers.cookie)) return true;
  sendJson(res, 401, { error: "non authentifié" });
  return false;
}

export const readJsonBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined) return resolve(req.body); // Vercel pre-parses JSON bodies
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 4096) reject(new Error("body trop long")); });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});
