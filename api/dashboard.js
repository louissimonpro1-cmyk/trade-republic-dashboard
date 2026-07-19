import { getDashboard } from "../lib/service.mjs";
import { guard, sendJson } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  try {
    sendJson(res, 200, await getDashboard());
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}
