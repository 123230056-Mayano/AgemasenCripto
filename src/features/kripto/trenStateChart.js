"use strict";

/**
 * features/kripto/trenStateChart.js
 * ------------------------------------------------------------------
 * Chart !trenstate (fase 2 catatan desain): candle + zona "grafik lanjutan" di kanan dengan PANAH SKENARIO.
 *
 * Penting: panah ini SKENARIO BERSYARAT, bukan ramalan. Yang digambar:
 *   - panah skenario LANJUT (searah tren asal) dan panah skenario REVERSAL / BATAL (menembus level batal);
 *   - panah yang condong menurut status = tebal dan solid, panah alternatifnya = tipis dan putus-putus;
 *   - status "koreksi, belum jelas" dan RANGE: semua panah putus-putus (tidak ada yang dijagokan).
 * Ujung panah memakai level nyata dari trenState.js (target measured move, level batal, batas range). Kalau tidak ada
 * level target, panah hanya skematis sepanjang CHART_ARROW_ATR x ATR dan TIDAK diberi label harga.
 *
 * Trendline (trenStateTrendline.js) digambar sebagai overlay informasi: garis swing ungu (solid = lewat swing sendiri, putus-putus =
 * paralel turunan) diperpanjang ke zona skenario; kalau tidak ada garis swing, yang digambar jalur regresi (abu-abu). Tidak mengubah panah.
 *
 * buildProjection() murni (bisa diuji tanpa canvas). renderTrenStateChart() butuh @napi-rs/canvas, gayanya sama
 * dengan renderHhllChart (chartKit.js). Semua teks datang dari pemanggil lewat `labels` (i18n).
 */

const { createCanvas } = require("@napi-rs/canvas");
const { TRENSTATE_CONFIG: CFG } = require("../../config/indicatorConfig");
const { C, fontFamily, fmtPrice, niceStep, tickLabel, arrow, chip } = require("./chartKit");
const { priceAt } = require("./trenStateTrendline");

const TL_COLOR = "#c084fc"; // garis swing
const TL_REG_COLOR = "#94a3b8"; // jalur regresi

const isNum = (v) => typeof v === "number" && isFinite(v);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const DEFAULT_LABELS = {
  title: "Trend State",
  status: "",
  cont: "Continue",
  rev: "Reversal",
  cancel: "Invalidated if close back beyond",
  brkUp: "Breakout above",
  brkDown: "Breakdown below",
  zone: "Scenario",
  foot: "Conditional scenario, not a prediction. Educational, not investment advice.",
  inv: "Inv",
  reclaim: "Reclaim",
  tgt: "Tgt",
  high: "High",
  low: "Low",
  tlSup: "Sup line",
  tlRes: "Res line",
  tlReg: "Regression",
};

/**
 * Susun panah skenario dari hasil assessTrenState (murni).
 * @param {object} res hasil assessTrenState / assessRaw (butuh status, rawStatus, dir, close, atr, levels)
 * @param {object} [cfg]
 * @returns {null|{view:string, dir:"up"|"down"|null, arrows:{kind:"cont"|"rev"|"cancel"|"brkUp"|"brkDown", dir:"up"|"down", to:number, level:number|null, solid:boolean}[]}}
 */
function buildProjection(res, cfg = CFG) {
  if (!res || !isNum(res.close) || !isNum(res.atr) || !(res.atr > 0)) return null;
  const L = res.levels || {};
  const { close, atr } = res;
  const view = res.rawStatus || res.status; // level selalu milik penilaian mentah candle terakhir
  const len = cfg.CHART_ARROW_ATR * atr;

  if (view === "range") {
    if (!isNum(L.rangeHigh) || !isNum(L.rangeLow)) return null;
    return {
      view,
      dir: null,
      arrows: [
        { kind: "brkUp", dir: "up", to: L.rangeHigh + atr, level: L.rangeHigh, solid: false },
        { kind: "brkDown", dir: "down", to: L.rangeLow - atr, level: L.rangeLow, solid: false },
      ],
    };
  }

  const dir = res.dir;
  if (dir !== "up" && dir !== "down") return null;
  const up = dir === "up";
  const sign = up ? 1 : -1;
  const opp = up ? "down" : "up";
  const hasInv = isNum(L.invalidation);

  // skenario lanjut: ke target measured move kalau ada dan searah, kalau tidak panah skematis (tanpa label harga)
  const useTarget = isNum(L.target) && (up ? L.target > close : L.target < close);
  const ext = isNum(L.extreme) ? L.extreme : close;
  const contTo = useTarget ? L.target : up ? Math.max(close + len, ext + 0.5 * len) : Math.min(close - len, ext - 0.5 * len);
  const cont = { kind: "cont", dir, to: contTo, level: useTarget ? L.target : null, solid: false };

  if (view === "reversal") {
    // struktur sudah patah: panah utama = melawan tren asal; panah putus-putus = batal kalau close kembali melewati level
    const rev = { kind: "rev", dir: opp, to: close - sign * len, level: null, solid: true };
    const out = [rev];
    if (hasInv) out.push({ kind: "cancel", dir, to: L.invalidation + sign * atr, level: L.invalidation, solid: false });
    return { view, dir, arrows: out };
  }

  const rev = { kind: "rev", dir: opp, to: hasInv ? L.invalidation - sign * atr : close - sign * len, level: hasInv ? L.invalidation : null, solid: false };
  if (view === "continue" || view === "pullback") cont.solid = true;
  else if (view === "warn") rev.solid = true;
  // "correction" (selisih tipis): keduanya putus-putus
  return { view, dir, arrows: [cont, rev] };
}

/**
 * @param {{candles:object[], coin:string, tf:string, res:object, labels?:object}} p
 * @returns {Buffer} PNG
 */
function renderTrenStateChart({ candles, coin, tf, res, labels = {} }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const lb = { ...DEFAULT_LABELS, ...labels };
  const proj = buildProjection(res);
  const L = (res && res.levels) || {};
  const family = fontFamily();
  const n = candles.length;
  const last = candles[n - 1];
  const from = Math.max(0, n - CFG.CHART_BARS);
  const bars = candles.slice(from);
  const nb = bars.length;
  const projBars = CFG.CHART_PROJ_BARS;

  // garis level (invalidasi, reclaim, ekstrem; atau batas range)
  const lines = [];
  const addLine = (price, label, color, dash) => isNum(price) && lines.push({ price, label, color, dash });
  if (proj && proj.view === "range") {
    addLine(L.rangeHigh, lb.high, C.res, [10, 7]);
    addLine(L.rangeLow, lb.low, C.sup, [10, 7]);
  } else {
    addLine(L.invalidation, lb.inv, "#f59e0b", [10, 7]);
    if (proj && (proj.view === "pullback" || proj.view === "warn" || proj.view === "correction")) addLine(L.reclaim, lb.reclaim, "#38bdf8", [4, 6]);
  }

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  const span0 = hi - lo || hi * 0.01;
  // level yang terlalu jauh tidak ikut memperlebar sumbu supaya candle tidak gepeng
  const near = (p) => p >= lo - span0 * 0.6 && p <= hi + span0 * 0.6;
  const drawLines = lines.filter((k) => near(k.price));
  for (const k of drawLines) {
    lo = Math.min(lo, k.price);
    hi = Math.max(hi, k.price);
  }
  // trendline: level di candle terakhir ikut sumbu bila dekat; bagian garis yang melenceng jauh dipotong oleh clip panel
  const tl = res && res.trendline;
  const tlLines = [];
  if (tl && tl.mode === "swing") {
    if (tl.resistance) tlLines.push({ line: tl.resistance, label: lb.tlRes });
    if (tl.support) tlLines.push({ line: tl.support, label: lb.tlSup });
  }
  const tlReg = tl && tl.mode === "regression" ? tl.regression : null;
  const tlNow = [...tlLines.map((d) => priceAt(d.line, n - 1)), ...(tlReg ? [tlReg.upperNow, tlReg.lowerNow] : [])];
  for (const v of tlNow) {
    if (!isNum(v) || !near(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const arrows = proj ? proj.arrows.map((a) => ({ ...a, toDraw: clamp(a.to, lo - span0 * 0.6, hi + span0 * 0.6) })) : [];
  for (const a of arrows) {
    lo = Math.min(lo, a.toDraw);
    hi = Math.max(hi, a.toDraw);
  }
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const W = 1600;
  const Lm = 20;
  const Rm = 190;
  const T = 96;
  const hP = 760;
  const B = 76;
  const H = T + hP + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const P = { x: Lm, y: T, w: cw, h: hP };
  g.fillStyle = C.panel;
  g.fillRect(P.x, P.y, P.w, P.h);

  const totalSlots = nb + projBars;
  const slot = cw / totalSlots;
  const Yp = (p) => P.y + ((hi - p) / (hi - lo)) * P.h;
  const X = (k) => Lm + slot * k + slot / 2; // k = indeks dalam jendela gambar (0..nb-1 candle, sesudahnya zona skenario)
  const bodyW = Math.max(2, slot * 0.62);
  const xLast = X(nb - 1);
  const xZone = Lm + slot * nb;

  // zona skenario (kanan)
  g.fillStyle = "rgba(79,140,255,0.06)";
  g.fillRect(xZone, P.y, P.x + P.w - xZone, P.h);
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.setLineDash([6, 6]);
  g.beginPath();
  g.moveTo(Math.round(xZone) + 0.5, P.y);
  g.lineTo(Math.round(xZone) + 0.5, P.y + P.h);
  g.stroke();
  g.setLineDash([]);

  // grid + label harga
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagYs = [...drawLines.map((k) => Yp(k.price)), Yp(last.c)];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(P.x + P.w, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), P.x + P.w + 10, yy);
  }

  // grid vertikal + label waktu (hanya area candle)
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < nb - 2; i += every) {
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, P.y);
    g.lineTo(xx, P.y + P.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, P.y + P.h + 14);
  }

  // garis level
  for (const k of drawLines) {
    const yy = Math.round(Yp(k.price)) + 0.5;
    g.save();
    g.strokeStyle = k.color;
    g.lineWidth = 1.7;
    g.setLineDash(k.dash);
    g.globalAlpha = 0.95;
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(P.x + P.w, yy);
    g.stroke();
    g.restore();
  }

  // trendline (di bawah candle supaya sumbu candle tetap terbaca). Indeks garis = indeks array candles; jendela gambar mulai di `from`.
  const idxEnd = from + totalSlots - 0.5; // tepi kanan panel
  const tlPath = (line, idxA, idxB, shift = 0) => {
    g.beginPath();
    g.moveTo(X(idxA - from), Yp(priceAt(line, idxA) + shift));
    g.lineTo(X(idxB - from), Yp(priceAt(line, idxB) + shift));
  };
  g.save();
  g.beginPath();
  g.rect(P.x, P.y, P.w, P.h);
  g.clip();
  for (const d of tlLines) {
    const ln = d.line;
    const a = Math.max(ln.i0, from);
    g.save();
    g.strokeStyle = TL_COLOR;
    g.lineWidth = ln.derived ? 2 : 2.6;
    g.globalAlpha = ln.derived ? 0.8 : 0.95;
    if (ln.derived) g.setLineDash([9, 7]);
    tlPath(ln, a, idxEnd);
    g.stroke();
    g.restore();
    for (const an of ln.anchors || []) {
      if (an.i < from) continue;
      g.save();
      g.fillStyle = C.bg;
      g.strokeStyle = TL_COLOR;
      g.lineWidth = 2.2;
      g.beginPath();
      g.arc(X(an.i - from), Yp(an.price), 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
    }
  }
  if (tlReg) {
    const a = Math.max(tlReg.i0, from);
    const band = (idx) => [priceAt(tlReg, idx) + tlReg.half, priceAt(tlReg, idx) - tlReg.half];
    const [u1, l1] = band(a);
    const [u2, l2] = band(idxEnd);
    g.save();
    g.fillStyle = "rgba(148,163,184,0.08)";
    g.beginPath();
    g.moveTo(X(a - from), Yp(u1));
    g.lineTo(X(idxEnd - from), Yp(u2));
    g.lineTo(X(idxEnd - from), Yp(l2));
    g.lineTo(X(a - from), Yp(l1));
    g.closePath();
    g.fill();
    g.strokeStyle = TL_REG_COLOR;
    g.lineWidth = 1.8;
    g.globalAlpha = 0.9;
    g.setLineDash([3, 6]);
    tlPath(tlReg, a, idxEnd, tlReg.half);
    g.stroke();
    tlPath(tlReg, a, idxEnd, -tlReg.half);
    g.stroke();
    g.setLineDash([10, 8]);
    g.lineWidth = 2.2;
    tlPath(tlReg, a, idxEnd);
    g.stroke();
    g.restore();
  }
  g.restore();

  // candle
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const color = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(k)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(xx, Yp(b.h));
    g.lineTo(xx, Yp(b.l));
    g.stroke();
    g.fillRect(xx - bodyW / 2, Yp(Math.max(b.o, b.c)), bodyW, Math.max(1.5, Math.abs(Yp(b.o) - Yp(b.c))));
  });

  // harga terakhir
  {
    const yy = Math.round(Yp(last.c)) + 0.5;
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(P.x + P.w, yy);
    g.stroke();
    g.restore();
  }
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(P.x + 0.5, P.y + 0.5, P.w, P.h);

  // panah skenario: dari close terakhir ke zona kanan; yang condong = tebal solid, alternatif = tipis putus-putus
  const placed = [];
  const xEnd = P.x + P.w - 34;
  const x0 = xLast + slot * 1.2;
  const y0 = Yp(last.c);
  g.save();
  g.fillStyle = C.bg;
  g.strokeStyle = C.axis;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(xLast, y0, 6, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.restore();
  // panah alternatif digambar dulu supaya yang condong berada di atas
  for (const a of [...arrows].sort((p, q) => Number(p.solid) - Number(q.solid))) {
    const color = a.dir === "up" ? C.up : C.down;
    arrow(g, x0, y0, xEnd, Yp(a.toDraw), a.solid ? { color, width: 5, head: 24 } : { color, width: 3, head: 18, dash: [10, 8], alpha: 0.85 });
  }
  // label ujung panah (chip)
  for (const a of arrows) {
    const color = a.dir === "up" ? C.up : C.down;
    const base = { cont: lb.cont, rev: lb.rev, cancel: lb.cancel, brkUp: lb.brkUp, brkDown: lb.brkDown }[a.kind];
    const text = isNum(a.level) ? `${base} ${fmtPrice(a.level)}` : base;
    chip(g, family, text, xEnd - 70, Yp(a.toDraw) + (a.dir === "up" ? 30 : -30), P, color, placed);
  }

  // label trendline di awal zona skenario (nilai garis pada posisi label itu, jadi cocok dengan yang tergambar)
  {
    const idxLbl = from + nb + 2;
    const cx = X(nb + 2) + 60;
    for (const d of tlLines) chip(g, family, `${d.label} ${fmtPrice(priceAt(d.line, idxLbl))}`, cx, Yp(priceAt(d.line, idxLbl)), P, TL_COLOR, placed);
    if (tlReg) chip(g, family, `${lb.tlReg} ${fmtPrice(priceAt(tlReg, idxLbl))}`, cx, Yp(priceAt(tlReg, idxLbl)), P, TL_REG_COLOR, placed);
  }

  // tag sumbu kanan
  {
    const tag = (txt, yy, color) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = color;
      g.fillRect(P.x + P.w + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, P.x + P.w + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [...drawLines.map((k) => ({ txt: `${k.label} ${fmtPrice(k.price)}`, y: Yp(k.price), color: k.color })), { txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor }].sort((a, b) => a.y - b.y);
    const gapY = 28;
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + gapY);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, P.y + P.h - 14), tg.color);
  }

  // judul, status, label zona, catatan bawah
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}  ${lb.title}`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = candles[Math.max(0, n - 2)];
  const chg = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)`, Lm + titleW + 20, 27);
  if (lb.status) {
    g.font = `bold 24px ${family}`;
    g.fillStyle = C.text;
    g.fillText(lb.status, Lm, 64);
  }
  g.font = `bold 19px ${family}`;
  g.fillStyle = C.axis;
  g.textAlign = "center";
  g.fillText(lb.zone, (xZone + P.x + P.w) / 2, P.y + 18);
  g.textAlign = "left";
  g.font = `19px ${family}`;
  g.fillText(lb.foot, Lm, H - 16);

  return canvas.toBuffer("image/png");
}

module.exports = { buildProjection, renderTrenStateChart, DEFAULT_LABELS };
