"use strict";

/**
 * features/kripto/farleyChart.js
 * ------------------------------------------------------------------
 * Chart !farley dan !alertfarley. Dua panel dengan sumbu waktu yang sama:
 *   - panel harga : candle closed + ribbon SMA 5-8-13 + Bollinger 13,2 (garis tengah = SMA13 yang sama) +
 *                   level breakout (kalau ada) + zona Entry / SL / TP1 / TP2 untuk skenario BUY / SELL;
 *   - panel bawah : Stochastic 5 bar (%K lambat, %D) dengan garis 20 / 80.
 * Semua seri dihitung ulang dari candle closed memakai fungsi farleyCore.js (sma, bollinger, stochastic), jadi angka di chart
 * identik dengan yang dipakai analisis. Chart hanya menggambar, tidak menilai. Semua teks datang dari pemanggil lewat `labels`.
 * Butuh @napi-rs/canvas; gayanya sama dengan chartKit.js (tema gelap, font, format harga).
 */

const { createCanvas } = require("@napi-rs/canvas");
const { FARLEY_CONFIG: CFG } = require("../../config/indicatorConfig");
const { C, fontFamily, fmtPrice, niceStep, tickLabel } = require("./chartKit");
const { sma, bollinger, stochastic } = require("./farleyCore");

const COL = {
  sma5: "#facc15",
  sma8: "#fb923c",
  sma13: "#38bdf8",
  bb: "#a78bfa",
  stochK: "#38bdf8",
  stochD: "#fb923c",
  entry: "#e5e7eb",
  wait: "#f59e0b",
  range: "#94a3b8",
};

const isNum = (v) => typeof v === "number" && isFinite(v);
const PLAN_TP2_MAX_EXTEND = 0.6; // TP2 ikut skala sumbu hanya kalau memperluasnya <= 60% dari rentang

const DEFAULT_LABELS = {
  title: "Farley",
  status: "",
  tone: "wait", // buy | sell | wait | range | nodata (menentukan warna status)
  entry: "Entry",
  sl: "SL",
  tp1: "TP1",
  tp2: "TP2",
  brk: "Brk",
  tp2Out: "(off-chart)",
  stoch: "Stochastic 5,3,3",
  foot: "Conditional scenario, not a prediction. Educational, not investment advice.",
};

const toneColor = (tone) => (tone === "buy" ? C.up : tone === "sell" ? C.down : tone === "range" ? COL.range : COL.wait);

/**
 * @param {{candles:object[], coin:string, tf:string, sc:object, labels?:object}} p
 *   candles = candle CLOSED TF utama (yang sama dengan yang dinilai); sc = hasil computeFarley.
 * @returns {Buffer} PNG
 */
function renderFarleyChart({ candles, coin, tf, sc, labels = {} }) {
  if (!candles || candles.length < 30) throw new Error("CANDLES_TOO_FEW");
  const lb = { ...DEFAULT_LABELS, ...labels };
  const family = fontFamily();
  const plan = sc && sc.plan && (sc.status === "buy" || sc.status === "sell") ? sc.plan : null;

  // Seri indikator dari SEMUA candle closed (supaya periode hangat), lalu dipotong ke jendela gambar.
  const closes = candles.map((c) => c.c);
  const s5 = sma(closes, CFG.SMA_FAST);
  const s8 = sma(closes, CFG.SMA_MID);
  const s13 = sma(closes, CFG.SMA_SLOW);
  const bb = bollinger(closes, CFG.BB_PERIOD, CFG.BB_K, s13);
  const st = stochastic(candles);

  const n = candles.length;
  const from = Math.max(0, n - CFG.CHART_BARS);
  const bars = candles.slice(from);
  const nb = bars.length;
  const last = candles[n - 1];

  // ---- skala harga ----
  let lo = Infinity;
  let hi = -Infinity;
  const take = (v) => {
    if (!isNum(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (let i = from; i < n; i++) {
    take(candles[i].l);
    take(candles[i].h);
    take(bb.upper[i]);
    take(bb.lower[i]);
  }
  const span0 = hi - lo || hi * 0.01;
  const brk = isNum(sc?.breakoutLevel) && sc.breakoutLevel >= lo - span0 * 0.4 && sc.breakoutLevel <= hi + span0 * 0.4 ? sc.breakoutLevel : null;
  take(brk);
  let tp2InView = false;
  if (plan) {
    for (const v of [plan.entry, plan.sl, plan.tp1]) take(v);
    const span = hi - lo;
    const ext = plan.tp2 > hi ? plan.tp2 - hi : plan.tp2 < lo ? lo - plan.tp2 : 0;
    tp2InView = ext <= span * PLAN_TP2_MAX_EXTEND;
    if (tp2InView) take(plan.tp2);
  }
  const pad = (hi - lo) * 0.07 || hi * 0.01;
  lo -= pad;
  hi += pad;

  // ---- tata letak ----
  const W = 1600;
  const Lm = 20;
  const Rm = 190;
  const T = 96;
  const hP = 600;
  const gap = 26;
  const hS = 150;
  const B = 58;
  const H = T + hP + gap + hS + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const P = { x: Lm, y: T, w: cw, h: hP };
  const S = { x: Lm, y: T + hP + gap, w: cw, h: hS };
  g.fillStyle = C.panel;
  g.fillRect(P.x, P.y, P.w, P.h);
  g.fillRect(S.x, S.y, S.w, S.h);

  const slots = nb + (plan ? CFG.CHART_PLAN_SLOTS : 3);
  const slot = cw / slots;
  const Yp = (p) => P.y + ((hi - p) / (hi - lo)) * P.h;
  const Ys = (v) => S.y + ((100 - v) / 100) * S.h;
  const X = (i) => Lm + slot * (i - from) + slot / 2; // i = indeks di array candles
  const bodyW = Math.max(2, slot * 0.62);
  const right = P.x + P.w;
  const xLast = X(n - 1);

  // ---- grid harga + label sumbu ----
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagPrices = [last.c, ...(plan ? [plan.entry, plan.sl, plan.tp1, ...(tp2InView ? [plan.tp2] : [])] : []), ...(brk != null ? [brk] : [])];
  const tagYs = tagPrices.map(Yp);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(right, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), right + 10, yy);
  }

  // ---- grid vertikal + label waktu (menembus kedua panel) ----
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let k = Math.min(every, 3); k < nb - 2; k += every) {
    const i = from + k;
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, P.y);
    g.lineTo(xx, P.y + P.h);
    g.moveTo(xx, S.y);
    g.lineTo(xx, S.y + S.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(candles[i].t, tf), xx, S.y + S.h + 14);
  }

  // helper polyline: putus di nilai null
  const line = (series, y, color, width, dash) => {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = "round";
    if (dash) g.setLineDash(dash);
    g.beginPath();
    let pen = false;
    for (let i = from; i < n; i++) {
      const v = series[i];
      if (!isNum(v)) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(X(i), y(v));
      else {
        g.moveTo(X(i), y(v));
        pen = true;
      }
    }
    g.stroke();
    g.restore();
  };

  // clip panel harga supaya garis tidak keluar bingkai
  g.save();
  g.beginPath();
  g.rect(P.x, P.y, P.w, P.h);
  g.clip();

  // ---- Bollinger: pita terisi + garis atas/bawah ----
  {
    g.save();
    g.fillStyle = "rgba(167,139,250,0.08)";
    g.beginPath();
    let started = false;
    for (let i = from; i < n; i++) {
      if (!isNum(bb.upper[i])) continue;
      if (!started) {
        g.moveTo(X(i), Yp(bb.upper[i]));
        started = true;
      } else g.lineTo(X(i), Yp(bb.upper[i]));
    }
    for (let i = n - 1; i >= from; i--) if (isNum(bb.lower[i])) g.lineTo(X(i), Yp(bb.lower[i]));
    g.closePath();
    if (started) g.fill();
    g.restore();
    line(bb.upper, Yp, COL.bb, 1.5, [6, 5]);
    line(bb.lower, Yp, COL.bb, 1.5, [6, 5]);
  }

  // ---- zona rencana (di kanan candle terakhir) ----
  const zoneX0 = xLast + slot * 0.8;
  if (plan) {
    const rect = (pa, pb, fill) => {
      const y1 = Yp(pa);
      const y2 = Yp(pb);
      g.fillStyle = fill;
      g.fillRect(zoneX0, Math.min(y1, y2), right - zoneX0, Math.abs(y2 - y1));
    };
    rect(plan.entry, plan.sl, "rgba(239,83,80,0.14)"); // risiko
    rect(plan.entry, plan.tp1, "rgba(38,166,154,0.14)"); // reward s/d TP1
    rect(plan.tp1, tp2InView ? plan.tp2 : plan.tp1, "rgba(38,166,154,0.07)"); // TP1 -> TP2
  }

  // ---- garis level: breakout + rencana ----
  const hline = (price, color, dash, width = 1.7) => {
    const yy = Math.round(Yp(price)) + 0.5;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.globalAlpha = 0.95;
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(right, yy);
    g.stroke();
    g.restore();
  };
  if (brk != null) hline(brk, COL.wait, [3, 6], 1.4);
  if (plan) {
    hline(plan.entry, COL.entry, [10, 7], 1.5);
    hline(plan.sl, C.down, [10, 7]);
    hline(plan.tp1, C.up, [10, 7]);
    if (tp2InView) hline(plan.tp2, C.up, [4, 6], 1.5);
  }

  // ---- candle ----
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const color = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(from + k)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(xx, Yp(b.h));
    g.lineTo(xx, Yp(b.l));
    g.stroke();
    g.fillRect(xx - bodyW / 2, Yp(Math.max(b.o, b.c)), bodyW, Math.max(1.5, Math.abs(Yp(b.o) - Yp(b.c))));
  });

  // ---- ribbon SMA (di atas candle) ----
  line(s13, Yp, COL.sma13, 2.4);
  line(s8, Yp, COL.sma8, 2.1);
  line(s5, Yp, COL.sma5, 1.9);

  // ---- penanda skenario di candle terakhir ----
  if (plan) {
    const up = sc.status === "buy";
    const color = up ? C.up : C.down;
    const y = up ? Yp(last.l) + 24 : Yp(last.h) - 24;
    const d = up ? -1 : 1;
    g.save();
    g.fillStyle = color;
    g.strokeStyle = C.bg;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(xLast, y + d * 16);
    g.lineTo(xLast - 12, y - d * 4);
    g.lineTo(xLast + 12, y - d * 4);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  // harga terakhir
  {
    const yy = Math.round(Yp(last.c)) + 0.5;
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(P.x, yy);
    g.lineTo(right, yy);
    g.stroke();
    g.restore();
  }
  g.restore(); // akhir clip panel harga

  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(P.x + 0.5, P.y + 0.5, P.w, P.h);

  // ---- panel Stochastic ----
  g.save();
  g.beginPath();
  g.rect(S.x, S.y, S.w, S.h);
  g.clip();
  g.fillStyle = "rgba(148,163,184,0.06)";
  g.fillRect(S.x, Ys(CFG.STOCH_OB), S.w, Ys(CFG.STOCH_OS) - Ys(CFG.STOCH_OB));
  for (const lv of [CFG.STOCH_OB, 50, CFG.STOCH_OS]) {
    const yy = Math.round(Ys(lv)) + 0.5;
    g.strokeStyle = lv === 50 ? C.grid : "#2f3646";
    g.lineWidth = 1;
    g.setLineDash(lv === 50 ? [2, 6] : [8, 6]);
    g.beginPath();
    g.moveTo(S.x, yy);
    g.lineTo(right, yy);
    g.stroke();
  }
  g.setLineDash([]);
  line(st.d, Ys, COL.stochD, 2);
  line(st.k, Ys, COL.stochK, 2.2);
  g.restore();
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(S.x + 0.5, S.y + 0.5, S.w, S.h);
  g.font = `19px ${family}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = C.axis;
  for (const lv of [CFG.STOCH_OB, 50, CFG.STOCH_OS]) g.fillText(String(lv), right + 10, Ys(lv));
  // nilai %K / %D terakhir + nama panel
  {
    const k = st.k[n - 1];
    const d = st.d[n - 1];
    g.font = `bold 19px ${family}`;
    const head = `${lb.stoch}`;
    const kTxt = isNum(k) ? `%K ${k.toFixed(1)}` : "";
    const dTxt = isNum(d) ? `%D ${d.toFixed(1)}` : "";
    const boxW = g.measureText(head).width + (kTxt ? g.measureText(kTxt).width + 14 : 0) + (dTxt ? g.measureText(dTxt).width + 14 : 0) + 36;
    g.fillStyle = "rgba(11,14,20,0.85)"; // latar supaya teks terbaca di atas garis
    g.fillRect(S.x + 4, S.y + 4, boxW, 26);
    g.fillStyle = C.text;
    g.fillText(head, S.x + 10, S.y + 18);
    let x = S.x + 10 + g.measureText(head).width + 18;
    if (isNum(k)) {
      g.fillStyle = COL.stochK;
      const tk = `%K ${k.toFixed(1)}`;
      g.fillText(tk, x, S.y + 18);
      x += g.measureText(tk).width + 14;
    }
    if (isNum(d)) {
      g.fillStyle = COL.stochD;
      g.fillText(`%D ${d.toFixed(1)}`, x, S.y + 18);
    }
  }

  // ---- tag harga sumbu kanan (panel harga) ----
  {
    const tag = (txt, yy, color) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = color;
      g.fillRect(right + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, right + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [{ txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor }];
    if (brk != null) tags.push({ txt: `${lb.brk} ${fmtPrice(brk)}`, y: Yp(brk), color: COL.wait });
    if (plan) {
      tags.push({ txt: `${lb.entry} ${fmtPrice(plan.entry)}`, y: Yp(plan.entry), color: COL.entry });
      tags.push({ txt: `${lb.sl} ${fmtPrice(plan.sl)}`, y: Yp(plan.sl), color: C.down });
      tags.push({ txt: `${lb.tp1} ${fmtPrice(plan.tp1)}`, y: Yp(plan.tp1), color: C.up });
      if (tp2InView) tags.push({ txt: `${lb.tp2} ${fmtPrice(plan.tp2)}`, y: Yp(plan.tp2), color: C.up });
      else {
        // TP2 di luar skala: ditandai di tepi panel supaya levelnya tetap terbaca
        const edgeY = plan.tp2 > hi ? P.y + 14 : P.y + P.h - 14;
        tags.push({ txt: `${lb.tp2} ${fmtPrice(plan.tp2)}`, y: edgeY, color: C.up });
      }
    }
    tags.sort((a, b) => a.y - b.y);
    const gapY = 28;
    for (let i = 0; i < tags.length; i++) tags[i].ty = i === 0 ? tags[i].y : Math.max(tags[i].y, tags[i - 1].ty + gapY);
    // dorong balik dari tepi bawah supaya tag di dekat tepi tidak bertumpuk
    let maxY = P.y + P.h - 14;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i].ty > maxY) tags[i].ty = maxY;
      maxY = tags[i].ty - gapY;
    }
    for (const tg of tags) tag(tg.txt, tg.ty, tg.color);
  }

  // ---- judul, status, legenda, catatan bawah ----
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

  let lx = Lm;
  if (lb.status) {
    g.font = `bold 24px ${family}`;
    g.fillStyle = toneColor(lb.tone);
    g.fillText(lb.status, lx, 64);
    lx += g.measureText(lb.status).width + 36;
  }
  g.font = `bold 19px ${family}`;
  for (const [txt, color] of [
    ["SMA 5", COL.sma5],
    ["SMA 8", COL.sma8],
    ["SMA 13", COL.sma13],
    [`Bollinger ${CFG.BB_PERIOD},${CFG.BB_K}`, COL.bb],
  ]) {
    g.fillStyle = color;
    g.fillRect(lx, 59, 22, 6);
    g.fillText(txt, lx + 30, 64);
    lx += 30 + g.measureText(txt).width + 24;
  }

  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  g.textAlign = "left";
  g.fillText(lb.foot, Lm, H - 16);

  return canvas.toBuffer("image/png");
}

module.exports = { renderFarleyChart, DEFAULT_LABELS };
