"use strict";

/**
 * features/kripto/mstrutPlan.js
 * ------------------------------------------------------------------
 * Skenario N jam ke depan (default 24 jam) untuk !mstrut: arah, Entry Zone, Stop Loss, TP1 / TP2,
 * BSL / SSL (mayor, minor, pool) dan jalur harga yang digambar di chart.
 *
 * Logika MURNI (tanpa fetch / kirim pesan) dan sepenuhnya ATURAN TETAP dari hasil analyzeStructure
 * (mstrutCore.js). Bukan AI, bukan prediksi pasti: ini rencana berbasis struktur + likuiditas.
 *
 * ATURAN:
 *   Arah        : bias mstrut (Bullish -> LONG, Bearish -> SHORT). Bias Neutral memakai arah tembusan struktur
 *                 terakhir (smTrend) dengan keyakinan Rendah; tanpa itu -> WAIT.
 *   Leg         : impuls terakhir searah arah (SHORT: swing high -> swing low terakhir; LONG sebaliknya).
 *                 Ujung leg memakai ekstrem candle closed sejak swing itu (low/high baru ikut dihitung).
 *   Entry Zone  : retrace 50% - 79% dari leg (premium untuk SHORT, discount untuk LONG). Kalau harga sudah
 *                 berada di dalam / melewati batas bawah zona, zona dimulai dari harga sekarang.
 *   Stop Loss   : di luar likuiditas sisi stop terdekat di atas zona (SHORT) / di bawah zona (LONG) + 0,5 ATR;
 *                 kalau tidak ada, di luar swing asal leg.
 *   TP1 / TP2   : likuiditas sisi target yang masih utuh (SSL untuk SHORT, BSL untuk LONG), diambil sedikit
 *                 SEBELUM level (0,1 ATR) supaya order terisi. Kalau likuiditasnya kurang, diganti target
 *                 berbasis ATR (ditandai projected).
 *   Jangkauan   : jarak harga -> TP dibandingkan ATR x akar(jumlah candle horizon) sebagai perkiraan kasar
 *                 gerak wajar dalam horizon; TP yang lebih jauh dari itu ditandai "jauh".
 *
 * Trik: SHORT dihitung langsung. LONG dihitung dengan membalik harga (p -> -p) dan jenis swing, lalu hasilnya
 * dibalik lagi, jadi hanya ada satu implementasi untuk kedua arah.
 */

const TF_MINUTES = Object.freeze({ "1M": 1, "5M": 5, "15M": 15, "1H": 60, "4H": 240, "1D": 1440 });
const PLAN_CONFIG = Object.freeze({
  HORIZON_HOURS: 24,
  FIB_LO: 0.5,
  FIB_HI: 0.79,
  MIN_LEG_ATR: 0.8, // leg impuls minimal (x ATR), kalau lebih kecil -> WAIT
  SL_BUFFER_ATR: 0.5, // jarak SL di luar likuiditas
  TP_BUFFER_ATR: 0.1, // TP diambil sebelum level likuiditas
  MIN_TARGET_ATR: 0.35, // likuiditas target harus minimal sejauh ini dari harga
  BOX_ATR: 0.5, // tinggi kotak pool / mayor
  DEDUPE_ATR: 0.15, // dua level yang selisihnya <= ini dianggap sama
  FALLBACK_TP1_ATR: 1.0,
  FALLBACK_TP2_ATR: 2.0,
  EXT_TP2_ATR: 1.5, // TP2 projected kalau hanya ada satu likuiditas target
});

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Hapus level yang berdempetan (selisih <= tol); urutan input dipertahankan. */
function dedupe(levels, tol) {
  const out = [];
  for (const it of levels) if (!out.some((o) => Math.abs(o.level - it.level) <= tol)) out.push(it);
  return out;
}

/**
 * @param {object} res      hasil analyzeStructure
 * @param {object[]} candles candle (yang closed dipakai untuk ekstrem leg)
 * @param {{tf?:string, price?:number, horizonHours?:number}} [opts]
 * @returns {object|null}   null kalau data tidak cukup (tanpa ATR)
 */
function buildPlan(res, candles, opts = {}) {
  if (!res || !isNum(res.atr) || res.atr <= 0) return null;
  const C = PLAN_CONFIG;
  const A = res.atr;
  const price = isNum(opts.price) ? opts.price : res.price;
  const horizonHours = opts.horizonHours || C.HORIZON_HOURS;
  const mins = TF_MINUTES[opts.tf] || 60;
  const horizonBars = Math.max(1, Math.round((horizonHours * 60) / mins));
  const base = { atr: A, price, horizonHours, horizonBars };

  // ---- arah ----
  let dir = null;
  let grade = "C";
  let why = res.bias.why;
  if (res.bias.value === "bullish") {
    dir = "long";
    grade = res.bias.why === "mss.bull" ? "A" : "B";
  } else if (res.bias.value === "bearish") {
    dir = "short";
    grade = res.bias.why === "mss.bear" ? "A" : "B";
  } else if (res.smTrend === "up") dir = "long";
  else if (res.smTrend === "down") dir = "short";
  if (!dir) return { ...base, dir: "wait", reason: "nodir" };

  // ---- ruang "SHORT" (LONG dibalik) ----
  const m = dir === "short" ? 1 : -1;
  const f = (p) => m * p;
  const sideStop = dir === "short" ? "BSL" : "SSL";
  const sideTarget = dir === "short" ? "SSL" : "BSL";
  const P = f(price);
  const swings = res.swings.map((s) => ({ ...s, type: m === 1 ? s.type : s.type === "H" ? "L" : "H", price: f(s.price) }));

  let lastL = null;
  for (let i = swings.length - 1; i >= 0; i--) if (swings[i].type === "L") { lastL = swings[i]; break; }
  let origin = null;
  if (lastL) for (let i = swings.length - 1; i >= 0; i--) if (swings[i].type === "H" && swings[i].i < lastL.i) { origin = swings[i]; break; }
  if (!lastL || !origin) return { ...base, dir: "wait", reason: "nostruct" };

  // ekstrem leg: low (ruang SHORT) terendah sejak swing low terakhir, dari candle closed
  const closed = (candles || []).filter((c) => c.closed !== false);
  let legLow = lastL.price;
  for (let k = Math.max(0, lastL.i); k < closed.length; k++) {
    const lo = m === 1 ? closed[k].l : -closed[k].h;
    if (lo < legLow) legLow = lo;
  }
  const legHigh = origin.price;
  const leg = legHigh - legLow;
  if (!(leg >= C.MIN_LEG_ATR * A)) return { ...base, dir: "wait", reason: "smallLeg" };
  if (P >= legHigh) return { ...base, dir: "wait", reason: "invalid" };

  // ---- likuiditas yang masih utuh ----
  const liq = res.liquidity;
  const items = [...liq.bsl, ...liq.ssl, ...(liq.eqItems || [])].filter((x) => x.status === "intact").map((x) => ({ side: x.side, level: f(x.level), eq: x.kind === "eq" }));
  const tol = C.DEDUPE_ATR * A;
  const stops = dedupe(items.filter((x) => x.side === sideStop && x.level > P).sort((a, b) => a.level - b.level), tol);
  const targets = dedupe(items.filter((x) => x.side === sideTarget && x.level < P - C.MIN_TARGET_ATR * A).sort((a, b) => b.level - a.level), tol);

  // ---- Entry Zone ----
  let zLo = legLow + C.FIB_LO * leg;
  let zHi = legLow + C.FIB_HI * leg;
  let state = "pending";
  if (P >= zLo - 0.1 * A) {
    state = "inzone";
    zLo = P;
    zHi = Math.max(zHi, P + 0.3 * A);
  }
  const entry = (zLo + zHi) / 2;

  // ---- sisi stop: mayor, minor, SL ----
  // mayor = likuiditas sisi stop paling tinggi yang masih utuh (kotak di chart); minor = yang terdekat dengan harga
  const major = stops.length ? stops[stops.length - 1].level : legHigh;
  const anchorItem = stops.find((x) => x.level >= zHi + 0.3 * A);
  const anchor = Math.max(anchorItem ? anchorItem.level : Math.min(major, legHigh), zHi + 0.3 * A);
  const sl = anchor + C.SL_BUFFER_ATR * A;
  const minorItem = stops.find((x) => major - x.level >= 0.3 * A);
  const minor = minorItem ? minorItem.level : null;
  if (sl - entry <= 0) return { ...base, dir: "wait", reason: "invalid" };

  // ---- sisi target: TP1, TP2, pool ----
  let tp1;
  let tp2;
  let tp1Liq = null;
  let tp2Liq = null;
  if (targets[0]) {
    tp1Liq = targets[0].level;
    tp1 = tp1Liq + C.TP_BUFFER_ATR * A;
  } else tp1 = P - C.FALLBACK_TP1_ATR * A;
  if (targets[1]) {
    tp2Liq = targets[1].level;
    tp2 = tp2Liq + C.TP_BUFFER_ATR * A;
  } else tp2 = (tp1Liq != null ? tp1Liq - C.EXT_TP2_ATR * A : P - C.FALLBACK_TP2_ATR * A);
  const risk = sl - entry;
  const rr1 = (entry - tp1) / risk;
  const rr2 = (entry - tp2) / risk;

  const expected = A * Math.sqrt(horizonBars);
  const reach = { tp1: Math.abs(P - tp1) <= expected, tp2: Math.abs(P - tp2) <= expected, expected: expected };

  // ---- kembali ke harga asli ----
  const range = (a, b) => ({ lo: Math.min(f(a), f(b)), hi: Math.max(f(a), f(b)) });
  const box = (level, up, dn) => range(level - dn, level + up);
  return {
    ...base,
    dir,
    grade,
    why,
    state,
    sideStop,
    sideTarget,
    entry: { ...range(zLo, zHi), mid: f(entry) },
    sl: f(sl),
    tp1: f(tp1),
    tp2: f(tp2),
    tp1Projected: tp1Liq == null,
    tp2Projected: tp2Liq == null,
    rr1,
    rr2,
    risk,
    reach,
    leg: { from: f(legHigh), to: f(legLow) },
    major: { level: f(major), ...box(major, C.BOX_ATR * A, 0) },
    minor: minor != null ? { level: f(minor) } : null,
    targetMinor: tp1Liq != null ? { level: f(tp1Liq) } : null,
    pool: tp2Liq != null ? { level: f(tp2Liq), ...box(tp2Liq, 0.6 * A, 0.3 * A) } : null,
  };
}

module.exports = { buildPlan, PLAN_CONFIG, TF_MINUTES };
