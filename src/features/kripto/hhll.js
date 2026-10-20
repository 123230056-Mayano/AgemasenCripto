"use strict";

/**
 * features/kripto/hhll.js
 * ------------------------------------------------------------------
 * !hhll <koin> [tf]: market structure Higher High / Higher Low / Lower High / Lower Low.
 * Swing terakhir berlabel + status struktur (naik / turun / belum searah) + dua level kunci
 * (swing high & swing low terakhir) + chart zigzag berlabel. Data langsung dari Binance (market.js).
 * Logika swing ada di hhllCore.js (sama persis dengan yang dipakai alarm !alerthhll).
 */

const { createCanvas } = require("@napi-rs/canvas");
const { t } = require("../../i18n");
const { C, fontFamily, fmtPrice, niceStep, tickLabel } = require("./chartKit");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");
const { DAILY_TZ } = require("./divAlertCore");
const { computeStructure, CFG } = require("./hhllCore");

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)
const LABEL_COLOR = { HH: C.up, HL: C.up, LH: C.down, LL: C.down, EH: C.axis, EL: C.axis };
const LABEL_ICON = { HH: "🔺", HL: "🟢", LH: "🔻", LL: "🔴", EH: "➖", EL: "➖" };

/** "12 Okt 04:00" (id) / "12 Oct 04:00" (en); 1D tanpa jam. */
function fmtWhen(lang, ms, tf) {
  const loc = lang === "en" ? "en-GB" : "id-ID";
  const day = new Intl.DateTimeFormat(loc, { timeZone: DAILY_TZ, day: "numeric", month: "short" }).format(new Date(ms));
  if (tf === "1D") return day;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: DAILY_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${day} ${time}`;
}

// ---------- chart ----------
/** @returns {Buffer} PNG */
function renderHhllChart({ candles, coin, tf, st }) {
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();
  const n = candles.length;
  const last = candles[n - 1];
  const from = Math.max(0, n - CFG.CHART_BARS);
  const bars = candles.slice(from);
  const nb = bars.length;
  const swings = st.swings.filter((s) => s.i >= from);
  const keyLevels = [st.lastHigh && { price: st.lastHigh.price, label: "High", color: C.res }, st.lastLow && { price: st.lastLow.price, label: "Low", color: C.sup }].filter(Boolean);

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  for (const k of keyLevels) {
    lo = Math.min(lo, k.price);
    hi = Math.max(hi, k.price);
  }
  const pad = (hi - lo) * 0.09 || hi * 0.01; // ruang untuk label di atas/bawah pivot
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

  // grid + label harga
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagYs = [...keyLevels.map((k) => Yp(k.price)), Yp(last.c)];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pPrice.x, yy);
    g.lineTo(pPrice.x + pPrice.w, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), pPrice.x + pPrice.w + 10, yy);
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

  // garis swing high / low terakhir: dari pivotnya sampai tepi kanan (ini level yang dipantau alarm)
  for (const k of keyLevels) {
    const sw = k.label === "High" ? st.lastHigh : st.lastLow;
    const x0 = Math.max(pPrice.x, X(Math.max(sw.i, from)));
    const yy = Math.round(Yp(k.price)) + 0.5;
    g.save();
    g.strokeStyle = k.color;
    g.lineWidth = 1.8;
    g.setLineDash([10, 7]);
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(pPrice.x + pPrice.w, yy);
    g.stroke();
    g.restore();
  }

  // candle
  g.lineWidth = 1.4;
  bars.forEach((b, k) => {
    const i = from + k;
    const color = b.c >= b.o ? C.up : C.down;
    const xx = Math.round(X(i)) + 0.5;
    g.strokeStyle = color;
    g.fillStyle = color;
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
    g.lineTo(pPrice.x + pPrice.w, Math.round(yy) + 0.5);
    g.stroke();
    g.restore();
  }

  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pPrice.x + 0.5, pPrice.y + 0.5, pPrice.w, pPrice.h);

  // zigzag antar swing (garis biru)
  if (swings.length > 1) {
    g.save();
    g.strokeStyle = C.arrow;
    g.lineWidth = 2.6;
    g.lineJoin = "round";
    g.globalAlpha = 0.9;
    g.beginPath();
    swings.forEach((s, k) => (k === 0 ? g.moveTo(X(s.i), Yp(s.price)) : g.lineTo(X(s.i), Yp(s.price))));
    g.stroke();
    g.restore();
  }

  // titik pivot + label HH/HL/LH/LL (high di atas, low di bawah)
  g.textAlign = "center";
  for (const s of swings) {
    const x = X(s.i);
    const y = Yp(s.price);
    const color = (s.label && LABEL_COLOR[s.label]) || C.axis;
    g.save();
    g.fillStyle = C.bg;
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (s.label) {
      g.font = `bold 21px ${family}`;
      g.textBaseline = "middle";
      const w = g.measureText(s.label).width + 14;
      const cy = s.type === "H" ? y - 26 : y + 26;
      g.fillStyle = "rgba(11,14,20,0.88)";
      g.fillRect(x - w / 2, cy - 13, w, 26);
      g.lineWidth = 1.5;
      g.strokeRect(x - w / 2 + 0.5, cy - 12.5, w - 1, 25);
      g.fillStyle = color;
      g.fillText(s.label, x, cy + 1);
    }
    g.restore();
  }

  // tag sumbu kanan: swing high / low terakhir + harga terakhir (yang berdekatan digeser)
  {
    const tag = (txt, yy, color) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = color;
      g.fillRect(pPrice.x + pPrice.w + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, pPrice.x + pPrice.w + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [...keyLevels.map((k) => ({ txt: `${k.label} ${fmtPrice(k.price)}`, y: Yp(k.price), color: k.color })), { txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor }].sort((a, b) => a.y - b.y);
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
  const title = `${coin}/USDT  ${tf}  Higher High / Lower Low`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = candles[Math.max(0, n - 2)];
  const chgLast = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chgLast >= 0 ? "+" : ""}${chgLast.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  const trendTxt = st.trend === "up" ? "Uptrend (HH + HL)" : st.trend === "down" ? "Downtrend (LH + LL)" : "No clear direction";
  g.fillText(`Close candle only · swing = pivot ±${CFG.PIVOT_WIN} candles, min move ${CFG.MIN_SWING_PCT}% · ${trendTxt}`, Lm, 56);

  return canvas.toBuffer("image/png");
}

// ---------- teks ----------
function buildSwingLines(lang, st, tf) {
  const recent = st.swings.slice(-CFG.SHOW_SWINGS);
  return recent
    .map((s) => {
      const label = s.label || (s.type === "H" ? "high" : "low");
      const icon = (s.label && LABEL_ICON[s.label]) || "▫️";
      return t(lang, "hhll.swing.line", { icon, label, price: fmtLevel(s.price), when: fmtWhen(lang, s.t, tf) });
    })
    .join("\n");
}

function buildLevels(lang, st, price) {
  const rows = [];
  if (st.lastHigh) rows.push(t(lang, "hhll.levels.high", { price: fmtLevel(st.lastHigh.price), pct: fmtPct(pctFrom(price, st.lastHigh.price)) }));
  if (st.lastLow) rows.push(t(lang, "hhll.levels.low", { price: fmtLevel(st.lastLow.price), pct: fmtPct(pctFrom(price, st.lastLow.price)) }));
  return rows.join("\n");
}

const trendKey = (trend) => (trend === "up" ? "hhll.trend.up" : trend === "down" ? "hhll.trend.down" : "hhll.trend.range");

async function runHhll(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const st = candles.length >= CFG.MIN_CANDLES ? computeStructure(candles) : null;
  if (!st || !st.lastHigh || !st.lastLow || !st.trend) {
    await sock.sendMessage(jid, { text: t(lang, "hhll.none", { coin, tf: TF_LABEL[tf] }) }, { quoted: msg });
    return;
  }

  const caption = t(lang, "hhll.body", {
    coin,
    tf: TF_LABEL[tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    trend: t(lang, trendKey(st.trend), { h: st.lastHighLabel || "-", l: st.lastLowLabel || "-" }),
    swings: t(lang, "hhll.swings.title") + "\n" + buildSwingLines(lang, st, tf),
    levels: buildLevels(lang, st, tick.price),
    note: t(lang, `hhll.note.${st.trend}`, { high: fmtLevel(st.lastHigh.price), low: fmtLevel(st.lastLow.price) }),
    win: CFG.PIVOT_WIN,
    minPct: CFG.MIN_SWING_PCT,
  });

  // Kalau render gagal (mis. font/canvas bermasalah) tetap kirim versi teks supaya fitur tidak mati total.
  let png = null;
  try {
    png = renderHhllChart({ candles, coin, tf: TF_LABEL[tf], st });
  } catch (err) {
    console.log("[kripto] !hhll chart gagal, kirim teks saja:", err.message);
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

module.exports = { runHhll, renderHhllChart, buildSwingLines, buildLevels, fmtWhen };
