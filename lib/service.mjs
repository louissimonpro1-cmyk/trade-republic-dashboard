// Business layer shared by the local server (server.mjs) and the Vercel functions
// (api/*.js): assembles the dashboard payload, the performance series and the logo
// proxy, with light in-memory memoisation (survives while the process/instance is warm).
import { getTransactions } from "./sheet.mjs";
import { buildLedger } from "./ledger.mjs";
import {
  collectMarket, makePricer, buildDailyValues, buildIntradaySeries,
  buildHourlyValues, perfSeriesHourly,
  perfSeries, rangeStartIndex, ownPerf, todayParis,
} from "./portfolio.mjs";

export const PERF_RANGES = ["max", "3y", "1y", "6m", "1m", "1w", "1d"];

let marketMemo = null; // { at, promise }
async function getContext() {
  const txs = await getTransactions();          // cached 2 min inside sheet.mjs
  const ledger = buildLedger(txs);              // cheap, recomputed every time
  if (!marketMemo || Date.now() - marketMemo.at > 60 * 1000) {
    marketMemo = { at: Date.now(), promise: collectMarket(ledger) };
  }
  const market = await marketMemo.promise;
  return { ledger, market };
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const round3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// ---- dashboard ------------------------------------------------------------
export async function getDashboard() {
  const { ledger, market } = await getContext();
  const items = [...ledger.assets.values()].map((a) => ({ a, p: makePricer(a, market) }));
  const positions = [];
  const archives = [];
  let positionsValue = 0, prevCloseValue = 0, unrealized = 0, realizedTotal = 0;

  // most recent trading session across the portfolio: assets that did not trade in it
  // (market not yet open, holiday) count as flat in the "day change", matching the 1J curve
  let sessionRef = null;
  for (const { a, p } of items) {
    if (!a.isOpen) continue;
    const sd = p.entry.intra?.sessionDate;
    if (sd && (!sessionRef || sd > sessionRef)) sessionRef = sd;
  }

  for (const { a, p } of items) {
    realizedTotal += a.realized;
    if (a.isOpen) {
      const value = a.shares * p.liveEur;
      const avgBuy = a.shares > 0 ? a.costBasis / a.shares : 0;
      positionsValue += value;
      const tradedInSession = p.entry.intra?.sessionDate === sessionRef;
      prevCloseValue += a.shares * (tradedInSession ? p.prevCloseEur : p.liveEur);
      unrealized += value - a.costBasis;
      positions.push({
        isin: a.isin, name: a.name, assetClass: a.assetClass,
        qty: a.shares,
        priceEur: round3(p.liveEur), priceSource: p.source,
        valueEur: round2(value),
        avgBuy: round3(avgBuy),
        perfPct: avgBuy > 0 ? round2((p.liveEur / avgBuy - 1) * 100) : null,
        perfEur: round2(value - a.costBasis),
        realized: round2(a.realized),
        lastSellPrice: round3(a.lastSellPrice),
        lastSellDate: a.lastSellDate,
        vsLastSellPct: a.lastSellPrice ? round2((p.liveEur / a.lastSellPrice - 1) * 100) : null,
        vsLastSellEur: a.lastSellPrice ? round3(p.liveEur - a.lastSellPrice) : null,
        ownPerf: Object.fromEntries(Object.entries(ownPerf(a, p)).map(([k, v]) => [k, round2(v)])),
      });
    } else {
      const avgBuy = a.buyQty > 0 ? a.buyValue / a.buyQty : 0;
      const avgSell = a.sellQty > 0 ? a.sellValue / a.sellQty : 0;
      // valLiveEur: rescaled to the instrument actually traded when Yahoo only has a proxy
      const current = p.hasMarket ? p.valLiveEur : null;
      archives.push({
        isin: a.isin, name: a.name, assetClass: a.assetClass,
        avgBuy: round3(avgBuy), avgSell: round3(avgSell),
        perfPct: avgBuy > 0 && avgSell > 0 ? round2((avgSell / avgBuy - 1) * 100) : null,
        perfEur: round2(a.realized),
        lastOpDate: a.lastOpDate,
        lastSellPrice: round3(a.lastSellPrice),
        currentPrice: round3(current),
        vsLastSellPct: current != null && a.lastSellPrice ? round2((current / a.lastSellPrice - 1) * 100) : null,
        vsLastSellEur: current != null && a.lastSellPrice ? round3(current - a.lastSellPrice) : null,
      });
    }
  }

  positions.sort((x, y) => y.valueEur - x.valueEur);
  archives.sort((x, y) => (y.lastOpDate || "").localeCompare(x.lastOpDate || ""));

  const t = ledger.totals;
  return {
    updatedAt: new Date().toISOString(),
    today: todayParis(),
    totals: {
      positionsValue: round2(positionsValue),
      sessionDate: sessionRef,
      dayChangeEur: round2(positionsValue - prevCloseValue),
      dayChangePct: prevCloseValue > 0 ? round2((positionsValue / prevCloseValue - 1) * 100) : null,
      cash: round2(t.cash),
      accountValue: round2(positionsValue + t.cash),
      deposits: round2(t.deposits),
      withdrawals: round2(t.withdrawals),
      netDeposits: round2(t.deposits - t.withdrawals),
      unrealized: round2(unrealized),
      realized: round2(realizedTotal),
      income: round2(t.dividendsNet + t.interestNet),
      dividends: round2(t.dividendsNet),
      interest: round2(t.interestNet),
      fees: round2(t.fees),
      taxes: round2(t.taxes),
    },
    positions,
    archives,
  };
}

// ---- performance series ---------------------------------------------------
const perfCache = new Map(); // range -> { at, data }
export async function getPerf(range) {
  if (!PERF_RANGES.includes(range)) throw Object.assign(new Error("range invalide"), { status: 400 });
  const ttl = range === "1d" ? 60 * 1000 : 5 * 60 * 1000;
  const hit = perfCache.get(range);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  const { ledger, market } = await getContext();
  const pack = (points, sessionDate = null) => ({
    range, sessionDate,
    points: points.map((p) => ({ t: p.t, pct: round3(p.pct), value: round2(p.value) })),
  });
  // keep index 0 (the 0% baseline) and every step-th point counted from the end
  const thin = (arr, step) => arr.filter((_, i) => i === 0 || (arr.length - 1 - i) % step === 0);

  let data;
  if (range === "1d") {
    const { sessionDate, sessionStart, points } = buildIntradaySeries(ledger, market);
    data = { ...pack(points, sessionDate), sessionStart };
  } else if (range === "1w" || range === "1m") {
    // hourly granularity: one point per market hour (1w), ~4 per day (1m)
    const { grid, dates, values } = buildHourlyValues(ledger, market);
    const startTs = Date.now() - (range === "1w" ? 7 : 30) * 86400000;
    let startIdx = grid.findIndex((t) => t >= startTs);
    if (startIdx === -1) startIdx = 0;
    if (grid.length - startIdx >= 10) {
      let points = perfSeriesHourly(grid, dates, values, ledger.flowsByDate, startIdx);
      if (range === "1m") points = thin(points, 4); // ~3-4 points per market day
      data = pack(points);
    }
  }
  if (!data) { // daily fallback (also covers hourly data being unavailable)
    const { dates, values } = buildDailyValues(ledger, market);
    const startIdx = rangeStartIndex(dates, range);
    data = pack(perfSeries(dates, values, ledger.flowsByDate, startIdx));
  }
  perfCache.set(range, { at: Date.now(), data });
  return data;
}

// ---- per-asset price series (mini chart inside the position cards) --------
const assetSeriesCache = new Map(); // isin -> { at, data }
export async function getAssetSeries(isin) {
  const hit = assetSeriesCache.get(isin);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.data;

  const { ledger, market } = await getContext();
  const asset = ledger.assets.get(isin);
  if (!asset) throw Object.assign(new Error("actif inconnu"), { status: 404 });
  const p = makePricer(asset, market);

  // adjusted EUR closes: consistent with the period pills (a split must not distort)
  const daily = p.hasMarket
    ? p.entry.daily.closes.map(([d]) => [d, round3(p.adjEurAt(d))])
    : [];
  let intraday = null;
  const intra = p.entry.intra;
  if (intra?.points?.length && p.prevCloseEur > 0) {
    intraday = {
      prevClose: round3(p.prevCloseEur),
      sessionDate: intra.sessionDate,
      prevSessionDate: intra.prevSessionDate ?? null,
      sessionStart: intra.sessionStartTs != null ? intra.sessionStartTs * 1000 : null,
      points: intra.points
        .map(([ts]) => [ts * 1000, round3(p.intraEurAt(ts))])
        .filter((x) => x[1] != null),
    };
  }
  // hourly bars (1 month) for the fine-grained 1S / 1M mini-chart views
  const hourly = (p.entry.hourly?.points || [])
    .map(([ts]) => [ts, round3(p.hourlyEurAt(ts))])
    .filter((x) => x[1] != null);
  const data = { isin, daily, hourly, intraday };
  assetSeriesCache.set(isin, { at: Date.now(), data });
  return data;
}

// ---- logo proxy (Trade Republic asset CDN, keyed by ISIN) -----------------
const logoCache = new Map(); // `${isin}/${theme}` -> { ok, body }
export async function getLogo(isin, theme) {
  const t = theme === "dark" ? "dark" : "light";
  const key = `${isin}/${t}`;
  if (!logoCache.has(key)) {
    try {
      const r = await fetch(`https://assets.traderepublic.com/img/logos/${isin}/${t}.svg`);
      logoCache.set(key, r.ok ? { ok: true, body: Buffer.from(await r.arrayBuffer()) } : { ok: false });
    } catch {
      logoCache.set(key, { ok: false });
    }
  }
  return logoCache.get(key);
}
