import { getAssetSeries } from "../lib/service.mjs";
import { guard, sendJson } from "../lib/http.mjs";

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const isin = String(req.query?.isin || "");
  if (!/^[A-Z0-9]{12}$/.test(isin)) return sendJson(res, 400, { error: "isin invalide" });
  try {
    sendJson(res, 200, await getAssetSeries(isin));
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}
