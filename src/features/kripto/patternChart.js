"use strict";

/**
 * features/kripto/patternChart.js
 * ------------------------------------------------------------------
 * Chart BUKTI untuk !pola (gaya sama dengan !hhll: tema gelap chartKit, candle, tag harga di sumbu kanan).
 * Per pola (maks MAX_SHOW): kotak sorotan di candle pembentuk, chip label + status di atas/bawah candle.
 * Untuk pola utama (yang terbaru): garis KONFIRMASI (putus-putus biru), garis BATAL (oranye), dan lingkaran putih
 * di close yang mengonfirmasi (kalau sudah terkonfirmasi). Pola netral: batas atas / bawah.
 * Hanya menggambar hasil scanCandlePatterns (tanpa lookahead); tidak menghitung pola sendiri.
 *
 * `createCanvasFn` bisa disuntik (untuk uji tanpa @napi-rs/canvas). Default: @napi-rs/canvas.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { t } = require("../../i18n");
const { C, fontFamily, fmtPrice, niceStep, tickLabel, chip } = require("./chartKit");
const { STATUS, DIR } = require("./patternCore");

const CONFIRM_COLOR = "#38bdf8";
const INVALID_COLOR = "#f59e0b";
const GRADE_KEY = { kuat: "hhllalert.grade.strong", sedang: "hhllalert.grade.medium", lemah: "hhllalert.grade.weak" };
const DIR_COLOR = { [DIR.BULL]: C.bull, [DIR.BEAR]: C.bear, [DIR.NEUTRAL]: "#9ca3af" };

const isNum = (v) => typeof v === "number" && isFinite(v);

function defaultCreateCanvas(w, h) {
  return require("@napi-rs/canvas").createCanvas(w, h);
}

/**
 * @param {object} a
 * @param {string} a.lang
 * @param {object[]} a.candles   candle closed, lama -> baru (sama dengan yang dipindai)
 * @param {string} a.coin
 * @param {string} a.tf          label TF (mis. "4H")
 * @param {object} a.res         hasil scanCandlePatterns (ok:true)
 * @param {number} [a.maxShow]   default PATTERN_CONFIG.MAX_SHOW
 * @param {Function} [a.createCanvasFn]
 * @returns {Buffer} PNG
 */
function renderPatternChart({ lang, candles, coin, tf, res, maxShow = CFG.MAX_SHOW, createCanvasFn = defaultCreateCanvas }) {
  if (!res || !res.ok) throw new Error("NO_PATTERN_RESULT");
  if (!candles || candles.length < 10) throw new Error("CANDLES_TOO_FEW");
  const family = fontFamily();
  const n = candles.length;
  const last = candles[n - 1];
  const shown = res.patterns.slice(0, maxShow);
  const primary = shown[0] || null;

  // jendela candle: CHART_BARS terakhir, diperlebar bila ada pola yang mulai lebih awal
  const earliest = shown.length ? Math.min(...shown.map((p) => p.startI)) : n - 1;
  const from = Math.max(0, Math.min(n - CFG.CHART_BARS, earliest - 6));
  const bars = candles.slice(from);
  const nb = bars.length;

  // level yang digambar (hanya pola utama)
  const levels = [];
  if (primary) {
    if (primary.dir === DIR.NEUTRAL) {
      levels.push({ price: primary.confirmLevel, label: t(lang, "pola.chart.upper"), color: CONFIRM_COLOR });
      levels.push({ price: primary.invalidLevel, label: t(lang, "pola.chart.lower"), color: INVALID_COLOR });
    } else {
      levels.push({ price: primary.confirmLevel, label: t(lang, "pola.chart.confirm"), color: CONFIRM_COLOR });
      levels.push({ price: primary.invalidLevel, label: t(lang, "pola.chart.invalid"), color: INVALID_COLOR });
    }
  }

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  const span0 = hi - lo || hi * 0.01;
  const drawn = [];
  for (const lv of levels) {
    if (!isNum(lv.price)) continue;
    if (lv.price < lo - span0 * 0.6 || lv.price > hi + span0 * 0.6) continue; // terlalu jauh: tidak digambar supaya candle tidak gepeng
    drawn.push(lv);
    lo = Math.min(lo, lv.price);
    hi = Math.max(hi, lv.price);
  }
  const pad = (hi - lo) * 0.1 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const W = 1600;
  const Lm = 20;
  const Rm = 190;
  const T = 96;
  const hP = 760;
  const B = 52;
  const H = T + hP + B;
  const cw = W - Lm - Rm;
  const canvas = createCanvasFn(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const pp = { x: Lm, y: T, w: cw, h: hP };
  g.fillStyle = C.panel;
  g.fillRect(pp.x, pp.y, pp.w, pp.h);

  const Yp = (p) => pp.y + ((hi - p) / (hi - lo)) * pp.h;
  const slot = cw / nb;
  const X = (i) => Lm + slot * (i - from) + slot / 2;
  const bodyW = Math.max(2, slot * 0.62);

  // grid + label harga
  g.font = `19px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineWidth = 1;
  const step = niceStep(hi - lo, 8);
  const tagYs = [...drawn.map((k) => Yp(k.price)), Yp(last.c)];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(Yp(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(pp.x, yy);
    g.lineTo(pp.x + pp.w, yy);
    g.stroke();
    if (tagYs.some((ty) => Math.abs(ty - yy) < 18)) continue;
    g.fillStyle = C.axis;
    g.fillText(fmtPrice(p), pp.x + pp.w + 10, yy);
  }

  // grid vertikal + label waktu
  g.textAlign = "center";
  g.textBaseline = "top";
  const every = Math.max(1, Math.round(nb / 7));
  for (let i = Math.min(every, 3); i < nb - 2; i += every) {
    const xx = Math.round(X(from + i)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(xx, pp.y);
    g.lineTo(xx, pp.y + pp.h);
    g.stroke();
    g.fillStyle = C.axis;
    g.fillText(tickLabel(bars[i].t, tf), xx, pp.y + pp.h + 14);
  }

  // kotak sorotan di candle pembentuk (di bawah candle supaya tidak menutupi)
  for (const p of shown) {
    const color = DIR_COLOR[p.dir] || C.axis;
    const x0 = X(p.startI) - slot * 0.5;
    const x1 = X(p.endI) + slot * 0.5;
    let top = Infinity;
    let bot = -Infinity;
    for (let i = p.startI; i <= p.endI; i++) {
      top = Math.min(top, Yp(candles[i].h));
      bot = Math.max(bot, Yp(candles[i].l));
    }
    g.save();
    g.globalAlpha = 0.14;
    g.fillStyle = color;
    g.fillRect(x0, top - 8, x1 - x0, bot - top + 16);
    g.globalAlpha = 0.9;
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.setLineDash([5, 4]);
    g.strokeRect(x0 + 0.5, top - 8 + 0.5, x1 - x0, bot - top + 16);
    g.restore();
  }

  // garis level pola utama: dari candle awal pola sampai tepi kanan
  for (const k of drawn) {
    const yy = Math.round(Yp(k.price)) + 0.5;
    const x0 = Math.max(pp.x, X(primary.startI) - slot * 0.5);
    g.save();
    g.strokeStyle = k.color;
    g.lineWidth = 1.9;
    g.setLineDash([10, 7]);
    g.globalAlpha = 0.95;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(pp.x + pp.w, yy);
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
    const yy = Math.round(Yp(last.c)) + 0.5;
    g.save();
    g.strokeStyle = last.c >= last.o ? C.up : C.down;
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(pp.x, yy);
    g.lineTo(pp.x + pp.w, yy);
    g.stroke();
    g.restore();
  }
  g.strokeStyle = "#2a303c";
  g.lineWidth = 1;
  g.strokeRect(pp.x + 0.5, pp.y + 0.5, pp.w, pp.h);

  // lingkaran putih di close yang mengonfirmasi pola utama
  if (primary && primary.status === STATUS.CONFIRMED && isNum(primary.confirmI) && primary.confirmI >= from) {
    const x = X(primary.confirmI);
    const y = Yp(candles[primary.confirmI].c);
    g.save();
    g.strokeStyle = "#ffffff";
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  }

  // chip label pola (bullish di bawah candle, bearish/netral di atas)
  const placed = [];
  for (const p of shown) {
    const color = DIR_COLOR[p.dir] || C.axis;
    const label = t(lang, `pola.kind.${p.variant || p.kind}`);
    const text = `${label} · ${t(lang, `pola.status.${p.status}`)}`;
    const cx = (X(p.startI) + X(p.endI)) / 2;
    let top = Infinity;
    let bot = -Infinity;
    for (let i = p.startI; i <= p.endI; i++) {
      top = Math.min(top, Yp(candles[i].h));
      bot = Math.max(bot, Yp(candles[i].l));
    }
    const cy = p.dir === DIR.BULL ? bot + 34 : top - 34;
    chip(g, family, text, cx, cy, pp, color, placed);
  }

  // tag sumbu kanan
  {
    const tag = (txt, yy, color) => {
      g.save();
      g.font = `bold 19px ${family}`;
      g.fillStyle = color;
      g.fillRect(pp.x + pp.w + 4, yy - 13, Rm - 8, 26);
      g.fillStyle = "#0b0e14";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(txt, pp.x + pp.w + 10, yy + 1);
      g.restore();
    };
    const lastColor = last.c >= last.o ? C.up : C.down;
    const tags = [...drawn.map((k) => ({ txt: `${k.label} ${fmtPrice(k.price)}`, y: Yp(k.price), color: k.color })), { txt: fmtPrice(last.c), y: Yp(last.c), color: lastColor }].sort((a, b) => a.y - b.y);
    const gapY = 28;
    for (let i = 1; i < tags.length; i++) tags[i].ty = Math.max(tags[i].y, (tags[i - 1].ty ?? tags[i - 1].y) + gapY);
    if (tags.length) tags[0].ty = tags[0].y;
    for (const tg of tags) tag(tg.txt, Math.min(tg.ty ?? tg.y, pp.y + pp.h - 14), tg.color);
  }

  // judul + subjudul (status pola utama) + catatan jujur
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `bold 28px ${family}`;
  g.fillStyle = C.title;
  const title = `${coin}/USDT  ${tf}  ${t(lang, "pola.chart.title")}`;
  g.fillText(title, Lm, 26);
  const titleW = g.measureText(title).width;
  const prev = candles[Math.max(0, n - 2)];
  const chg = ((last.c - prev.c) / prev.c) * 100;
  g.font = `22px ${family}`;
  g.fillStyle = last.c >= prev.c ? C.up : C.down;
  g.fillText(`${fmtPrice(last.c)}  (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)`, Lm + titleW + 20, 27);
  g.font = `19px ${family}`;
  g.fillStyle = C.axis;
  const sub = primary
    ? `${t(lang, `pola.status.${primary.status}`)} (${t(lang, GRADE_KEY[primary.grade])})  |  ${t(lang, `pola.kind.${primary.variant || primary.kind}`)}`
    : t(lang, "pola.chart.none", { n: CFG.RECENT_BARS });
  g.fillText(sub, Lm, 58);
  g.fillStyle = "#6b7280";
  g.font = `17px ${family}`;
  g.fillText(t(lang, "pola.chart.note"), Lm, 82);

  return canvas.toBuffer("image/png");
}

module.exports = { renderPatternChart };
