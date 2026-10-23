"use strict";

/**
 * features/kripto/suddenMoveText.js
 * ------------------------------------------------------------------
 * Teks (i18n id/en) untuk Sudden Move Guard: alasan status entri dan pesan peringatan posisi.
 * Terpisah dari suddenMove.js supaya logika murni tidak bergantung pada i18n.
 * Pesan hanya informasi; bot tidak menutup posisi.
 */

const { t } = require("../../i18n");

const isNum = (v) => typeof v === "number" && isFinite(v);
const fmtX = (v) => (isNum(v) ? v.toFixed(1) : "-");
const fmtRR = (v) => (isNum(v) ? v.toFixed(2).replace(/\.?0+$/, "") : "-");
const fmt = () => require("./market");

/** Satu kalimat alasan dari {code, vars} hasil assessEntry / assessPosition. */
function reasonText(lang, r) {
  const { fmtLevel } = fmt();
  const v = r.vars || {};
  const lv = (x) => (isNum(x) ? fmtLevel(x) : "-");
  const vars = {
    x: fmtX(v.x),
    max: isNum(v.max) ? v.max : "-",
    min: isNum(v.min) ? v.min : "-",
    rr: fmtRR(v.rr),
    lvl: lv(v.lvl),
    ext: lv(v.ext),
    sl: lv(v.sl),
    close: lv(v.close),
    wick: isNum(v.wick) ? Math.round(v.wick) : "-",
    mult: fmtRR(v.mult),
    vol: fmtX(v.vol),
    volTxt: isNum(v.vol) ? t(lang, "sudden.volTxt", { x: fmtX(v.vol) }) : "",
  };
  return t(lang, `sudden.reason.${r.code}`, vars);
}

const LEVEL_ICON = { INFO: "ℹ️", WASPADA: "⚠", CUT: "🛑" };

/**
 * Pesan peringatan posisi.
 * @param {string} lang
 * @param {{coin:string, tf:string, dir:"long"|"short", entry:number, sl:number, price:number, tfLabel?:string}} pos
 * @param {ReturnType<typeof import("./suddenMove").assessPosition>} a
 * @param {{candlesSince?:number}} [extra]
 * @returns {string|null} null bila tidak ada yang perlu dikirim (INFO tanpa time stop / saran break-even)
 */
function formatPositionAlert(lang, pos, a, extra = {}) {
  const { fmtLevel } = fmt();
  const tf = pos.tfLabel || pos.tf;
  const notable = a.level !== "INFO" || a.timeStop || a.moveToBreakEven;
  if (!notable) return null;

  const lines = [
    t(lang, "sudden.pos.head", { icon: LEVEL_ICON[a.level], level: a.level, coin: pos.coin, tf, dir: pos.dir.toUpperCase() }),
    t(lang, "sudden.pos.levels", { entry: fmtLevel(pos.entry), sl: fmtLevel(pos.sl), price: fmtLevel(pos.price) }),
  ];
  for (const r of a.reasons) lines.push(`↳ ${reasonText(lang, r)}`);
  if (a.level === "CUT") lines.push(`➡ ${t(lang, "sudden.pos.advice.CUT")}`);
  else if (a.level === "WASPADA") lines.push(`➡ ${t(lang, "sudden.pos.advice.WASPADA")}`);
  if (a.moveToBreakEven && a.level !== "CUT") {
    lines.push(`➡ ${t(lang, "sudden.pos.advice.breakeven", { r: isNum(a.profitR) ? a.profitR.toFixed(1) : "-" })}`);
  }
  if (a.timeStop) lines.push(`➡ ${t(lang, "sudden.pos.advice.timeStop", { n: extra.candlesSince ?? "-", tf })}`);
  lines.push("", t(lang, "sudden.pos.foot"));
  return lines.join("\n");
}

module.exports = { reasonText, formatPositionAlert, fmtX, fmtRR };
