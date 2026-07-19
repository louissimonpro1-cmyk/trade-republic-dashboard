// Position engine: replays the full transaction history chronologically and produces
// per-asset state (holdings, average cost, realized P&L), the cash balance, the
// share-count timeline of every asset and the daily EUR flows in/out of the portfolio.
//
// Conventions found in the Trade Republic export:
//  - SELL rows carry NEGATIVE share counts; BUY rows positive.
//  - `amount` is the gross cash movement; `fee` and `tax` are separate signed columns,
//    so the net cash effect of any row is amount + fee + tax.
//  - DELIVERY (FREE_RECEIPT / MIGRATION) rows come in cancelling +/- pairs.
//  - CORPORATE_ACTION rows (SPLIT, STOCK_DIVIDEND, BONUS_ISSUE, ...) adjust share
//    counts at zero cost, which the weighted-average-cost method absorbs naturally
//    (e.g. a 10:1 split adds shares while the cost basis is unchanged).

// Residual fractions up to 0.04 shares are treated as fully sold (user rule).
export const OPEN_THRESHOLD = 0.04;

export function buildLedger(txs) {
  const totals = {
    cash: 0, deposits: 0, withdrawals: 0,
    interestNet: 0, dividendsNet: 0, fees: 0, taxes: 0,
  };
  const assets = new Map();
  const flowsByDate = new Map(); // date -> EUR moved into (+) or out of (-) the positions

  const getAsset = (t) => {
    if (!assets.has(t.isin)) assets.set(t.isin, {
      isin: t.isin, name: t.name, assetClass: t.assetClass,
      shares: 0, costBasis: 0,
      buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0,
      realized: 0,
      lastSellPrice: null, lastSellDate: null, lastOpDate: null, firstDate: t.date,
      timeline: [],   // [{date, shares}] cumulative share count after each trading day
      priceMarks: [], // [{date, price}] every EUR price observed in the history
      corpRaw: [],    // corporate-action share changes, to derive split/bonus ratios
    });
    return assets.get(t.isin);
  };

  const addFlow = (date, eur) => flowsByDate.set(date, (flowsByDate.get(date) || 0) + eur);
  const pushTimeline = (a, date) => {
    const last = a.timeline[a.timeline.length - 1];
    if (last && last.date === date) last.shares = a.shares;
    else a.timeline.push({ date, shares: a.shares });
  };

  for (const t of txs) {
    totals.cash += t.amount + t.fee + t.tax;
    totals.fees += t.fee;
    totals.taxes += t.tax;
    if (t.type === "CUSTOMER_INBOUND") totals.deposits += t.amount;
    if (t.type === "CUSTOMER_OUTBOUND_REQUEST") totals.withdrawals += -t.amount;
    if (t.type === "INTEREST_PAYMENT") totals.interestNet += t.amount + t.tax;
    if (t.type === "DIVIDEND") {
      totals.dividendsNet += t.amount + t.tax;
      // a cash dividend is value leaving the positions (the price drops on ex-date):
      // counting it as an outflow keeps the TWR from reading it as a market loss
      addFlow(t.date, -t.amount);
    }

    if (!t.isin) continue;
    const a = getAsset(t);
    if (t.price > 0) a.priceMarks.push({ date: t.date, price: t.price });

    if (t.category === "TRADING" && t.type === "BUY") {
      a.shares += t.shares;
      a.costBasis += t.shares * t.price;
      a.buyQty += t.shares;
      a.buyValue += t.shares * t.price;
      a.lastOpDate = t.date;
      addFlow(t.date, t.shares * t.price);
      pushTimeline(a, t.date);
    } else if (t.category === "TRADING" && t.type === "SELL") {
      const qty = Math.abs(t.shares);
      const avg = a.shares > 1e-9 ? a.costBasis / a.shares : t.price;
      a.realized += qty * (t.price - avg);
      a.costBasis -= qty * avg;
      a.shares -= qty;
      a.sellQty += qty;
      a.sellValue += qty * t.price;
      a.lastSellPrice = t.price;
      a.lastSellDate = t.date;
      a.lastOpDate = t.date;
      addFlow(t.date, -qty * t.price);
      pushTimeline(a, t.date);
    } else if (t.category === "DELIVERY" || t.category === "CORPORATE_ACTION") {
      if (t.category === "CORPORATE_ACTION") a.corpRaw.push({ date: t.date, delta: t.shares, sharesBefore: a.shares });
      a.shares += t.shares; // signed; zero-cost share changes shift the average price
      a.lastOpDate = t.date;
      pushTimeline(a, t.date);
    }
  }

  for (const a of assets.values()) {
    // keep at most one price mark per date (the last one) so interpolation is clean
    const byDate = new Map();
    for (const m of a.priceMarks) byDate.set(m.date, m.price);
    a.priceMarks = [...byDate.entries()].map(([date, price]) => ({ date, price }));
    a.isOpen = Math.abs(a.shares) > OPEN_THRESHOLD;

    // net share ratio of corporate actions per date (split 10:1 -> 10, bonus 1:10 -> 1.1).
    // Yahoo back-adjusts its price series for these events; the valuation engine uses
    // these ratios to reconstruct the actual (unadjusted) historical prices.
    const adjByDate = new Map();
    for (const ev of a.corpRaw) {
      if (!adjByDate.has(ev.date)) adjByDate.set(ev.date, { before: ev.sharesBefore, after: 0 });
      adjByDate.get(ev.date).after = ev.sharesBefore + ev.delta;
    }
    a.adjEvents = [...adjByDate.entries()]
      .map(([date, { before, after }]) => ({ date, ratio: before > 1e-9 ? after / before : 1 }))
      .filter((e) => Math.abs(e.ratio - 1) > 1e-6);
    delete a.corpRaw;
  }

  return { totals, assets, flowsByDate, firstDate: txs[0]?.date ?? null };
}
