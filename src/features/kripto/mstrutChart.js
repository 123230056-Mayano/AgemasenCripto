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
 *   - (opsional) skenario 24 jam dari mstrutPlan.js: kotak BSL mayor / pool SSL, BSL minor, SL, TP1 / TP2, Entry Zone
 *     dan panah jalur harga (relief bounce -> rejection -> target), area proyeksi di kanan candle terakhir
 * Semua posisi berasal dari engine, tidak ada hitungan level di sini.
 */

const { createCanvas } = require("@napi-rs/canvas");
const { MSTRUT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { C, fontFamily, fmtPrice: fmtPriceKit, niceStep, tickLabel, arrow, dot } = require("./chartKit");

const COL = { bsl: "#f59e0b", ssl: "#38bdf8", sweep: "#c084fc" };
const LABEL_COLOR = { HH: C.up, HL: C.up, LH: C.down, LL: C.down, EH: C.axis, EL: C.axis };
const MAX_EVENTS = 6;
const PLAN = { bsl: "#ef5350", ssl: "#4f8cff", tp: "#7bd88f", sl: "#ef5350", entry: "#2dd4bf", note: "#facc15", bounce: "#ffe08a" };

/** @returns {Buffer} PNG */
function renderMstrutChart({ candles, res, title, tf, digits = null, plan = null }) {
  const closed = candles.filter((c) => c.closed !== false);
  const live = candles.length && candles[candles.length - 1].closed === false ? candles[candles.length - 1] : null;
  const n = closed.length;
  if (n < 10 || !res) throw new Error("CANDLES_TOO_FEW");
  const fmtPrice = (p) => fmtPriceKit(p, digits);
  const family = fontFamily();
  const from = Math.max(0, n - CFG.CHART_BARS);
  const bars = closed.slice(from);
  const nbBars = bars.length + (live ? 1 : 0);
  const hasPlan = !!(plan && plan.dir && plan.dir !== "wait");
  const proj = hasPlan ? Math.max(14, Math.round(nbBars * 0.3)) : 0; // slot kosong di kanan untuk jalur proyeksi
  const nb = nbBars + proj;
  const last = closed[n - 1];

  // ---- apa yang digambar ----
  const liq = res.liquidity;
  const swings = res.swings.filter((s) => s.i >= from);
  const events = res.allEvents.filter((e) => e.k >= from).slice(-MAX_EVENTS);
  const sweeps = res.allSweeps.filter((s) => s.k >= from).slice(-3);
  const lines = []; // { i0, i1|null, price, color, dash, tag, label }
  const add = (it, color, tag) => it && lines.push({ i0: Math.max(it.firstI ?? it.i, from), i1: null, price: it.level, color, tag, label: it.kind === "eq" ? it.label : null });
  if (!hasPlan) {
    add(liq.nearestBSL, COL.bsl, "BSL");
    add(liq.nearestSSL, COL.ssl, "SSL");
  }
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
  if (hasPlan) {
    const must = [plan.sl, plan.tp1, plan.tp2, plan.entry.lo, plan.entry.hi];
    if (plan.pool) must.push(plan.pool.lo, plan.pool.hi);
    const optional = [plan.major && plan.major.hi, plan.major && plan.major.lo, plan.minor && plan.minor.level, plan.targetMinor && plan.targetMinor.level];
    for (const p of must) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    for (const p of optional) {
      if (p != null && p > lo - span0 * 0.6 && p < hi + span0 * 0.6) {
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
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
  const planTagYs = hasPlan ? [plan.sl, plan.tp1, plan.tp2].map((v) => Y(v)) : [];
  const tagYs = [...lines.filter((l) => l.tag).map((l) => Y(l.price)), ...planTagYs, Y(last.c)];
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

  // ---- skenario 24 jam: lapisan belakang (area proyeksi, kotak likuiditas, garis SL / TP / BSL / SSL minor) ----
  const rightEdgeP = pp.x + pp.w;
  const planLabels = []; // { text, y, color, side: "up"|"down" } digambar setelah candle
  const L0 = nbBars > 0 ? X(from + nbBars - 1) + slot / 2 : pp.x; // batas kiri area proyeksi
  if (hasPlan) {
    g.save();
    g.fillStyle = "rgba(79,140,255,0.045)";
    g.fillRect(L0, pp.y, rightEdgeP - L0, pp.h);
    g.strokeStyle = "rgba(139,147,161,0.35)";
    g.setLineDash([2, 6]);
    g.beginPath();
    g.moveTo(Math.round(L0) + 0.5, pp.y);
    g.lineTo(Math.round(L0) + 0.5, pp.y + pp.h);
    g.stroke();
    g.restore();

    const short = plan.dir === "short";
    const colOf = (side) => (side === "BSL" ? PLAN.bsl : PLAN.ssl);
    const hex2rgba = (h, a) => `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${a})`;
    const boxDraw = (b, side) => {
      if (!b) return;
      const y1 = Y(b.hi);
      const y2 = Y(b.lo);
      g.save();
      g.fillStyle = hex2rgba(colOf(side), 0.2);
      g.fillRect(pp.x, y1, pp.w, Math.max(3, y2 - y1));
      g.strokeStyle = colOf(side);
      g.lineWidth = 2;
      g.strokeRect(pp.x + 1, y1, pp.w - 2, Math.max(3, y2 - y1));
      g.restore();
    };
    const hline = (price, color, dash, w = 2.2) => {
      if (!inRange(price)) return;
      const yy = Math.round(Y(price)) + 0.5;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = w;
      if (dash) g.setLineDash(dash);
      g.beginPath();
      g.moveTo(pp.x, yy);
      g.lineTo(rightEdgeP, yy);
      g.stroke();
      g.restore();
    };
    // sisi stop: BSL (SHORT) / SSL (LONG); sisi target kebalikannya
    const stopSide = plan.sideStop;
    const tgtSide = plan.sideTarget;
    const outStop = short ? "up" : "down"; // arah "menjauhi harga" di sisi stop
    const outTgt = short ? "down" : "up";
    const inTgt = short ? "up" : "down"; // sisi yang menghadap harga di sisi target
    boxDraw(plan.major, stopSide);
    planLabels.push({ text: `MAJOR ${stopSide === "BSL" ? "BUY_SIDE" : "SELL_SIDE"} LIQUIDITY (${stopSide})`, y: Y(short ? plan.major.hi : plan.major.lo), color: colOf(stopSide), side: outStop });
    if (plan.minor) {
      hline(plan.minor.level, colOf(stopSide), [12, 8], 2);
      planLabels.push({ text: `MINOR ${stopSide}`, y: Y(plan.minor.level), color: colOf(stopSide), side: outStop });
    }
    hline(plan.sl, PLAN.sl, null, 2.4);
    planLabels.push({ text: "STOP LOSS (SL)", y: Y(plan.sl), color: PLAN.sl, side: outStop });
    if (plan.targetMinor) {
      hline(plan.targetMinor.level, colOf(tgtSide), [12, 8], 2);
      planLabels.push({ text: `${tgtSide} MINOR`, y: Y(plan.targetMinor.level), color: colOf(tgtSide), side: outTgt });
    }
    hline(plan.tp1, PLAN.tp, null, 2.4);
    planLabels.push({ text: "TAKE PROFIT 1 (TP 1)", y: Y(plan.tp1), color: PLAN.tp, side: inTgt });
    if (plan.pool) {
      boxDraw(plan.pool, tgtSide);
      planLabels.push({ text: `${tgtSide === "SSL" ? "SELL_SIDE" : "BUY_SIDE"} LIQUIDITY (${tgtSide}) POOL`, y: Y(short ? plan.pool.lo : plan.pool.hi), color: colOf(tgtSide), side: outTgt });
    }
    hline(plan.tp2, PLAN.tp, null, 2.4);
    planLabels.push({ text: "TAKE PROFIT 2 (TP 2)", y: Y(plan.tp2), color: PLAN.tp, side: inTgt });
    // Entry Zone: pita di area proyeksi
    g.save();
    g.fillStyle = hex2rgba(PLAN.entry, 0.16);
    const ey1 = Y(plan.entry.hi);
    const ey2 = Y(plan.entry.lo);
    g.fillRect(L0, ey1, rightEdgeP - L0, Math.max(3, ey2 - ey1));
    g.strokeStyle = hex2rgba(PLAN.entry, 0.75);
    g.lineWidth = 1.5;
    g.setLineDash([6, 5]);
    g.strokeRect(L0, ey1, rightEdgeP - L0, Math.max(3, ey2 - ey1));
    g.restore();
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

  // ---- skenario 24 jam: lapisan depan (label, jalur panah) ----
  if (hasPlan) {
    const short = plan.dir === "short";
    const txt = (text, x, y, color, { align = "left", base = "middle", size = 18 } = {}) => {
      g.save();
      g.font = `bold ${size}px ${family}`;
      g.textAlign = align;
      g.textBaseline = base;
      g.lineJoin = "round";
      g.lineWidth = 5;
      g.strokeStyle = "rgba(11,14,20,0.92)";
      g.strokeText(text, x, y);
      g.fillStyle = color;
      g.fillText(text, x, y);
      g.restore();
    };
    // label garis: ditaruh di tepi kiri, digeser kalau bertabrakan
    const ys = planLabels.map((lb) => ({ ...lb, ty: lb.side === "up" ? lb.y - 12 : lb.y + 12 })).sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < ys.length; i++) if (ys[i].ty - ys[i - 1].ty < 22) ys[i].ty = ys[i - 1].ty + 22;
    for (const lb of ys) txt(lb.text, pp.x + 12, Math.min(Math.max(lb.ty, pp.y + 12), pp.y + pp.h - 12), lb.color);

    // jalur harga: harga sekarang -> (relief bounce / pullback) -> rejection di Entry Zone -> TP2
    const lastIdx = from + nbBars - 1;
    const startPrice = live ? live.c : last.c;
    const p0 = { x: X(lastIdx), y: Y(startPrice) };
    const pending = plan.state === "pending";
    const apex = pending ? { x: X(lastIdx + Math.max(3, Math.round(proj * 0.4))), y: Y(plan.entry.mid) } : p0;
    const end = { x: X(lastIdx + Math.max(5, Math.round(proj * 0.9))), y: Y(plan.tp2) };
    dot(g, p0.x, p0.y);
    if (pending) arrow(g, p0.x, p0.y, apex.x, apex.y, { color: C.arrow, width: 5, head: 24 });
    arrow(g, apex.x, apex.y, end.x, end.y, { color: C.arrow, width: 5, head: 24 });
    // catatan di sekitar apex
    const outward = short ? -1 : 1; // SHORT: rejection di atas apex (y lebih kecil)
    const rejText = short ? ["Potential", "Rejection"] : ["Potential", "Support"];
    const ry = apex.y + outward * (short ? 46 : 46);
    txt(rejText[0], apex.x - 46, ry - 11, PLAN.note, { align: "center", size: 17 });
    txt(rejText[1], apex.x - 46, ry + 9, PLAN.note, { align: "center", size: 17 });
    arrow(g, apex.x - 30, ry + (short ? 24 : -24), apex.x - 3, apex.y + (short ? -3 : 3), { color: PLAN.note, width: 3, head: 13 });
    const ex = apex.x + 52;
    txt("ENTRY ZONE", ex, apex.y + (short ? -2 : 2), PLAN.entry, { size: 18 });
    arrow(g, ex - 6, apex.y + (short ? -2 : 2), apex.x + 9, apex.y + (short ? -2 : 2), { color: PLAN.entry, width: 3, head: 13 });
    if (pending) {
      const mx = (p0.x + apex.x) / 2;
      const my = (p0.y + apex.y) / 2;
      txt(short ? "Relief Bounce" : "Pullback / Dip", mx - 12, my + (short ? 24 : -24), PLAN.bounce, { align: "right", size: 17 });
    }
    // penanda horizon di sudut kanan atas area proyeksi
    txt(`Next ${plan.horizonHours}h`, (L0 + rightEdge) / 2, pp.y + 16, C.axis, { align: "center", size: 17 });
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
    const planTags = hasPlan
      ? [
          { txt: `SL ${fmtPrice(plan.sl)}`, y: Y(plan.sl), color: PLAN.sl },
          { txt: `TP1 ${fmtPrice(plan.tp1)}`, y: Y(plan.tp1), color: PLAN.tp },
          { txt: `TP2 ${fmtPrice(plan.tp2)}`, y: Y(plan.tp2), color: PLAN.tp },
        ]
      : [];
    const tags = [...lines.filter((l) => l.tag && inRange(l.price)).map((l) => ({ txt: `${l.tag} ${fmtPrice(l.price)}`, y: Y(l.price), color: l.color })), ...planTags, { txt: fmtPrice(last.c), y: Y(last.c), color: lastColor }].sort((a, b) => a.y - b.y);
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
