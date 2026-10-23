"use strict";

/**
 * features/kripto/positionLevels.js
 * ------------------------------------------------------------------
 * Peringatan berbasis HARGA untuk TP dan SL sebuah posisi (!posisi):
 *   - "near" : harga masuk zona dekat level (sisa jarak <= NEAR_FRAC x jarak entry->level), belum menyentuh
 *   - "hit"  : harga sekarang ATAU high/low candle closed sejak posisi dibuka sudah menyentuh level
 *
 * Logika murni (tanpa fetch/store/kirim pesan) supaya mudah diuji. Pesan dibuat oleh formatLevelAlert().
 * Bot hanya mengirim pesan; tidak menutup posisi.
 */

const { t } = require("../../i18n");
const { POSITION_CONFIG } = require("../../config/indicatorConfig");

const isNum = (v) => typeof v === "number" && isFinite(v);
const fmt = () => require("./market");

/**
 * @param {{
 *   dir: "long"|"short", entry: number, sl: number, sl0?: number, tp: number, price: number,
 *   candles?: {t:number,h:number,l:number}[], openedAt?: number, tpSince?: number, slSince?: number
 * }} input   candles = candle CLOSED; hanya yang dibuka (t) pada/sesudah max(openedAt, tpSince|slSince) yang dipakai.
 * @param {number} [nearFrac]
 * @returns {{
 *   tp: "hit"|"near"|null, sl: "hit"|"near"|null,
 *   tpVia: "price"|"candle"|null, slVia: "price"|"candle"|null,
 *   ambiguous: boolean, tpGap: number|null, slGap: number|null
 * }}
 */
function assessPriceLevels(input, nearFrac = POSITION_CONFIG.NEAR_FRAC) {
  const { dir, entry, sl, price, candles, openedAt } = input;
  const tp = input.tp;
  const out = { tp: null, sl: null, tpVia: null, slVia: null, ambiguous: false, tpGap: null, slGap: null };
  if (!isNum(price) || !isNum(entry) || (dir !== "long" && dir !== "short")) return out;
  const s = dir === "long" ? 1 : -1;

  // Hanya candle yang dibuka sesudah level itu berlaku: posisi dicatat (openedAt) atau TP/SL terakhir diubah (tpSince/slSince).
  // Candle yang sedang berjalan saat entri / saat SL digeser bisa punya ekstrem sebelum itu, jadi tidak dipakai.
  const after = (t0) => (candles || []).filter((c) => c && isNum(c.t) && (!isNum(t0) || c.t >= t0));
  const touched = (list, lvl, isTp) => {
    // LONG: TP disentuh oleh high, SL oleh low. SHORT sebaliknya.
    const useHigh = (dir === "long") === isTp;
    return list.some((c) => (useHigh ? isNum(c.h) && c.h >= lvl : isNum(c.l) && c.l <= lvl));
  };
  const tpCandles = after(Math.max(openedAt || 0, input.tpSince || 0));
  const slCandles = after(Math.max(openedAt || 0, input.slSince || 0));

  let tpHit = false;
  let slHit = false;
  if (isNum(tp)) {
    out.tpGap = (tp - price) * s;
    if (out.tpGap <= 0) { tpHit = true; out.tpVia = "price"; }
    else if (touched(tpCandles, tp, true)) { tpHit = true; out.tpVia = "candle"; }
  }
  if (isNum(sl)) {
    out.slGap = (price - sl) * s;
    if (out.slGap <= 0) { slHit = true; out.slVia = "price"; }
    else if (touched(slCandles, sl, false)) { slHit = true; out.slVia = "candle"; }
  }

  if (tpHit && slHit && out.tpVia === "candle" && out.slVia === "candle") out.ambiguous = true; // urutan sentuhan tidak diketahui
  if (tpHit) out.tp = "hit";
  if (slHit) out.sl = "hit";

  // Zona "mendekati": lebar = nearFrac x jarak entry->level. SL yang sudah digeser (trailing) memakai risiko awal (sl0).
  if (!tpHit && isNum(tp) && (tp - entry) * s > 0) {
    const zone = nearFrac * (tp - entry) * s;
    if (out.tpGap <= zone) out.tp = "near";
  }
  if (!slHit && isNum(sl)) {
    const risk = Math.max(Math.abs(entry - sl), isNum(input.sl0) ? Math.abs(entry - input.sl0) : 0);
    const zone = nearFrac * risk;
    if (risk > 0 && out.slGap <= zone) out.sl = "near";
  }
  return out;
}

/**
 * Teks pesan.
 * @param {string} lang
 * @param {"near.tp"|"near.sl"|"hit.tp"|"hit.sl"} kind
 * @param {{id:string, coin:string, tfLabel:string, dir:string, entry:number, sl:number, sl0?:number, tp:number, price:number, via?:string, ambiguous?:boolean}} p
 */
function formatLevelAlert(lang, kind, p) {
  const { fmtLevel } = fmt();
  const s = p.dir === "long" ? 1 : -1;
  const isTp = kind.endsWith("tp");
  const level = isTp ? p.tp : p.sl;
  const gap = Math.abs(level - p.price);
  const risk = Math.abs(p.entry - (isNum(p.sl0) ? p.sl0 : p.sl));
  const pnl = (level - p.entry) * s; // hit.tp > 0; hit.sl <= 0 bila SL belum digeser ke sisi profit
  const vars = {
    id: p.id,
    coin: p.coin,
    tf: p.tfLabel,
    dir: p.dir.toUpperCase(),
    entry: fmtLevel(p.entry),
    sl: fmtLevel(p.sl),
    tp: fmtLevel(p.tp),
    price: fmtLevel(p.price),
    level: fmtLevel(level),
    gap: fmtLevel(gap),
    pct: ((gap / p.price) * 100).toFixed(2),
    pnlPct: `${pnl >= 0 ? "+" : ""}${((pnl / p.entry) * 100).toFixed(2)}`,
    r: risk > 0 ? `${pnl >= 0 ? "+" : ""}${(pnl / risk).toFixed(2)}` : "-",
  };
  const lines = [t(lang, `position.alert.${kind}`, vars)];
  if (kind.startsWith("hit")) {
    if (p.via === "candle") lines.push(t(lang, "position.alert.viaCandle", vars));
    if (p.ambiguous) lines.push(t(lang, "position.alert.ambiguous"));
  }
  lines.push("", t(lang, "position.alert.foot"));
  return lines.join("\n");
}

module.exports = { assessPriceLevels, formatLevelAlert };
