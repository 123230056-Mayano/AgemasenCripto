"use strict";

/**
 * features/kripto/amd.js
 * ------------------------------------------------------------------
 * !amd <koin> [tf]: kondisi Accumulation - Manipulation - Distribution (AMD / "Power of 3") saat ini.
 * Fase yang sedang berjalan (akumulasi / manipulasi / distribusi / sweep gagal), range akumulasinya, level
 * konfirmasi, plus chart berlabel. Bullish dan bearish. Data langsung dari Binance (market.js).
 * Aturan deteksi ada di amdCore.js (sama persis dengan yang dipakai alarm !alertamd); R1/S1 di dalam range
 * diambil dari snr.js.
 */

const { createCanvas } = require("@napi-rs/canvas");
const { t } = require("../../i18n");
const { C, fontFamily, fmtPrice, niceStep, tickLabel } = require("./chartKit");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");
const { computeSnr } = require("./snr");
const { fmtWhen } = require("./hhll");
const { detectAmd, CFG } = require("./amdCore");

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)
const AMBER = "#f5a524";

const phaseColor = (st) => (st.phase === "accumulation" ? C.arrow : st.phase === "manipulation" || st.phase === "failed" ? AMBER : st.dir === "bullish" ? C.up : C.down);

// ---------- chart ----------
/** @returns {Buffer} PNG */
function renderAmdChart({ candles, coin, tf, st }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();
  const n = candles.length;
  const last = candles[n - 1];
  // Tampilan difokuskan ke pola: mulai sedikit sebelum range, tapi paling banyak CHART_BARS dan paling sedikit 40 candle.
  const rg0 = st.range;
  let from = rg0 ? Math.max(0, rg0.startI - 15) : Math.max(0, n - CFG.CHART_BARS);
  from = Math.max(from, n - CFG.CHART_BARS);
  from = Math.max(0, Math.min(from, n - 40));
  const bars = candles.slice(from);
  const nb = bars.length;
  const rg = st.range;
  const sw = st.sweep;
  const color = phaseColor(st);

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  const extra = [rg?.hi, rg?.lo, sw?.extreme, st.level?.price].filter((v) => Number.isFinite(v));
  for (const v of extra) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = (hi - lo) * 0.09 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const W = 1600;
  const Lm = 20;
  const Rm = 190;
  const T = 74;
  const hP = 760;
  const B = 52;
  const H = T + hP + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const pPrice = { x: Lm, y: T, w: cw, h: hP };
  g.fillStyle = C.panel;
  g.fillRect(pPrice.x, pPrice.y, pPrice.w, pPrice.h);

  const Yp = (p) => pPrice.y + ((hi - p) / (hi - lo)) * pPrice.h;
  const slot = cw / nb;
  const X = (i) => Lm + slot * (i - from) + slot / 2;
  const bodyW = Math.max(2, slot * 0.62);
  const right = pPrice.x + pPrice.w;

  // grid + label harga
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagYs = [...extra.map((v) => Yp(v)), Yp(last.c)];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pPrice.x, yy);
    g.lineTo(right, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), right + 10, yy);
  }

  // grid vertikal + label waktu
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < nb - 2; i += every) {
    const xx = Math.round(X(from + i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, pPrice.y);
    g.lineTo(xx, pPrice.y + pPrice.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, pPrice.y + pPrice.h + 14);
  }

  // kotak range akumulasi: dari awal range sampai tepi kanan (akumulasi berjalan) atau sampai 2 candle setelah sweep
  if (rg) {
    const x0 = Math.max(pPrice.x, X(Math.max(rg.startI, from)) - slot / 2);
    const x1 = st.phase === "accumulation" ? right : Math.min(right, X(Math.min(n - 1, (sw ? sw.i : rg.endI) + 2)) + slot / 2);
    const y0 = Yp(rg.hi);
    const y1 = Yp(rg.lo);
    g.save();
    g.fillStyle = "rgba(79,140,255,0.10)";
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = C.arrow;
    g.lineWidth = 1.6;
    g.setLineDash([10, 7]);
    g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    g.restore();
    g.font = `bold 20px ${family}`;
    g.textAlign = "left";
    g.textBaseline = "bottom";
    g.fillStyle = C.arrow;
    g.fillText("A  Range", x0 + 4, Math.max(pPrice.y + 24, y0 - 8)); // di atas kotak supaya tidak tertutup candle
  }

  // level konfirmasi (break struktur): dari candle sweep sampai tepi kanan
  if (sw && st.level) {
    const x0 = Math.max(pPrice.x, X(Math.max(sw.i, from)));
    const yy = Math.round(Yp(st.level.price)) + 0.5;
    g.save();
    g.strokeStyle = st.phase === "distribution" ? color : AMBER;
    g.lineWidth = 1.8;
    g.setLineDash([4, 6]);
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(right, yy);
    g.stroke();
    g.restore();
  }

  // candle
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const i = from + k;
    const c = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = c;
    g.fillStyle = c;
    g.beginPath();
    g.moveTo(xx, Yp(b.h));
    g.lineTo(xx, Yp(b.l));
    g.stroke();
    g.fillRect(xx - bodyW / 2, Yp(Math.max(b.o, b.c)), bodyW, Math.max(1.5, Math.abs(Yp(b.o) - Yp(b.c))));
  });

  // harga terakhir (garis putus)
  {
    const yy = Yp(last.c);
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(pPrice.x, Math.round(yy) + 0.5);
    g.lineTo(right, Math.round(yy) + 0.5);
    g.stroke();
    g.restore();
  }

  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pPrice.x + 0.5, pPrice.y + 0.5, pPrice.w, pPrice.h);

  // penanda fase: M di sweep (wick), D di candle break struktur
  const marker = (i, price, txt, col, above) => {
    if (i < from) return;
    const x = X(i);
    const y = Yp(price);
    const cy = above ? y - 30 : y + 30;
    g.save();
    g.fillStyle = C.bg;
    g.strokeStyle = col;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.font = `bold 22px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const w = g.measureText(txt).width + 16;
    g.fillStyle = "rgba(11,14,20,0.9)";
    g.fillRect(x - w / 2, cy - 14, w, 28);
    g.lineWidth = 1.5;
    g.strokeRect(x - w / 2 + 0.5, cy - 13.5, w - 1, 27);
    g.fillStyle = col;
    g.fillText(txt, x, cy + 1);
    g.restore();
  };
  if (sw) {
    marker(sw.i, sw.extreme, "M", AMBER, sw.dir === "bearish");
    if (st.confirmAt != null) {
      const k = candles[st.confirmAt];
      marker(st.confirmAt, sw.dir === "bullish" ? k.h : k.l, "D", color, sw.dir === "bullish");
    }
  }

  // tag sumbu kanan: tepi range, level konfirmasi, harga terakhir (yang berdekatan digeser)
  {
    const tag = (txt, yy, col) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = col;
      g.fillRect(right + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, right + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [
      rg && { txt: `Hi ${fmtPrice(rg.hi)}`, y: Yp(rg.hi), color: C.arrow },
      rg && { txt: `Lo ${fmtPrice(rg.lo)}`, y: Yp(rg.lo), color: C.arrow },
      sw && st.level && { txt: `MSS ${fmtPrice(st.level.price)}`, y: Yp(st.level.price), color: AMBER },
      { txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor },
    ]
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    const gapY = 28;
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + gapY);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, pPrice.y + pPrice.h - 14), tg.color);
  }

  // judul + legenda
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}  Accumulation / Manipulation / Distribution`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = candles[Math.max(0, n - 2)];
  const chgLast = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chgLast >= 0 ? "+" : ""}${chgLast.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  const phaseTxt = { accumulation: "A: accumulation", manipulation: `M: manipulation (${st.dir})`, distribution: `D: distribution (${st.dir})`, failed: "M failed (real breakout)" }[st.phase] || "";
  g.fillText(`Close candle only · A = range, M = sweep, D = structure break · ${phaseTxt}`, Lm, 56);

  return canvas.toBuffer("image/png");
}

// ---------- teks ----------
const pctTxt = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");

function rangeVars(st) {
  const r = st.range;
  return {
    lo: fmtLevel(r.lo),
    hi: fmtLevel(r.hi),
    bars: r.bars,
    widthPct: pctTxt(r.widthPct),
    widthAtr: pctTxt(r.widthAtr),
    top: r.topTouches,
    bot: r.botTouches,
  };
}

/** Tambahan baris: volume range dan R1/S1 di dalam range (kalau ada). */
function extraLines(lang, st) {
  const out = [];
  if (Number.isFinite(st.volRatio)) {
    const volKey = st.volRatio < 0.9 ? "amd.vol.low" : st.volRatio > 1.1 ? "amd.vol.high" : "amd.vol.mid";
    out.push(t(lang, volKey, { x: st.volRatio.toFixed(1) }));
  }
  if (st.lock && (st.lock.resistance || st.lock.support)) {
    out.push(
      t(lang, "amd.lock", {
        r: st.lock.resistance ? `${fmtLevel(st.lock.resistance.price)} (${st.lock.resistance.touches}x)` : "-",
        s: st.lock.support ? `${fmtLevel(st.lock.support.price)} (${st.lock.support.touches}x)` : "-",
      }),
    );
  }
  return out.join("\n");
}

function buildPhaseText(lang, st, candles, tf, price) {
  const dirKey = st.dir === "bullish" ? "bull" : "bear";
  const base = rangeVars(st);
  const ex = extraLines(lang, st);
  if (st.phase === "accumulation") {
    const pos = Math.round(((price - st.range.lo) / st.range.width) * 100);
    return t(lang, "amd.phase.accumulation", { ...base, pos: Math.max(0, Math.min(100, pos)), extra: ex ? "\n" + ex : "" });
  }
  const sw = st.sweep;
  const when = fmtWhen(lang, sw.t, tf);
  const vars = {
    ...base,
    extreme: fmtLevel(sw.extreme),
    edge: fmtLevel(sw.dir === "bullish" ? st.range.lo : st.range.hi),
    when,
    ago: st.barsSince,
    close: fmtLevel(sw.close),
    price: fmtUsd(price),
    extra: ex ? "\n" + ex : "",
  };
  if (st.phase === "manipulation") {
    const left = Math.max(0, CFG.CONFIRM_BARS - st.barsSince);
    return t(lang, `amd.phase.manipulation.${dirKey}`, { ...vars, level: fmtLevel(st.level.price), kind: t(lang, `amd.level.${st.level.kind}`), left });
  }
  if (st.phase === "distribution") {
    const k = candles[st.confirmAt];
    return t(lang, `amd.phase.distribution.${dirKey}`, {
      ...vars,
      level: fmtLevel(st.level.price),
      kind: t(lang, `amd.level.${st.level.kind}`),
      confirmWhen: fmtWhen(lang, k.t, tf),
      pct: fmtPct(pctFrom(st.level.price, price)),
    });
  }
  // failed
  return t(lang, `amd.phase.failed.${dirKey}`, vars);
}

async function runAmd(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const st = candles.length >= CFG.MIN_CANDLES ? detectAmd(candles, { computeSnr }) : null;
  if (!st || st.phase === "none") {
    await sock.sendMessage(jid, { text: t(lang, "amd.none", { coin, tf: TF_LABEL[tf] }) }, { quoted: msg });
    return;
  }

  const caption = t(lang, "amd.body", {
    coin,
    tf: TF_LABEL[tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    phase: buildPhaseText(lang, st, candles, tf, tick.price),
    minBars: CFG.RANGE_MIN_BARS,
    maxAtr: CFG.RANGE_MAX_ATR,
    confirmBars: CFG.CONFIRM_BARS,
  });

  // Kalau render gagal (mis. font/canvas bermasalah) tetap kirim versi teks supaya fitur tidak mati total.
  let png = null;
  try {
    png = renderAmdChart({ candles, coin, tf: TF_LABEL[tf], st });
  } catch (err) {
    console.log("[kripto] !amd chart gagal, kirim teks saja:", err.message);
  }

  if (!png) {
    await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  } else if (caption.length <= CAPTION_MAX) {
    await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  } else {
    // Batas caption WhatsApp 1024 karakter -> kalau lebih, gambar dan teks dikirim terpisah.
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
}

module.exports = { runAmd, renderAmdChart, buildPhaseText };
