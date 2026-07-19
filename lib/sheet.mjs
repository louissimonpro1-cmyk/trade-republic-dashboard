// Live access to the Trade Republic activity history stored in the user's Google Sheet.
// The sheet is link-shared, so its CSV export URL is readable without authentication.
// The sheet is configured via the SHEET_URL environment variable (full sharing link
// or bare spreadsheet ID) so that each deployment points to its own history.
import { parseCSV } from "./csv.mjs";

const TTL_MS = 2 * 60 * 1000;

let exportUrl = null;
function resolveExportUrl() {
  if (exportUrl) return exportUrl;
  const raw = process.env.SHEET_URL || process.env.SHEET_ID || "";
  if (!raw) {
    throw new Error("Variable SHEET_URL manquante : renseignez le lien de partage de votre Google Sheet (partagé en « Tous les utilisateurs disposant du lien »).");
  }
  const m = raw.match(/[-\w]{25,}/); // the spreadsheet ID inside a URL, or the bare ID
  if (!m) {
    throw new Error("SHEET_URL invalide : collez le lien complet du Google Sheet ou son identifiant.");
  }
  exportUrl = `https://docs.google.com/spreadsheets/d/${m[0]}/export?format=csv`;
  return exportUrl;
}

let cache = null; // { at, txs }

const num = (s) => (s === undefined || s === "" ? 0 : parseFloat(s));

export async function getTransactions() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.txs;
  try {
    const res = await fetch(resolveExportUrl(), { redirect: "follow" });
    if (!res.ok) throw new Error(`Google Sheet: HTTP ${res.status}`);
    const rows = parseCSV(await res.text());
    const header = rows[0];
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const txs = rows.slice(1)
      .filter((r) => r.length > 5 && r[idx.datetime])
      .map((r) => ({
        datetime: r[idx.datetime],
        date: r[idx.date],
        category: r[idx.category],
        type: r[idx.type],
        assetClass: r[idx.asset_class],
        name: r[idx.name],
        isin: r[idx.symbol],
        shares: num(r[idx.shares]),
        price: num(r[idx.price]),
        amount: num(r[idx.amount]),
        fee: num(r[idx.fee]),
        tax: num(r[idx.tax]),
      }))
      .sort((a, b) => a.datetime.localeCompare(b.datetime));
    cache = { at: Date.now(), txs };
    return txs;
  } catch (e) {
    if (cache) return cache.txs; // serve stale data if the sheet is unreachable
    throw e;
  }
}
