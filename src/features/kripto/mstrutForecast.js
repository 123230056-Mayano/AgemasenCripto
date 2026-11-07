"use strict";

/**
 * features/kripto/mstrutForecast.js
 * ------------------------------------------------------------------
 * PERKIRAAN arah kasar untuk !mstrut saat skenario resmi (mstrutPlan.js) berstatus WAIT. Tujuannya: chart tidak
 * kosong, tapi tetap jujur: ini perkiraan dengan panah PUTUS-PUTUS, bukan skenario entry (tanpa Entry Zone / SL / TP).
 *
 * Logika MURNI (tanpa fetch / kirim pesan), aturan tetap, bukan AI:
 *   Arah    : sisi tertinggi probabilitas struktur (mstrutProb.js), jadi searah dengan blok probabilitas di laporan.
 *   Tujuan  : likuiditas sisi target yang masih UTUH terdekat (BSL di atas untuk LONG, SSL di bawah untuk SHORT),
 *             minimal MIN_TARGET_ATR x ATR dari harga, diambil sedikit sebelum level (TP_BUFFER_ATR).
 *             Tidak ada likuiditas utuh -> tujuan dari ATR (FALLBACK_TP2_ATR x ATR).
 *   Batas   : jarak tujuan dibandingkan gerak wajar horizon = ATR x akar(jumlah candle horizon). Kalau lebih jauh,
 *             panah berhenti di batas gerak wajar (clipped = true) supaya tidak menjanjikan target yang tidak realistis.
 *   Sideways: kalau Sideways adalah persen terbesar (atau Long = Short), perkiraannya RANGE: batas bawah = SSL utuh
 *             terdekat, batas atas = BSL utuh terdekat (dibatasi gerak wajar), bukan arah.
 *   Batal   : LONG batal kalau close di bawah swing low terakhir; SHORT batal kalau close di atas swing high terakhir.
 * Hasil null kalau skenario bukan WAIT, atau data (ATR / probabilitas) tidak ada.
 */

const { PLAN_CONFIG, TF_MINUTES } = require("./mstrutPlan");

const isNum = (v) => typeof v === "number" && isFinite(v);

/**
 * @param {object} res    hasil analyzeStructure
 * @param {object|null} prob hasil computeMstrutProb
 * @param {object|null} plan hasil buildPlan (perkiraan hanya dibuat bila plan.dir === "wait")
 * @param {{tf?:string, price?:number, horizonHours?:number}} [opts]
 * @returns {object|null}
 */
function buildForecast(res, prob, plan, opts = {}) {
  if (!res || !prob || !plan || plan.dir !== "wait") return null;
  if (!isNum(res.atr) || res.atr <= 0) return null;
  const C = PLAN_CONFIG;
  const A = res.atr;
  const price = isNum(opts.price) ? opts.price : res.price;
  const horizonHours = opts.horizonHours || plan.horizonHours || C.HORIZON_HOURS;
  const mins = TF_MINUTES[opts.tf] || 60;
  const horizonBars = Math.max(1, Math.round((horizonHours * 60) / mins));
  const expected = A * Math.sqrt(horizonBars); // gerak wajar kasar dalam horizon

  const liq = res.liquidity;
  const intact = [...liq.bsl, ...liq.ssl, ...(liq.eqItems || [])].filter((x) => x.status === "intact");
  const above = intact.filter((x) => x.side === "BSL" && x.level > price + C.MIN_TARGET_ATR * A).sort((a, b) => a.level - b.level);
  const below = intact.filter((x) => x.side === "SSL" && x.level < price - C.MIN_TARGET_ATR * A).sort((a, b) => b.level - a.level);

  const base = { waitReason: plan.reason, horizonHours, horizonBars, expected, price, atr: A, sideways: prob.sideways, pTop: prob.pTop, pLong: prob.long, pShort: prob.short };

  // ---- RANGE: sideways terbesar atau Long = Short ----
  if (prob.dominant === "sideways" || !prob.top) {
    const up = above[0] ? Math.min(above[0].level, price + expected) : price + 0.5 * expected;
    const dn = below[0] ? Math.max(below[0].level, price - expected) : price - 0.5 * expected;
    return { ...base, kind: "range", dir: null, lo: dn, hi: up, loSource: below[0] ? "liq" : "atr", hiSource: above[0] ? "liq" : "atr" };
  }

  // ---- ARAH ----
  const dir = prob.top;
  const longSide = dir === "long";
  const target = longSide ? above[0] : below[0];
  const m = longSide ? 1 : -1;
  let to;
  let source;
  let clipped = false;
  let targetLevel = null;
  if (target) {
    targetLevel = target.level;
    to = target.level - m * C.TP_BUFFER_ATR * A; // sebelum level supaya terisi
    source = "liq";
    if (Math.abs(to - price) > expected) {
      to = price + m * expected;
      clipped = true;
    }
  } else {
    to = price + m * Math.min(expected, C.FALLBACK_TP2_ATR * A);
    source = "atr";
  }
  const inv = longSide ? res.lastLow && res.lastLow.price : res.lastHigh && res.lastHigh.price;
  return {
    ...base,
    kind: "dir",
    dir,
    to,
    targetLevel,
    source,
    clipped,
    sideTarget: longSide ? "BSL" : "SSL",
    invalidation: isNum(inv) ? inv : null,
  };
}

module.exports = { buildForecast };
