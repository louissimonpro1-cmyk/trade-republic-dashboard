import { getLogo } from "../../lib/service.mjs";
import { guard } from "../../lib/http.mjs";

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const isin = String(req.query?.isin || "");
  if (!/^[A-Z0-9]{12}$/.test(isin)) { res.statusCode = 400; return res.end(); }
  const hit = await getLogo(isin, req.query?.theme);
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (hit.ok) {
    res.setHeader("Content-Type", "image/svg+xml");
    return res.end(hit.body);
  }
  res.statusCode = 404;
  res.end();
}
