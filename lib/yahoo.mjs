// Yahoo Finance access: ISIN -> ticker resolution, daily history (3y), intraday bars
// and FX series, with layered caching (memory + disk under cache/).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// on Vercel the filesystem is read-only except /tmp (cache is best-effort there)
const CACHE_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), "tr-dashboard-cache")
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cache");
const HIST_DIR = path.join(CACHE_DIR, "history");
const SYMBOLS_FILE = path.join(CACHE_DIR, "symbols.json");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
};
const DAILY_TTL = 30 * 60 * 1000;      // daily history refreshed every 30 min
const INTRA_TTL = 60 * 1000;           // intraday quotes refreshed every 60 s
const NULL_SYMBOL_RETRY = 7 * 24 * 3600 * 1000; // retry unresolvable ISINs weekly

await fs.mkdir(HIST_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");

async function yjson(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null; // 404/40x: unknown symbol, not a transient error
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

// ---- ISIN -> Yahoo symbol -------------------------------------------------
let symbols = null;
async function loadSymbols() {
  if (symbols) return symbols;
  try { symbols = JSON.parse(await fs.readFile(SYMBOLS_FILE, "utf8")); }
  catch { symbols = {}; }
  return symbols;
}

export async function resolveIsin(isin) {
  await loadSymbols();
  const e = symbols[isin];
  if (e && (e.symbol || Date.now() - e.at < NULL_SYMBOL_RETRY)) return e.symbol || null;
  let q = null;
  try {
    const j = await yjson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=6&newsCount=0`);
    q = j?.quotes?.find((x) => x.symbol) ?? null;
  } catch { return e?.symbol ?? null; } // network trouble: keep whatever we knew
  symbols[isin] = { symbol: q?.symbol ?? null, name: q?.longname ?? q?.shortname ?? null, at: Date.now() };
  await fs.writeFile(SYMBOLS_FILE, JSON.stringify(symbols, null, 2)).catch(() => {});
  return symbols[isin].symbol;
}

// ---- price history --------------------------------------------------------
const dateStr = (ts, gmtoffset) => new Date((ts + (gmtoffset || 0)) * 1000).toISOString().slice(0, 10);

function parseChart(j) {
  const r = j?.chart?.result?.[0];
  if (!r?.meta) return null;
  const meta = r.meta;
  const ts = r.timestamp || [];
  const cl = r.indicators?.quote?.[0]?.close || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) bars.push([ts[i], cl[i]]);
  return {
    currency: meta.currency,
    gmtoffset: meta.gmtoffset || 0,
    live: meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1][1] : null),
    liveTime: meta.regularMarketTime ?? null,
    prevClose: meta.chartPreviousClose ?? null,
    bars,
  };
}

const memDaily = new Map();
export async function dailyHistory(symbol) {
  const hit = memDaily.get(symbol);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.data;
  const file = path.join(HIST_DIR, `${safeName(symbol)}-1d.json`);
  if (!hit) {
    try {
      const disk = JSON.parse(await fs.readFile(file, "utf8"));
      memDaily.set(symbol, disk);
      if (Date.now() - disk.at < DAILY_TTL) return disk.data;
    } catch { /* no disk cache yet */ }
  }
  try {
    const j = await yjson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`);
    const c = parseChart(j);
    if (!c) throw new Error(`no chart data for ${symbol}`);
    const byDate = new Map(); // one close per calendar date (exchange timezone), last wins
    for (const [ts, close] of c.bars) byDate.set(dateStr(ts, c.gmtoffset), close);
    const data = {
      currency: c.currency, live: c.live, liveTime: c.liveTime, prevClose: c.prevClose,
      closes: [...byDate.entries()], // [[date, close], ...] chronological
    };
    const entry = { at: Date.now(), data };
    memDaily.set(symbol, entry);
    await fs.writeFile(file, JSON.stringify(entry)).catch(() => {});
    return data;
  } catch (e) {
    const stale = memDaily.get(symbol);
    if (stale) return stale.data; // stale-if-error
    throw e;
  }
}

const memIntra = new Map();
export async function intradayHistory(symbol) {
  const hit = memIntra.get(symbol);
  if (hit && Date.now() - hit.at < INTRA_TTL) return hit.data;
  try {
    const j = await yjson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`);
    const c = parseChart(j);
    if (!c) throw new Error(`no intraday data for ${symbol}`);
    // keep only the most recent session (Yahoo may return the previous day after close)
    let points = c.bars;
    if (points.length) {
      const lastDay = dateStr(points[points.length - 1][0], c.gmtoffset);
      points = points.filter(([ts]) => dateStr(ts, c.gmtoffset) === lastDay);
      var sessionDate = lastDay;
    }
    const data = {
      currency: c.currency, live: c.live, liveTime: c.liveTime, prevClose: c.prevClose,
      sessionDate: sessionDate ?? null,
      points, // [[unix_ts, close], ...]
    };
    memIntra.set(symbol, { at: Date.now(), data });
    return data;
  } catch (e) {
    const stale = memIntra.get(symbol);
    if (stale) return stale.data;
    throw e;
  }
}

// ---- FX (EUR per unit of foreign currency is 1/rate: Yahoo EURUSD=X = USD per EUR)
export async function getFx(currency) {
  if (currency === "EUR") return null;
  const symbol = `EUR${currency}=X`;
  const [daily, intra] = await Promise.all([
    dailyHistory(symbol).catch(() => null),
    intradayHistory(symbol).catch(() => null),
  ]);
  return { currency, daily, intra };
}
