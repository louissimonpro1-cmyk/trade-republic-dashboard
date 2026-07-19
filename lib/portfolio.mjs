// Valuation & performance engine.
//
// Prices come from Yahoo Finance in each listing's native currency and are converted
// to EUR with Yahoo FX series (EURUSD=X is "USD per 1 EUR", hence eur = native / rate).
// Assets Yahoo does not know (e.g. Societe Generale warrants) are valued by linear
// interpolation between the EUR prices observed in the transaction history itself.
//
// The portfolio performance curve is a Time-Weighted Return: daily returns are
// computed with cash flows neutralised — r(d) = V(d) / (V(d-1) + F(d)) - 1 — then
// chained from the start of the selected period. Buying or selling therefore never
// moves the curve by itself; only market moves do.
import { resolveIsin, dailyHistory, intradayHistory, hourlyHistory, getFx } from "./yahoo.mjs";

export const todayParis = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const dateOfTs = (ts) =>
  new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

const DAY_MS = 86400000;

async function pmap(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Last [key, value] pair with key <= target in a chronologically sorted array.
function ffill(pairs, target) {
  if (!pairs || !pairs.length || pairs[0][0] > target) return null;
  let lo = 0, hi = pairs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pairs[mid][0] <= target) lo = mid;
    else hi = mid - 1;
  }
  return pairs[lo][1];
}

// ---- market data collection ----------------------------------------------
export async function collectMarket(ledger) {
  const assets = [...ledger.assets.values()];
  const entries = new Map();
  await pmap(assets, 4, async (a) => {
    const symbol = await resolveIsin(a.isin).catch(() => null);
    const daily = symbol ? await dailyHistory(symbol).catch(() => null) : null;
    entries.set(a.isin, { symbol, daily, intra: null });
  });
  await pmap(assets.filter((a) => a.isOpen && entries.get(a.isin)?.daily), 4, async (a) => {
    const e = entries.get(a.isin);
    e.intra = await intradayHistory(e.symbol).catch(() => null);
  });
  // hourly bars for assets active over the last month (1-week / 1-month views)
  const windowStart = new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10);
  const recentlyActive = (a) => a.isOpen || (a.lastOpDate && a.lastOpDate >= windowStart);
  await pmap(assets.filter((a) => recentlyActive(a) && entries.get(a.isin)?.daily), 4, async (a) => {
    const e = entries.get(a.isin);
    e.hourly = await hourlyHistory(e.symbol).catch(() => null);
  });
  const currencies = new Set();
  for (const e of entries.values()) {
    const c = e.daily?.currency || e.intra?.currency;
    if (c && c !== "EUR") currencies.add(c);
  }
  const fx = new Map();
  await pmap([...currencies], 3, async (c) => fx.set(c, await getFx(c).catch(() => null)));
  return { entries, fx };
}

// ---- per-asset EUR pricer -------------------------------------------------
function marksAt(marks, date) {
  if (!marks.length) return 0;
  if (date <= marks[0].date) return marks[0].price;
  const last = marks[marks.length - 1];
  if (date >= last.date) return last.price;
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].date >= date) {
      const a = marks[i - 1], b = marks[i];
      const span = Date.parse(b.date) - Date.parse(a.date);
      const t = span > 0 ? (Date.parse(date) - Date.parse(a.date)) / span : 0;
      return a.price + t * (b.price - a.price);
    }
  }
  return last.price;
}

export function makePricer(asset, market) {
  const entry = market.entries.get(asset.isin) || {};
  const { daily, intra } = entry;
  const currency = daily?.currency || intra?.currency || "EUR";
  const fx = currency === "EUR" ? null : market.fx.get(currency);

  const fxLive = fx ? (fx.intra?.live ?? fx.daily?.live ?? 1) : 1;
  const fxRateAt = (date) => {
    if (!fx?.daily?.closes?.length) return fxLive;
    return ffill(fx.daily.closes, date) ?? fx.daily.closes[0][1];
  };
  const fxRateAtTs = (ts) => {
    if (!fx) return 1;
    const v = fx.intra?.points ? ffill(fx.intra.points, ts) : null;
    return v ?? fx.intra?.prevClose ?? fxLive;
  };

  const hasMarket = !!(daily && daily.closes?.length);
  let liveNative = intra?.live ?? daily?.live ?? null;
  let source = intra?.live != null ? "live" : daily?.live != null ? "close" : "transaction";
  const liveEur = liveNative != null ? liveNative / fxLive : marksAt(asset.priceMarks, todayParis());

  // previous close: from the 1d chart when available (its chartPreviousClose really is
  // yesterday); otherwise second-to-last daily bar. Fallback: no daily change.
  let prevNative = intra?.prevClose ?? null;
  if (prevNative == null && daily?.closes?.length >= 2) prevNative = daily.closes[daily.closes.length - 2][1];
  const fxPrev = fx ? (fx.intra?.prevClose ?? fxLive) : 1;
  const prevCloseEur = prevNative != null ? prevNative / fxPrev : liveEur;

  // Yahoo's series is split/bonus-adjusted while the ledger holds actual share counts.
  // factorAfter(date) = product of the corporate-action ratios recorded AFTER that date;
  // adjustedPrice(date) * factorAfter(date) reconstructs the actual price of the day
  // (10:1 NVIDIA split: adjusted ~42 EUR * 10 = 427 EUR actually paid).
  const adjEvents = asset.adjEvents || [];
  const suffix = [];
  for (let i = adjEvents.length - 1, prod = 1; i >= 0; i--) suffix[i] = (prod *= adjEvents[i].ratio);
  const factorAfter = (date) => {
    let lo = 0, hi = adjEvents.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (adjEvents[mid].date > date) hi = mid; else lo = mid + 1; }
    return lo < adjEvents.length ? suffix[lo] : 1;
  };

  // raw adjusted EUR close (for the asset's own performance, adjustment-invariant)
  const adjEurAt = (date) => {
    if (hasMarket) {
      const c = ffill(daily.closes, date);
      if (c != null) return c / fxRateAt(date);
    }
    return null;
  };

  // safety net: events applied by Yahoo AFTER a position was closed never appear in the
  // ledger, so the whole holding window would be uniformly mis-scaled. Compare the series
  // against the actual transaction prices and rescale when they clearly disagree.
  let scale = 1;
  if (hasMarket && asset.priceMarks.length) {
    const ratios = [];
    for (const m of asset.priceMarks) {
      const adj = adjEurAt(m.date);
      if (adj > 0) {
        const s = m.price / (adj * factorAfter(m.date));
        if (Number.isFinite(s) && s > 0) ratios.push(s);
      }
    }
    if (ratios.length >= 3) { // one or two marks can diverge legitimately (IPO pop, odd fill)
      ratios.sort((a, b) => a - b);
      const median = ratios[Math.floor(ratios.length / 2)];
      // > 4%: systematic mismatch (wrong share class, proxy listing, unrecorded split);
      // below that it's FX-fill / intraday-vs-close noise, better left untouched
      if (Math.abs(median - 1) > 0.04) {
        scale = median;
        console.warn(`[valorisation] ${asset.name} (${asset.isin}) : série Yahoo rescalée x${median.toFixed(3)} d'après les prix de transaction`);
      }
    }
  }

  // actual EUR price of the day, for valuing actual share counts
  const eurAt = (date) => {
    const adj = adjEurAt(date);
    if (adj != null) return adj * factorAfter(date) * scale;
    return marksAt(asset.priceMarks, date); // transaction prices are already actual EUR
  };
  const valLiveEur = hasMarket ? liveEur * scale : liveEur; // factorAfter(today) === 1

  const intraEurAt = (ts) => {
    if (intra?.points?.length) {
      const c = ffill(intra.points, ts);
      if (c != null) return c / fxRateAtTs(ts);
    }
    return null;
  };

  // hourly bars (ms timestamps), converted with the hourly FX fill
  const fxHourlyAt = (ts) => {
    if (!fx) return 1;
    const v = fx.hourly?.points ? ffill(fx.hourly.points, ts) : null;
    return v ?? fxRateAt(dateOfTs(ts));
  };
  const hourlyEurAt = (ts) => {
    const pts = entry.hourly?.points;
    if (!pts?.length) return null;
    const c = ffill(pts, ts);
    if (c == null) return null;
    return (c / fxHourlyAt(ts)) * factorAfter(dateOfTs(ts)) * scale;
  };

  return { currency, hasMarket, source, liveEur, valLiveEur, prevCloseEur, eurAt, adjEurAt, intraEurAt, hourlyEurAt, entry };
}

// ---- daily portfolio value series ----------------------------------------
const sharesAt = (asset, date) => {
  const tl = asset.timeline;
  if (!tl.length || tl[0].date > date) return 0;
  let lo = 0, hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].date <= date) lo = mid;
    else hi = mid - 1;
  }
  return tl[lo].shares;
};

export function buildDailyValues(ledger, market) {
  const start = ledger.firstDate;
  const end = todayParis();
  const dates = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += DAY_MS)
    dates.push(new Date(t).toISOString().slice(0, 10));

  const items = [...ledger.assets.values()].map((a) => ({ a, p: makePricer(a, market) }));
  const values = dates.map((date, i) => {
    const isLast = i === dates.length - 1;
    let v = 0;
    for (const { a, p } of items) {
      const sh = sharesAt(a, date);
      if (Math.abs(sh) < 1e-9) continue;
      v += sh * (isLast ? p.valLiveEur : p.eurAt(date));
    }
    return v;
  });
  return { dates, values };
}

const RANGE_MONTHS = { "3y": 36, "1y": 12, "6m": 6, "1m": 1 };
export function rangeStartIndex(dates, range) {
  if (range === "max") return 0;
  const end = new Date(dates[dates.length - 1] + "T00:00:00Z");
  let startDate;
  if (range === "1w") startDate = new Date(end.getTime() - 7 * DAY_MS);
  else {
    startDate = new Date(end);
    startDate.setUTCMonth(startDate.getUTCMonth() - (RANGE_MONTHS[range] ?? 12));
  }
  const key = startDate.toISOString().slice(0, 10);
  const idx = dates.findIndex((d) => d >= key);
  return idx === -1 ? 0 : idx;
}

export function perfSeries(dates, values, flowsByDate, startIdx) {
  const points = [{ t: dates[startIdx], pct: 0, value: values[startIdx] }];
  let cum = 1;
  for (let i = startIdx + 1; i < dates.length; i++) {
    const flow = flowsByDate.get(dates[i]) || 0;
    const base = values[i - 1] + flow;
    if (base > 1e-9 && values[i] > 1e-9) cum *= values[i] / base;
    points.push({ t: dates[i], pct: (cum - 1) * 100, value: values[i] });
  }
  return points;
}

// ---- hourly portfolio series (1-week / 1-month views) ---------------------
export function buildHourlyValues(ledger, market) {
  const items = [...ledger.assets.values()].map((a) => ({ a, p: makePricer(a, market) }));
  const cutoff = Date.now() - 31 * 86400000;
  const tsSet = new Set();
  for (const { p } of items) {
    const pts = p.entry?.hourly?.points;
    if (pts) for (const [ts] of pts) if (ts >= cutoff) tsSet.add(ts);
  }
  const grid = [...tsSet].sort((x, y) => x - y);
  const dates = grid.map(dateOfTs);
  const values = grid.map((ts, i) => {
    let v = 0;
    for (const { a, p } of items) {
      const sh = sharesAt(a, dates[i]);
      if (Math.abs(sh) < 1e-9) continue;
      v += sh * (p.hourlyEurAt(ts) ?? p.eurAt(dates[i]));
    }
    return v;
  });
  // final live point so the curve ends on the current value
  if (grid.length) {
    const today = todayParis();
    let live = 0;
    for (const { a, p } of items) {
      const sh = sharesAt(a, today);
      if (Math.abs(sh) > 1e-9) live += sh * p.valLiveEur;
    }
    grid.push(Date.now());
    dates.push(today);
    values.push(live);
  }
  return { grid, dates, values };
}

// TWR chained on the hourly grid; a day's trading flows apply at its first point
export function perfSeriesHourly(grid, dates, values, flowsByDate, startIdx) {
  const points = [{ t: grid[startIdx], pct: 0, value: values[startIdx] }];
  let cum = 1;
  for (let i = startIdx + 1; i < grid.length; i++) {
    const flow = dates[i] !== dates[i - 1] ? (flowsByDate.get(dates[i]) || 0) : 0;
    const base = values[i - 1] + flow;
    if (base > 1e-9 && values[i] > 1e-9) cum *= values[i] / base;
    points.push({ t: grid[i], pct: (cum - 1) * 100, value: values[i] });
  }
  return points;
}

// ---- intraday (1 day) series ---------------------------------------------
export function buildIntradaySeries(ledger, market) {
  const open = [...ledger.assets.values()].filter((a) => a.isOpen);
  const items = open.map((a) => ({ a, p: makePricer(a, market) }));

  let sessionDate = null;
  for (const { p } of items) {
    const sd = p.entry.intra?.sessionDate;
    if (sd && (!sessionDate || sd > sessionDate)) sessionDate = sd;
  }
  const baseline = items.reduce((s, { a, p }) => s + a.shares * p.prevCloseEur, 0);
  if (!sessionDate || baseline <= 0) return { sessionDate, points: [] };

  const tsSet = new Set();
  for (const { p } of items) {
    const intra = p.entry.intra;
    if (intra?.sessionDate === sessionDate) for (const [ts] of intra.points) tsSet.add(ts);
  }
  const grid = [...tsSet].sort((x, y) => x - y);

  const points = grid.map((ts) => {
    let v = 0;
    for (const { a, p } of items) {
      const intra = p.entry.intra;
      if (intra?.sessionDate === sessionDate && intra.points.length) {
        const c = p.intraEurAt(ts);
        v += a.shares * (c ?? p.prevCloseEur); // before its first bar: previous close
      } else {
        v += a.shares * p.liveEur; // other sessions / unlisted: static
      }
    }
    return { t: ts * 1000, pct: (v / baseline - 1) * 100, value: v };
  });
  return { sessionDate, points };
}

// ---- per-asset own performance over standard periods ----------------------
export function ownPerf(asset, pricer) {
  const { entry } = pricer;
  if (!pricer.hasMarket) return { d1: null, w1: null, m1: null, m6: null, y1: null, y3: null };
  // adjusted EUR close series: split-adjusted prices are exactly what a "performance
  // of the stock itself" comparison needs (a split must not read as -90%)
  const eurSeries = entry.daily.closes.map(([d]) => [d, pricer.adjEurAt(d)]);

  const live = pricer.liveEur;
  const end = Date.parse(todayParis());
  const firstDate = eurSeries[0][0];
  const at = (msBack, toleranceDays) => {
    const target = new Date(end - msBack).toISOString().slice(0, 10);
    if (Date.parse(firstDate) > Date.parse(target) + toleranceDays * DAY_MS) return null;
    const base = ffill(eurSeries, target);
    return base > 0 ? (live / base - 1) * 100 : null;
  };
  const d1 = pricer.prevCloseEur > 0 ? (live / pricer.prevCloseEur - 1) * 100 : null;
  return {
    d1,
    w1: at(7 * DAY_MS, 5),
    m1: at(30 * DAY_MS, 7),
    m6: at(182 * DAY_MS, 10),
    y1: at(365 * DAY_MS, 12),
    y3: at(3 * 365 * DAY_MS, 25),
  };
}
