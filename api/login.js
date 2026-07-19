import { handleLogin } from "../lib/auth.mjs";
import { readJsonBody, sendJson } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST uniquement" });
  await handleLogin(req, res, readJsonBody);
}
