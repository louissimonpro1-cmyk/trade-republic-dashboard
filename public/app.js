"use strict";

// ---------- state ----------
const state = {
  range: "max", dashboard: null, perf: null,
  showOwnPerf: localStorage.getItem("showOwnPerf") === "1",
};
const RANGES = [["1d", "1 J"], ["1w", "1 S"], ["1m", "1 M"], ["6m", "6 M"], ["1y", "1 A"], ["3y", "3 A"], ["max", "Tout"]];
const RANGE_LABEL = {
  max: "depuis l’ouverture", "3y": "sur 3 ans", "1y": "sur 1 an",
  "6m": "sur 6 mois", "1m": "sur 1 mois", "1w": "sur 1 semaine", "1d": "aujourd’hui",
};

// ---------- formatters (fr-FR) ----------
const _eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const _eurS = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", signDisplay: "always" });
const _eur3 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3 });
const _eur3S = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3, signDisplay: "always" });
const _qty = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });
const _num = (dec, signed) => new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: dec, maximumFractionDigits: dec, signDisplay: signed ? "always" : "auto",
});
const _pct2 = _num(2, true), _pct1 = _num(1, true);

const eur = (x) => (x == null ? "—" : _eur.format(x));
const eurS = (x) => (x == null ? "—" : _eurS.format(x));
const price = (x) => (x == null ? "—" : Math.abs(x) < 10 ? _eur3.format(x) : _eur.format(x));
const priceS = (x) => (x == null ? "—" : Math.abs(x) < 10 ? _eur3S.format(x) : _eurS.format(x));
const qty = (x) => (x == null ? "—" : _qty.format(x));
const pct = (x, dec = 2) => (x == null ? "—" : (dec === 1 ? _pct1 : _pct2).format(x) + " %");

const fmtTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const fmtFull = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
const fmtDayMon = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fmtMonYr = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });
const fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const signCls = (x) => (x == null ? "na" : x >= 0 ? "pos" : "neg");
const darkMode = () => matchMedia("(prefers-color-scheme: dark)").matches;

async function api(path) {
  const r = await fetch(path);
  if (r.status === 401) { // password protection active and session expired
    location.href = "/login.html";
    throw new Error("authentification requise");
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// ---------- hero ----------
function renderHero() {
  const t = state.dashboard.totals;
  $("heroValue").textContent = eur(t.positionsValue);
  const chip = $("heroDelta");
  if (t.dayChangePct != null) {
    chip.hidden = false;
    chip.className = "chip " + signCls(t.dayChangeEur);
    chip.textContent = `${t.dayChangeEur >= 0 ? "▲" : "▼"} ${eurS(t.dayChangeEur)} · ${pct(t.dayChangePct)} aujourd’hui`;
  } else chip.hidden = true;

  const tiles = $("tiles");
  tiles.replaceChildren();
  const tile = (label, value, cls) => {
    const d = el("div", "tile");
    d.append(el("div", "t-label", label));
    d.append(el("div", "t-value" + (cls ? " " + cls : ""), value));
    tiles.append(d);
  };
  tile("Espèces disponibles", eur(t.cash));
  tile("Valeur totale du compte", eur(t.accountValue));
  tile("Versements nets", eur(t.netDeposits));
  tile("P&L latent", eurS(t.unrealized), signCls(t.unrealized));
  tile("P&L réalisé", eurS(t.realized), signCls(t.realized));
  tile("Dividendes & intérêts", eurS(t.income), signCls(t.income));
  tile("Frais payés", eurS(t.fees), signCls(t.fees));
  $("heroCard").hidden = false;
}

// ---------- chart ----------
const SVG = "http://www.w3.org/2000/svg";
const sv = (tag, attrs, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
};

function niceTicks(min, max, count) {
  const span = max - min;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  // smallest nice step that yields at most count+1 ticks
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => m * mag)
    .find((s) => span / s <= count + 1) || 100 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

const chartUI = { layout: null };

function xLabel(t) {
  if (state.range === "1d") return fmtTime.format(t);
  const d = new Date(typeof t === "string" ? t + "T12:00:00Z" : t);
  return ["1w", "1m", "6m"].includes(state.range) ? fmtDayMon.format(d) : fmtMonYr.format(d);
}
function tooltipDate(t) {
  if (state.range === "1d") return `${fmtFull.format(t)} · ${fmtTime.format(t)}`;
  return fmtFull.format(new Date(t + "T12:00:00Z"));
}

function renderChart() {
  const wrap = $("chartWrap"), svg = $("chartSvg"), tip = $("tooltip");
  const points = state.perf?.points || [];
  svg.replaceChildren();
  tip.hidden = true;
  wrap.querySelector(".chart-empty")?.remove();
  chartUI.layout = null;

  const W = wrap.clientWidth || 800;
  const H = W < 640 ? 250 : 330;
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  if (points.length < 2) {
    svg.setAttribute("height", 0);
    const empty = el("div", "chart-empty", "Aucune donnée de séance disponible pour cette période.");
    wrap.append(empty);
    return;
  }

  const padL = 6, padR = 62, padT = 16, padB = 26;
  const n = points.length;
  const ys = points.map((p) => p.pct);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymax - ymin < 0.2) { ymin -= 0.25; ymax += 0.25; }
  const padY = (ymax - ymin) * 0.09;
  ymin -= padY; ymax += padY;

  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + ((ymax - v) * (H - padT - padB)) / (ymax - ymin);

  const last = points[n - 1].pct;
  $("chartCard").classList.toggle("down", last < 0);

  // defs: area gradient driven by the CSS --accent variable
  const defs = sv("defs", {}, svg);
  const grad = sv("linearGradient", { id: "areaGrad", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  sv("stop", { offset: 0, style: "stop-color: var(--accent); stop-opacity: 0.18" }, grad);
  sv("stop", { offset: 1, style: "stop-color: var(--accent); stop-opacity: 0" }, grad);

  // horizontal grid + labels
  for (const tick of niceTicks(ymin, ymax, 4)) {
    const ty = y(tick);
    sv("line", { x1: padL, x2: W - padR + 14, y1: ty, y2: ty, stroke: "var(--grid)", "stroke-width": 1 }, svg);
    const lbl = sv("text", {
      x: W - padR + 18, y: ty + 3.5, fill: "var(--muted)",
      "font-size": 11, "font-family": "inherit",
    }, svg);
    lbl.textContent = `${_num(Math.abs(tick) < 3 ? 1 : 0, false).format(tick)} %`;
  }
  // zero baseline
  if (ymin < 0 && ymax > 0) {
    sv("line", {
      x1: padL, x2: W - padR + 14, y1: y(0), y2: y(0),
      stroke: "var(--baseline)", "stroke-width": 1, "stroke-dasharray": "4 4",
    }, svg);
  }

  // area + line
  let dLine = "";
  for (let i = 0; i < n; i++) dLine += `${i ? "L" : "M"}${x(i).toFixed(2)},${y(points[i].pct).toFixed(2)}`;
  const dArea = dLine + `L${x(n - 1).toFixed(2)},${H - padB}L${x(0).toFixed(2)},${H - padB}Z`;
  sv("path", { d: dArea, fill: "url(#areaGrad)" }, svg);
  sv("path", { d: dLine, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  sv("circle", { cx: x(n - 1), cy: y(last), r: 3.5, fill: "var(--accent)" }, svg);

  // x labels
  const labelIdx = [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))))];
  for (const i of labelIdx) {
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    const lbl = sv("text", {
      x: x(i), y: H - 8, fill: "var(--muted)", "font-size": 11,
      "text-anchor": anchor, "font-family": "inherit",
    }, svg);
    lbl.textContent = xLabel(points[i].t);
  }

  // crosshair (hidden until hover)
  const cross = sv("g", { visibility: "hidden" }, svg);
  const vline = sv("line", { y1: padT, y2: H - padB, stroke: "var(--baseline)", "stroke-width": 1, "stroke-dasharray": "3 3" }, cross);
  const dot = sv("circle", { r: 4.5, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }, cross);

  chartUI.layout = { W, H, padL, padR, padT, points, x, y, cross, vline, dot };
}

function onChartMove(e) {
  const L = chartUI.layout;
  if (!L) return;
  const rect = $("chartSvg").getBoundingClientRect();
  const px = e.clientX - rect.left;
  const n = L.points.length;
  const step = (L.W - L.padL - L.padR) / (n - 1);
  const idx = Math.max(0, Math.min(n - 1, Math.round((px - L.padL) / step)));
  const p = L.points[idx];
  const cx = L.x(idx), cy = L.y(p.pct);

  L.cross.setAttribute("visibility", "visible");
  L.vline.setAttribute("x1", cx);
  L.vline.setAttribute("x2", cx);
  L.dot.setAttribute("cx", cx);
  L.dot.setAttribute("cy", cy);

  const tip = $("tooltip");
  tip.replaceChildren();
  tip.append(el("div", "tt-pct " + signCls(p.pct), pct(p.pct)));
  tip.append(el("div", "tt-date", tooltipDate(p.t)));
  tip.append(el("div", "tt-value", `Positions · ${eur(p.value)}`));
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = cx - tw / 2;
  left = Math.max(4, Math.min(L.W - tw - 4, left));
  let top = cy - th - 16;
  if (top < 2) top = cy + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function onChartLeave() {
  chartUI.layout?.cross.setAttribute("visibility", "hidden");
  $("tooltip").hidden = true;
}

function renderChartSection() {
  $("chartCard").hidden = false; // unhide before measuring: a hidden card has zero width
  const points = state.perf?.points || [];
  const lastPct = points.length ? points[points.length - 1].pct : null;
  const pp = $("periodPct");
  pp.textContent = pct(lastPct);
  pp.className = signCls(lastPct);
  let sub = RANGE_LABEL[state.range];
  if (state.range === "1d" && state.perf?.sessionDate && state.dashboard && state.perf.sessionDate !== state.dashboard.today) {
    sub = `dernière séance · ${fmtDate.format(new Date(state.perf.sessionDate + "T12:00:00Z"))}`;
  }
  $("periodSub").textContent = sub;
  renderChart();
  renderChartTable();
}

function renderChartTable() {
  const points = state.perf?.points || [];
  const table = $("chartTable");
  table.replaceChildren();
  if (!points.length) return;
  const thead = el("thead"), tr = el("tr");
  for (const [h, cls] of [["Date", "left"], ["Performance", ""], ["Valeur des positions", ""]]) {
    tr.append(el("th", cls || null, h));
  }
  thead.append(tr);
  table.append(thead);
  const tbody = el("tbody");
  const step = Math.max(1, Math.floor(points.length / 24));
  const idxs = [];
  for (let i = 0; i < points.length; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== points.length - 1) idxs.push(points.length - 1);
  for (const i of idxs) {
    const p = points[i];
    const row = el("tr");
    row.append(el("td", "left", state.range === "1d" ? fmtTime.format(p.t) : fmtDate.format(new Date(p.t + "T12:00:00Z"))));
    row.append(el("td", signCls(p.pct), pct(p.pct)));
    row.append(el("td", null, eur(p.value)));
    tbody.append(row);
  }
  table.append(tbody);
}

// ---------- tables ----------
function logoEl(a) {
  const img = el("img", "logo");
  img.alt = "";
  img.src = `/api/logo/${a.isin}?theme=${darkMode() ? "dark" : "light"}`;
  img.onerror = () => {
    const fb = el("div", "logo-fallback c" + (hash(a.isin) % 8), initials(a.name));
    img.replaceWith(fb);
  };
  return img;
}

function approxBadge() {
  const badge = el("span", "approx", "≈");
  badge.title = "Cours indisponible sur Yahoo Finance — valorisé au dernier prix de transaction connu.";
  return badge;
}

function assetCell(a) {
  const td = el("td", "left");
  const box = el("div", "asset");
  const img = logoEl(a);
  const txt = el("div");
  const nameRow = el("div", "a-name", a.name);
  if (a.priceSource === "transaction") nameRow.append(approxBadge());
  txt.append(nameRow);
  txt.append(el("div", "a-sub", a.isin));
  box.append(img, txt);
  td.append(box);
  return td;
}
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function th(text, opts = {}) {
  const e = el("th", (opts.cls || "") || null, text);
  if (opts.rowspan) e.rowSpan = opts.rowspan;
  if (opts.colspan) e.colSpan = opts.colspan;
  return e;
}
const tdNum = (text, cls) => el("td", cls || null, text);

function renderPositions() {
  const list = state.dashboard.positions;
  $("posCount").textContent = `(${list.length})`;
  const table = $("posTable");
  table.replaceChildren();

  const expanded = state.showOwnPerf;
  const thead = el("thead");
  const r1 = el("tr");
  r1.append(th("Titre", { rowspan: 2, cls: "left" }));
  for (const h of ["Qté", "Valeur", "Cours", "PRU", "+/− (%)", "+/− (€)"]) r1.append(th(h, { rowspan: 2 }));
  r1.append(th("Dernière vente", { colspan: 4, cls: "group sep" }));
  // "Performance du titre": collapsible column group
  const perfTh = th("", expanded ? { colspan: 6, cls: "group sep" } : { rowspan: 2, cls: "group sep toggle-col" });
  const toggleBtn = el("button", "group-toggle", `Performance du titre ${expanded ? "▾" : "▸"}`);
  toggleBtn.title = expanded ? "Replier les colonnes de performance" : "Déplier la performance du titre sur 3 A / 1 A / 6 M / 1 M / 1 S / 1 J";
  toggleBtn.addEventListener("click", () => {
    state.showOwnPerf = !state.showOwnPerf;
    localStorage.setItem("showOwnPerf", state.showOwnPerf ? "1" : "0");
    renderPositions();
  });
  perfTh.append(toggleBtn);
  r1.append(perfTh);
  const r2 = el("tr");
  const saleCols = [["Prix vente", "sep"], ["Cours actuel", ""], ["Écart (%)", ""], ["Écart (€)", ""]];
  const perfCols = expanded ? [["3 A", "sep"], ["1 A", ""], ["6 M", ""], ["1 M", ""], ["1 S", ""], ["1 J", ""]] : [];
  for (const [h, cls] of [...saleCols, ...perfCols]) r2.append(th(h, { cls }));
  thead.append(r1, r2);
  table.append(thead);

  const tbody = el("tbody");
  for (const p of list) {
    const row = el("tr");
    row.append(assetCell(p));
    row.append(tdNum(qty(p.qty)));
    row.append(tdNum(eur(p.valueEur)));
    row.append(tdNum(price(p.priceEur)));
    row.append(tdNum(price(p.avgBuy)));
    row.append(tdNum(pct(p.perfPct), signCls(p.perfPct)));
    row.append(tdNum(eurS(p.perfEur), signCls(p.perfEur)));
    row.append(tdNum(price(p.lastSellPrice), "sep" + (p.lastSellPrice == null ? " na" : "")));
    row.append(tdNum(price(p.lastSellPrice == null ? null : p.priceEur), p.lastSellPrice == null ? "na" : null));
    row.append(tdNum(pct(p.vsLastSellPct), signCls(p.vsLastSellPct)));
    row.append(tdNum(priceS(p.vsLastSellEur), signCls(p.vsLastSellEur)));
    if (expanded) {
      const o = p.ownPerf || {};
      const periods = [["y3", "sep"], ["y1", ""], ["m6", ""], ["m1", ""], ["w1", ""], ["d1", ""]];
      for (const [k, cls] of periods) {
        row.append(tdNum(pct(o[k], 1), `small-pct ${cls} ${signCls(o[k])}`.trim()));
      }
    } else {
      row.append(tdNum("", "sep toggle-col"));
    }
    tbody.append(row);
  }
  table.append(tbody);
  renderPositionCards(list);
  $("positionsCard").hidden = false;
}

function renderArchives() {
  const list = state.dashboard.archives;
  $("arcCount").textContent = `(${list.length})`;
  const table = $("arcTable");
  table.replaceChildren();

  const thead = el("thead");
  const r1 = el("tr");
  r1.append(th("Titre", { rowspan: 2, cls: "left" }));
  for (const h of ["PRU achat", "PRU vente", "Perf (%)", "Perf (€)", "Dernière opération", "Dernière vente"]) r1.append(th(h, { rowspan: 2 }));
  r1.append(th("Depuis la vente", { colspan: 3, cls: "group sep" }));
  const r2 = el("tr");
  for (const [h, cls] of [["Cours actuel", "sep"], ["Écart (%)", ""], ["Écart (€)", ""]]) r2.append(th(h, { cls }));
  thead.append(r1, r2);
  table.append(thead);

  const tbody = el("tbody");
  for (const a of list) {
    const row = el("tr");
    row.append(assetCell(a));
    row.append(tdNum(price(a.avgBuy)));
    row.append(tdNum(price(a.avgSell)));
    row.append(tdNum(pct(a.perfPct), signCls(a.perfPct)));
    row.append(tdNum(eurS(a.perfEur), signCls(a.perfEur)));
    row.append(tdNum(a.lastOpDate ? fmtDate.format(new Date(a.lastOpDate + "T12:00:00Z")) : "—"));
    row.append(tdNum(price(a.lastSellPrice)));
    row.append(tdNum(price(a.currentPrice), "sep" + (a.currentPrice == null ? " na" : "")));
    row.append(tdNum(pct(a.vsLastSellPct), signCls(a.vsLastSellPct)));
    row.append(tdNum(priceS(a.vsLastSellEur), signCls(a.vsLastSellEur)));
    tbody.append(row);
  }
  table.append(tbody);
  renderArchiveCards(list);
  $("archivesCard").hidden = false;
}

// ---------- mobile cards (replace the tables under 680px, via CSS) ----------
function kv(label, value, cls, align) {
  const d = el("div", "kv" + (align ? " " + align : ""));
  d.append(el("div", "kv-l", label));
  d.append(el("div", "kv-v" + (cls ? " " + cls : ""), value));
  return d;
}

// the 6 period pills double as range buttons for the per-asset mini chart
function miniPerfRow(o) {
  const row = el("div", "pcard-perf");
  const buttons = new Map();
  for (const [lbl, k] of [["3 A", "y3"], ["1 A", "y1"], ["6 M", "m6"], ["1 M", "m1"], ["1 S", "w1"], ["1 J", "d1"]]) {
    const cell = el("button", "pp-cell");
    cell.type = "button";
    if (o?.[k] == null) cell.disabled = true;
    cell.append(el("div", "pp-lbl", lbl));
    cell.append(el("div", "pp-val " + signCls(o?.[k]), o?.[k] == null ? "—" : pct(o[k], 1)));
    row.append(cell);
    buttons.set(k, cell);
  }
  return { row, buttons };
}

// ---------- per-asset mini performance chart --------------------------------
const assetSeriesMem = new Map(); // isin -> promise of /api/asset-perf payload
function fetchAssetSeries(isin) {
  if (!assetSeriesMem.has(isin)) {
    assetSeriesMem.set(isin, api(`/api/asset-perf?isin=${isin}`).catch((e) => {
      assetSeriesMem.delete(isin);
      throw e;
    }));
  }
  return assetSeriesMem.get(isin);
}

const ASSET_RANGE_DAYS = { y3: 3 * 365, y1: 365, m6: 182, m1: 30, w1: 7 };
function assetRangePoints(data, key) {
  if (key === "d1") {
    const intra = data.intraday;
    if (!intra?.points?.length || !intra.prevClose) return null;
    return intra.points.map(([t, c]) => ({ t, pct: (c / intra.prevClose - 1) * 100, price: c }));
  }
  const daily = data.daily || [];
  if (daily.length < 2) return null;
  const endMs = Date.parse(daily[daily.length - 1][0]);
  const startKey = new Date(endMs - ASSET_RANGE_DAYS[key] * 86400000).toISOString().slice(0, 10);
  const arr = daily.filter(([d]) => d >= startKey);
  if (arr.length < 2 || !(arr[0][1] > 0)) return null;
  const base = arr[0][1];
  return arr.map(([d, v]) => ({ t: d, pct: (v / base - 1) * 100, price: v }));
}

let miniGradSeq = 0;
function renderMiniChart(wrap, svg, tip, pts, rangeKey) {
  svg.replaceChildren();
  tip.hidden = true;
  const W = wrap.clientWidth || 300, H = 120;
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const padL = 2, padR = 2, padT = 10, padB = 16;
  const n = pts.length;
  const ys = pts.map((p) => p.pct);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymax - ymin < 0.2) { ymin -= 0.25; ymax += 0.25; }
  const padY = (ymax - ymin) * 0.1;
  ymin -= padY; ymax += padY;
  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + ((ymax - v) * (H - padT - padB)) / (ymax - ymin);
  wrap.style.setProperty("--accent", pts[n - 1].pct >= 0 ? "var(--up)" : "var(--down)");

  const defs = sv("defs", {}, svg);
  const gid = `miniGrad${++miniGradSeq}`;
  const grad = sv("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  sv("stop", { offset: 0, style: "stop-color: var(--accent); stop-opacity: 0.18" }, grad);
  sv("stop", { offset: 1, style: "stop-color: var(--accent); stop-opacity: 0" }, grad);

  if (ymin < 0 && ymax > 0) {
    sv("line", { x1: padL, x2: W - padR, y1: y(0), y2: y(0), stroke: "var(--baseline)", "stroke-width": 1, "stroke-dasharray": "4 4" }, svg);
  }
  let d = "";
  for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${x(i).toFixed(2)},${y(pts[i].pct).toFixed(2)}`;
  sv("path", { d: d + `L${x(n - 1).toFixed(2)},${H - padB}L${x(0).toFixed(2)},${H - padB}Z`, fill: `url(#${gid})` }, svg);
  sv("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
  sv("circle", { cx: x(n - 1), cy: y(pts[n - 1].pct), r: 3, fill: "var(--accent)" }, svg);

  const xl = (t) => rangeKey === "d1"
    ? fmtTime.format(t)
    : (["y3", "y1"].includes(rangeKey) ? fmtMonYr : fmtDayMon).format(new Date(t + "T12:00:00Z"));
  const l1 = sv("text", { x: padL, y: H - 4, fill: "var(--muted)", "font-size": 9.5, "font-family": "inherit" }, svg);
  l1.textContent = xl(pts[0].t);
  const l2 = sv("text", { x: W - padR, y: H - 4, fill: "var(--muted)", "font-size": 9.5, "text-anchor": "end", "font-family": "inherit" }, svg);
  l2.textContent = xl(pts[n - 1].t);

  const cross = sv("g", { visibility: "hidden" }, svg);
  const vline = sv("line", { y1: padT, y2: H - padB, stroke: "var(--baseline)", "stroke-width": 1, "stroke-dasharray": "3 3" }, cross);
  const dot = sv("circle", { r: 3.5, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }, cross);

  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const step = (W - padL - padR) / (n - 1);
    const idx = Math.max(0, Math.min(n - 1, Math.round((e.clientX - rect.left - padL) / step)));
    const p = pts[idx], cx = x(idx), cy = y(p.pct);
    cross.setAttribute("visibility", "visible");
    vline.setAttribute("x1", cx);
    vline.setAttribute("x2", cx);
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    tip.replaceChildren(
      el("div", "tt-pct " + signCls(p.pct), pct(p.pct)),
      el("div", "tt-date", rangeKey === "d1" ? fmtTime.format(p.t) : fmtDate.format(new Date(p.t + "T12:00:00Z"))),
      el("div", "tt-value", price(p.price)),
    );
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.max(2, Math.min(W - tw - 2, cx - tw / 2))}px`;
    let top = cy - th - 12;
    if (top < 0) top = cy + 12;
    tip.style.top = `${top}px`;
  };
  svg.onpointermove = move;
  svg.onpointerdown = move;
  svg.onpointerleave = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
}

function assetPerfFold(p) {
  const o = p.ownPerf || {};
  if (!Object.values(o).some((v) => v != null)) return null; // no market data (warrants)
  const fold = el("details", "pp-fold");
  fold.append(el("summary", null, "Performance du titre"));
  const box = el("div", "asset-chart-box");
  const wrap = el("div", "mini-chart-wrap");
  const svg = sv("svg", {});
  const tip = el("div", "tooltip mini-tip");
  tip.hidden = true;
  wrap.append(svg, tip);
  const note = el("div", "mini-note");
  note.hidden = true;
  const { row, buttons } = miniPerfRow(o);
  box.append(wrap, note, row);
  fold.append(box);

  let selected = ["y1", "m6", "m1", "y3", "w1", "d1"].find((k) => o[k] != null);
  let data = null;
  const render = () => {
    for (const [k, b] of buttons) b.setAttribute("aria-selected", String(k === selected));
    if (!data) return;
    const pts = assetRangePoints(data, selected);
    if (!pts) {
      svg.replaceChildren();
      svg.setAttribute("height", 0);
      note.textContent = "Pas de données de cours pour cette période.";
      note.hidden = false;
      return;
    }
    note.hidden = true;
    renderMiniChart(wrap, svg, tip, pts, selected);
  };
  for (const [k, b] of buttons) {
    b.addEventListener("click", () => { selected = k; render(); });
  }
  fold.addEventListener("toggle", async () => {
    if (!fold.open) return;
    if (data) { render(); return; }
    note.textContent = "Chargement de la courbe…";
    note.hidden = false;
    try {
      data = await fetchAssetSeries(p.isin);
      render();
    } catch {
      note.textContent = "Courbe indisponible.";
    }
  });
  return fold;
}

function cardHead(a, rightText, rightCls) {
  const head = el("div", "pcard-head");
  head.append(logoEl(a));
  const name = el("div", "pcard-name", a.name);
  if (a.priceSource === "transaction") name.append(approxBadge());
  head.append(name);
  head.append(el("div", "pcard-value " + (rightCls || ""), rightText));
  head.append(el("span", "pcard-chev", "▸"));
  return head;
}

// collapsible card: summary = head + sub (always visible), body = detail grid + perf
function makeCard(headEl, subEl, bodyChildren) {
  const card = el("details", "pcard");
  const sum = el("summary", "pcard-summary");
  sum.append(headEl, subEl);
  card.append(sum);
  const body = el("div", "pcard-body");
  for (const c of bodyChildren) if (c) body.append(c);
  card.append(body);
  return card;
}

function renderPositionCards(list) {
  const box = $("posCards");
  box.replaceChildren();
  for (const p of list) {
    const sub = el("div", "pcard-sub");
    sub.append(el("span", null, `Qté : ${qty(p.qty)} | Cours : ${price(p.priceEur)}`));
    sub.append(el("span", "pcard-pl " + signCls(p.perfEur), `${pct(p.perfPct)} · ${eurS(p.perfEur)}`));

    const grid = el("div", "pcard-grid g3");
    grid.append(kv("PRU", price(p.avgBuy)));
    grid.append(kv("Dernière vente", p.lastSellPrice == null ? "—" : price(p.lastSellPrice), null, "kv-c"));
    grid.append(kv("Depuis la vente",
      p.lastSellPrice == null ? "—" : `${pct(p.vsLastSellPct)}\n${priceS(p.vsLastSellEur)}`,
      p.lastSellPrice == null ? null : signCls(p.vsLastSellPct), "kv-r"));

    box.append(makeCard(cardHead(p, eur(p.valueEur)), sub, [grid, assetPerfFold(p)]));
  }
}

function renderArchiveCards(list) {
  const box = $("arcCards");
  box.replaceChildren();
  for (const a of list) {
    const sub = el("div", "pcard-sub");
    sub.append(el("span", null, `PRU ${price(a.avgBuy)} → vendu ${price(a.avgSell)}`));
    sub.append(el("span", "pcard-pl " + signCls(a.perfPct), pct(a.perfPct)));

    const grid = el("div", "pcard-grid");
    grid.append(kv("Dernière opération", a.lastOpDate ? fmtDate.format(new Date(a.lastOpDate + "T12:00:00Z")) : "—"));
    grid.append(kv("Dernière vente", price(a.lastSellPrice), null, "kv-r"));
    grid.append(kv("Cours actuel", a.currentPrice == null ? "—" : price(a.currentPrice)));
    grid.append(kv("Depuis la vente",
      a.currentPrice == null ? "—" : `${pct(a.vsLastSellPct)}\n${priceS(a.vsLastSellEur)}`,
      a.currentPrice == null ? null : signCls(a.vsLastSellPct), "kv-r"));
    box.append(makeCard(cardHead(a, eurS(a.perfEur), signCls(a.perfEur)), sub, [grid]));
  }
}

// ---------- ranges ----------
function renderRanges() {
  const box = $("ranges");
  box.replaceChildren();
  for (const [key, label] of RANGES) {
    const b = el("button", null, label);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(key === state.range));
    b.addEventListener("click", () => setRange(key));
    box.append(b);
  }
}

async function setRange(range) {
  if (range === state.range) return;
  state.range = range;
  renderRanges();
  $("chartCard").classList.add("refreshing");
  try {
    state.perf = await api(`/api/perf?range=${range}`);
    renderChartSection();
  } catch (e) {
    console.warn("perf:", e);
  } finally {
    $("chartCard").classList.remove("refreshing");
  }
}

// ---------- load & refresh ----------
function renderAll() {
  renderHero();
  renderChartSection();
  renderPositions();
  renderArchives();
  $("updated").textContent = `Actualisé à ${new Date().toLocaleTimeString("fr-FR")}`;
}

function showError(e) {
  const box = $("loading");
  box.replaceChildren();
  const err = el("div", "error-box");
  err.append(el("div", null, `Impossible de charger les données : ${e.message}`));
  const btn = el("button", null, "Réessayer");
  btn.addEventListener("click", () => { location.reload(); });
  err.append(btn);
  box.append(err);
}

let refreshing = false;
async function refresh(soft) {
  if (refreshing) return;
  refreshing = true;
  if (soft) document.querySelectorAll("section.card").forEach((s) => s.classList.add("refreshing"));
  try {
    const [dash, perf] = await Promise.all([
      api("/api/dashboard"),
      api(`/api/perf?range=${state.range}`),
    ]);
    state.dashboard = dash;
    state.perf = perf;
    $("loading").hidden = true;
    renderAll();
  } catch (e) {
    if (!state.dashboard) showError(e);
    else console.warn("refresh:", e);
  } finally {
    refreshing = false;
    document.querySelectorAll("section.card").forEach((s) => s.classList.remove("refreshing"));
  }
}

// chart interactions
$("chartWrap").addEventListener("pointermove", onChartMove);
$("chartWrap").addEventListener("pointerdown", onChartMove);
$("chartWrap").addEventListener("pointerleave", onChartLeave);
let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.perf) renderChart(); }, 120);
}).observe($("chartWrap"));

// collapsible sections: Positions open / Archives closed by default, choice remembered
for (const [id, key, defaultOpen] of [["posFold", "foldPositions", true], ["arcFold", "foldArchives", false]]) {
  const fold = $(id);
  const saved = localStorage.getItem(key);
  fold.open = saved == null ? defaultOpen : saved === "1";
  fold.addEventListener("toggle", () => localStorage.setItem(key, fold.open ? "1" : "0"));
}

renderRanges();
refresh(false);
setInterval(() => refresh(true), 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh(true);
});
