"use strict";

/**
 * features/kripto/mstrutChart.js
 * ------------------------------------------------------------------
 * Gambar chart Market Structure untuk !mstrut (PNG), dari hasil analyzeStructure (mstrutCore.js):
 *   - candle closed (candle berjalan, kalau ada, digambar berongga putus-putus = belum final)
 *   - zigzag swing berlabel HH / HL / LH / LL
 *   - BSL / SSL terdekat yang masih utuh (garis sampai tepi kanan) + EQH / EQL
 *   - sweep: garis dari level sampai candle penyapu + penanda wick
 *   - BOS / CHoCH (+ MSS): garis dari swing yang ditembus sampai candle penembus, berlabel
 * Semua posisi berasal dari engine, tidak ada hitungan level di sini.
 */

const { createCanvas } = require("@napi-rs/canvas");
const { MSTRUT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { C, fontFamily, fmtPrice: fmtPriceKit, niceStep, tickLabel } = require("./chartKit");

const COL = { bsl: "#f59e0b", ssl: "#38bdf8", sweep: "#c084fc" };
const LABEL_COLOR = { HH: C.up, HL: C.up, LH: C.down, LL: C.down, EH: C.axis, EL: C.axis };
const MAX_EVENTS = 6;

/** @returns {Buffer} PNG */
function renderMstrutChart({ candles, res, title, tf, digits = null }) {
  const closed = candles.filter((c) => c.closed !== false);
  const live = candles.length && candles[candles.length - 1].closed === false ? candles[candles.length - 1] : null;
  const n = closed.length;
  if (n < 10 || !res) throw new Error("CANDLES_TOO_FEW");
  const fmtPrice = (p) => fmtPriceKit(p, digits);
  const family = fontFamily();
  const from = Math.max(0, n - CFG.CHART_BARS);
  const bars = closed.slice(from);
  const nb = bars.length + (live ? 1 : 0);
  const last = closed[n - 1];

  // ---- apa yang digambar ----
  const liq = res.liquidity;
  const swings = res.swings.filter((s) => s.i >= from);
  const events = res.allEvents.filter((e) => e.k >= from).slice(-MAX_EVENTS);
  const sweeps = res.allSweeps.filter((s) => s.k >= from).slice(-3);
  const lines = []; // { i0, i1|null, price, color, dash, tag, label }
  const add = (it, color, tag) => it && lines.push({ i0: Math.max(it.firstI ?? it.i, from), i1: null, price: it.level, color, tag, label: it.kind === "eq" ? it.label : null });
  add(liq.nearestBSL, COL.bsl, "BSL");
  add(liq.nearestSSL, COL.ssl, "SSL");
  for (const it of [liq.eqh, liq.eql]) {
    if (!it) continue;
    if (it.status === "intact") add(it, it.side === "BSL" ? COL.bsl : COL.ssl, null);
    else if (it.k != null && it.k >= from) lines.push({ i0: Math.max(it.firstI ?? it.i, from), i1: it.k, price: it.level, color: it.side === "BSL" ? COL.bsl : COL.ssl, tag: null, label: it.label, dim: true });
  }
  for (const s of sweeps) lines.push({ i0: Math.max(s.levelI, from), i1: s.k, price: s.level, color: COL.sweep, tag: null, label: null, dim: true });

  // ---- rentang harga ----
  let lo = Math.min(...bars.map((b) => b.l), live ? live.l : Infinity);
  let hi = Math.max(...bars.map((b) => b.h), live ? live.h : -Infinity);
  const span0 = hi - lo || hi * 0.01;
  for (const p of [...lines.filter((l) => l.tag).map((l) => l.price), ...events.map((e) => e.level)]) {
    if (p > lo - span0 * 0.35 && p < hi + span0 * 0.35) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
  }
  const pad = (hi - lo) * 0.09 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const W = 1600;
  const Lm = 20;
  const Rm = 200;
  const T = 74;
  const hP = 760;
  const B = 52;
  const H = T + hP + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const pp = { x: Lm, y: T, w: cw, h: hP };
  g.fillStyle = C.panel;
  g.fillRect(pp.x, pp.y, pp.w, pp.h);
  const Y = (p) => pp.y + ((hi - p) / (hi - lo)) * pp.h;
  const slot = cw / nb;
  const X = (i) => Lm + slot * (i - from) + slot / 2;
  const bodyW = Math.max(2, slot * 0.62);
  const inRange = (p) => p >= lo && p <= hi;

  // grid + label harga
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const tagYs = [...lines.filter((l) => l.tag).map((l) => Y(l.price)), Y(last.c)];
  const step = niceStep(hi - lo, 8);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Y(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pp.x, yy);
    g.lineTo(pp.x + pp.w, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), pp.x + pp.w + 10, yy);
  }
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < bars.length - 2; i += every) {
    const xx = Math.round(X(from + i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, pp.y);
    g.lineTo(xx, pp.y + pp.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, pp.y + pp.h + 14);
  }

  // garis likuiditas (di belakang candle)
  const rightEdge = pp.x + pp.w;
  for (const l of lines) {
    if (!inRange(l.price)) continue;
    const x0 = Math.max(pp.x, X(l.i0));
    const x1 = l.i1 == null ? rightEdge : Math.min(rightEdge, X(l.i1));
    const yy = Math.round(Y(l.price)) + 0.5;
    g.save();
    g.strokeStyle = l.color;
    g.lineWidth = 1.8;
    g.setLineDash(l.dim ? [3, 6] : [10, 7]);
    g.globalAlpha = l.dim ? 0.8 : 0.95;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(x1, yy);
    g.stroke();
    g.restore();
    if (l.label) {
      g.save();
      g.font = `bold 17px ${family}`;
      g.fillStyle = l.color;
      g.textAlign = "left";
      g.textBaseline = "bottom";
      g.fillText(l.label, x0 + 6, yy - 3);
      g.restore();
    }
  }

  // candle closed
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const i = from + k;
    const color = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(xx, Y(b.h));
    g.lineTo(xx, Y(b.l));
    g.stroke();
    g.fillRect(xx - bodyW / 2, Y(Math.max(b.o, b.c)), bodyW, Math.max(1.5, Math.abs(Y(b.o) - Y(b.c))));
  });
  // candle berjalan: berongga + putus-putus (belum final)
  if (live) {
    const color = live.c >= live.o ? C.up : C.down;
    const xx = Math.round(X(n)) + 0.5;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(xx, Y(live.h));
    g.lineTo(xx, Y(live.l));
    g.stroke();
    g.strokeRect(xx - bodyW / 2, Y(Math.max(live.o, live.c)), bodyW, Math.max(1.5, Math.abs(Y(live.o) - Y(live.c))));
    g.restore();
  }
  // harga terakhir (closed)
  {
    const yy = Math.round(Y(last.c)) + 0.5;
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(pp.x, yy);
    g.lineTo(rightEdge, yy);
    g.stroke();
    g.restore();
  }
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pp.x + 0.5, pp.y + 0.5, pp.w, pp.h);

  // zigzag swing + label HH/HL/LH/LL
  if (swings.length > 1) {
    g.save();
    g.strokeStyle = C.arrow;
    g.lineWidth = 2;
    g.globalAlpha = 0.55;
    g.lineJoin = "round";
    g.beginPath();
    swings.forEach((s, k) => (k === 0 ? g.moveTo(X(s.i), Y(s.price)) : g.lineTo(X(s.i), Y(s.price))));
    g.stroke();
    g.restore();
  }
  g.textAlign = "center";
  for (const s of swings) {
    const x = X(s.i);
    const y = Y(s.price);
    const color = (s.label && LABEL_COLOR[s.label]) || C.axis;
    g.save();
    g.fillStyle = C.bg;
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (s.label) {
      g.font = `bold 18px ${family}`;
      g.textBaseline = "middle";
      const w = g.measureText(s.label).width + 12;
      const cy = s.type === "H" ? y - 22 : y + 22;
      g.fillStyle = "rgba(11,14,20,0.85)";
      g.fillRect(x - w / 2, cy - 11, w, 22);
      g.fillStyle = color;
      g.fillText(s.label, x, cy + 1);
    }
    g.restore();
  }

  // BOS / CHoCH (+MSS): garis dari swing yang ditembus ke candle penembus
  for (const e of events) {
    if (!inRange(e.level)) continue;
    const color = e.dir === "bull" ? C.up : C.down;
    const x0 = Math.max(pp.x, X(Math.max(e.refI, from)));
    const x1 = X(e.k);
    const yy = Math.round(Y(e.level)) + 0.5;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash([8, 5]);
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(x1, yy);
    g.stroke();
    g.restore();
    const text = e.mss ? "CHoCH·MSS" : e.kind;
    g.save();
    g.font = `bold 18px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const w = g.measureText(text).width + 14;
    const cx = Math.max(pp.x + w / 2 + 2, (x0 + x1) / 2);
    const cy = e.dir === "bull" ? yy - 17 : yy + 17;
    g.fillStyle = "rgba(11,14,20,0.9)";
    g.fillRect(cx - w / 2, cy - 12, w, 24);
    g.strokeStyle = color;
    g.lineWidth = 1.4;
    g.strokeRect(cx - w / 2 + 0.5, cy - 11.5, w - 1, 23);
    g.fillStyle = color;
    g.fillText(text, cx, cy + 1);
    g.restore();
  }

  // penanda sweep: segitiga di ujung wick + label
  for (const s of sweeps) {
    if (!inRange(s.wick)) continue;
    const x = X(s.k);
    const bsl = s.side === "BSL";
    const y = Y(s.wick) + (bsl ? -9 : 9);
    g.save();
    g.fillStyle = COL.sweep;
    g.beginPath();
    if (bsl) {
      g.moveTo(x, y + 7);
      g.lineTo(x - 7, y - 6);
      g.lineTo(x + 7, y - 6);
    } else {
      g.moveTo(x, y - 7);
      g.lineTo(x - 7, y + 6);
      g.lineTo(x + 7, y + 6);
    }
    g.closePath();
    g.fill();
    g.font = `bold 17px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(`Sweep ${s.side}`, x, y + (bsl ? -22 : 22));
    g.restore();
  }

  // tag sumbu kanan
  {
    const tag = (txt, yy, color) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = color;
      g.fillRect(rightEdge + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, rightEdge + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [...lines.filter((l) => l.tag && inRange(l.price)).map((l) => ({ txt: `${l.tag} ${fmtPrice(l.price)}`, y: Y(l.price), color: l.color })), { txt: fmtPrice(last.c), y: Y(last.c), color: lastColor }].sort((a, b) => a.y - b.y);
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + 28);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, pp.y + pp.h - 14), tg.color);
  }

  // judul + legenda
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = closed[Math.max(0, n - 2)];
  const chg = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  const trendTxt = res.trend === "up" ? "Bullish (HH + HL)" : res.trend === "down" ? "Bearish (LH + LL)" : "Sideways";
  g.fillText(`Closed candles only · swing = pivot ±${res.cfg.PIVOT_WIN}, min ${res.cfg.MIN_SWING_PCT}% · ${trendTxt} · BSL amber, SSL blue, sweep purple${live ? " · dashed candle = not closed" : ""}`, Lm, 56);

  return canvas.toBuffer("image/png");
}

module.exports = { renderMstrutChart };
