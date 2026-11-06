"use strict";

/**
 * features/kripto/mstrutCore.js
 * ------------------------------------------------------------------
 * Engine MARKET STRUCTURE untuk !mstrut. Logika MURNI: tanpa fetch, tanpa kirim pesan, jadi bisa diuji unit
 * (src/test/mstrut.test.js). Semua keputusan dibuat oleh aturan algoritmik di bawah ini, bukan oleh AI.
 *
 * Input: candle urut lama -> baru { t, o, h, l, c, closed? }. Candle terakhir boleh BELUM closed (closed === false):
 * ia tidak pernah dipakai untuk menentukan swing / BOS / CHoCH / MSS / sweep, hanya dilaporkan terpisah sebagai
 * status "Unconfirmed" (hasil sementara yang bisa berubah sampai candle itu tutup).
 *
 * ATURAN (semua berbasis candle CLOSED):
 *   Swing      : pivot high/low +-PIVOT_WIN candle, gerak minimal MIN_SWING_PCT (hhllCore.js, sama dengan !hhll,
 *                tanpa filter sideways). Pivot baru sah setelah PIVOT_WIN candle di kanannya closed.
 *   Label      : HH / LH / EH untuk swing high, HL / LL / EL untuk swing low (terhadap swing sejenis sebelumnya).
 *   Trend      : swing high terakhir HH + swing low terakhir HL = Bullish; LH + LL = Bearish; selain itu Sideways.
 *   BSL / SSL  : swing high / swing low = tempat stop order menumpuk (Buy-Side / Sell-Side Liquidity).
 *                Status per level: intact (belum disentuh), swept (WICK menembus lalu close kembali di sisi semula),
 *                broken (CLOSE melewati level).
 *   EQH / EQL  : >= 2 swing sejenis yang selisihnya <= toleransi (max EQ_MIN_PCT% harga, EQ_ATR_MULT x ATR).
 *   Sweep      : candle closed yang high/low-nya (wick) menembus level likuiditas yang masih intact, tetapi
 *                CLOSE-nya kembali di sisi semula. Close yang melewati level = penembusan (BOS/CHoCH), bukan sweep.
 *   BOS        : close pertama melewati swing high/low terakhir SEARAH tren yang berlaku (kelanjutan).
 *   CHoCH      : close pertama melewati swing high/low terakhir BERLAWANAN dengan tren yang berlaku (tren berbalik).
 *   MSS        : CHoCH yang (1) didahului sweep likuiditas sisi yang sesuai setelah swing yang ditembus terbentuk
 *                (<= MSS_SWEEP_MAX_BARS candle sebelumnya) dan (2) ditembus oleh candle displacement
 *                (badan searah >= DISPLACEMENT_ATR x ATR). CHoCH tanpa kedua syarat itu tetap CHoCH, bukan MSS.
 *   Tanpa lookahead: tiap candle hanya memakai swing yang sudah sah pada saat itu, jadi hasil pada candle ke-k
 *   tidak berubah ketika candle sesudahnya masuk.
 */

const { MSTRUT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { findPivots, buildSwings, labelSwings, trendOf } = require("./hhllCore");
const { atr: atrSeries } = require("./indicators");

const swingKey = (s) => `${s.type}${s.i}`;
const lastOfType = (swings, type) => {
  for (let i = swings.length - 1; i >= 0; i--) if (swings[i].type === type) return swings[i];
  return null;
};

/** ATR di candle k; kalau belum ada (data awal) pakai nilai ATR pertama yang tersedia. null kalau tidak ada sama sekali. */
function atrAt(atrArr, k) {
  if (atrArr[k] != null) return atrArr[k];
  for (let i = 0; i < atrArr.length; i++) if (atrArr[i] != null) return atrArr[i];
  return null;
}

/**
 * Jalan maju candle demi candle: deteksi BOS / CHoCH dari close yang melewati swing terakhir.
 * @returns {{events: object[], trend: "up"|"down"|null}}
 */
function walkStructure(closed, pivots, atrArr, cfg) {
  const win = cfg.PIVOT_WIN;
  const known = [];
  const broken = new Set();
  const events = [];
  let swings = [];
  let trend = null;
  let pi = 0;
  for (let k = 0; k < closed.length; k++) {
    let changed = false;
    while (pi < pivots.length && pivots[pi].i + win <= k) {
      known.push(pivots[pi]);
      pi++;
      changed = true;
    }
    if (changed) swings = buildSwings(known, cfg.MIN_SWING_PCT);
    const H = lastOfType(swings, "H");
    const L = lastOfType(swings, "L");
    const b = closed[k];
    let dir = null;
    let ref = null;
    if (H && !broken.has(swingKey(H)) && b.c > H.price) {
      dir = "bull";
      ref = H;
    } else if (L && !broken.has(swingKey(L)) && b.c < L.price) {
      dir = "bear";
      ref = L;
    }
    if (!dir) continue;
    const initial = trend === null;
    const against = (dir === "bull" && trend === "down") || (dir === "bear" && trend === "up");
    const a = atrAt(atrArr, k);
    const body = dir === "bull" ? b.c - b.o : b.o - b.c; // badan searah penembusan (negatif = candle berlawanan)
    events.push({
      kind: against ? "CHoCH" : "BOS",
      dir,
      initial,
      k,
      t: b.t,
      close: b.c,
      level: ref.price,
      refI: ref.i,
      refT: ref.t,
      bodyAtr: a ? body / a : null,
      mss: null,
    });
    broken.add(swingKey(ref));
    trend = dir === "bull" ? "up" : "down";
  }
  return { events, trend };
}

/**
 * Status satu level likuiditas: pertama kali candle closed setelah `from` menembus level dengan wick.
 * k / kt = index / waktu candle penembus (null kalau intact).
 * @param {"BSL"|"SSL"} side
 */
function levelStatus(closed, from, price, side) {
  for (let j = from; j < closed.length; j++) {
    const b = closed[j];
    const pierced = side === "BSL" ? b.h > price : b.l < price;
    if (!pierced) continue;
    const closedBeyond = side === "BSL" ? b.c > price : b.c < price;
    return { status: closedBeyond ? "broken" : "swept", k: j, kt: b.t, wick: side === "BSL" ? b.h : b.l, close: b.c };
  }
  return { status: "intact", k: null, kt: null, wick: null, close: null };
}

/** Kelompok EQH / EQL: >= 2 swing sejenis dalam toleransi. level = ujung paling ekstrem kelompok. */
function eqClusters(swings, type, tol) {
  const clusters = [];
  for (const s of swings) {
    if (s.type !== type) continue;
    const c = clusters.find((x) => Math.abs(s.price - x.level) <= tol);
    if (c) {
      c.members.push(s);
      c.level = type === "H" ? Math.max(c.level, s.price) : Math.min(c.level, s.price);
    } else clusters.push({ type, level: s.price, members: [s] });
  }
  return clusters.filter((c) => c.members.length >= 2);
}

function buildItem(closed, side, level, i, t, extra) {
  return { side, level, i, t, ...extra, ...levelStatus(closed, i + 1, level, side) };
}

/**
 * Analisis lengkap.
 * @param {object[]} candles  candle urut lama -> baru; yang terakhir boleh belum closed (closed:false)
 * @returns {object|null} null kalau candle closed < MIN_CANDLES atau belum ada swing high & low
 */
function analyzeStructure(candles, opts = {}) {
  const cfg = { ...CFG, ...opts };
  const closed = candles.filter((c) => c.closed !== false);
  const live = candles.length && candles[candles.length - 1].closed === false ? candles[candles.length - 1] : null;
  const n = closed.length;
  if (n < cfg.MIN_CANDLES) return null;

  const atrArr = atrSeries(closed);
  const last = closed[n - 1];
  const price = last.c;
  const a = atrAt(atrArr, n - 1);

  // ---- swing + label + tren (sama dengan !hhll, tanpa filter sideways) ----
  const pivots = findPivots(closed, cfg.PIVOT_WIN);
  const swings = labelSwings(buildSwings(pivots, cfg.MIN_SWING_PCT), cfg.EQUAL_PCT);
  const lastHigh = lastOfType(swings, "H");
  const lastLow = lastOfType(swings, "L");
  if (!lastHigh || !lastLow) return null;
  const trend = trendOf(swings); // "up" | "down" | "range" | null
  const labeled = swings.filter((s) => s.label);
  const structureSeq = labeled.length >= 2 ? labeled.slice(-6).map((s) => s.label) : [];

  // ---- BOS / CHoCH (jalan maju tanpa lookahead) ----
  const walk = walkStructure(closed, pivots, atrArr, cfg);
  const events = walk.events;

  // ---- likuiditas ----
  // Semua swing dinilai (dipakai juga untuk menilai MSS); daftar yang ditampilkan dibatasi LIQ_SWINGS swing terakhir.
  const swingItems = swings.map((s) => buildItem(closed, s.type === "H" ? "BSL" : "SSL", s.price, s.i, s.t, { kind: "swing", label: s.label, members: 1 }));
  const windowSwings = swings.slice(-cfg.LIQ_SWINGS);
  const tol = Math.max((price * cfg.EQ_MIN_PCT) / 100, a ? a * cfg.EQ_ATR_MULT : 0);
  const eqItems = [];
  for (const type of ["H", "L"]) {
    for (const c of eqClusters(windowSwings, type, tol)) {
      const latest = c.members.reduce((m, s) => (s.i > m.i ? s : m), c.members[0]);
      eqItems.push(buildItem(closed, type === "H" ? "BSL" : "SSL", c.level, latest.i, latest.t, { kind: "eq", label: type === "H" ? "EQH" : "EQL", members: c.members.length, firstI: Math.min(...c.members.map((m) => m.i)) }));
    }
  }
  const windowStart = windowSwings.length ? windowSwings[0].i : 0;
  const windowItems = swingItems.filter((x) => x.i >= windowStart);
  const bsl = windowItems.filter((x) => x.side === "BSL");
  const ssl = windowItems.filter((x) => x.side === "SSL");
  const nearestBSL = bsl.filter((x) => x.status === "intact" && x.level > price).sort((x, y) => x.level - y.level)[0] || null;
  const nearestSSL = ssl.filter((x) => x.status === "intact" && x.level < price).sort((x, y) => y.level - x.level)[0] || null;
  const pickEq = (side) => {
    const list = eqItems.filter((x) => x.side === side);
    const intact = list.filter((x) => x.status === "intact");
    const pool = intact.length ? intact : list;
    if (!pool.length) return null;
    // intact: yang terdekat ke harga; kalau semua sudah tersapu/tembus: yang terbaru
    return intact.length ? pool.sort((x, y) => Math.abs(x.level - price) - Math.abs(y.level - price))[0] : pool.sort((x, y) => (y.k ?? 0) - (x.k ?? 0))[0];
  };
  const eqh = pickEq("BSL");
  const eql = pickEq("SSL");

  // ---- liquidity sweep (wick menembus, close kembali) ----
  const sweepsByBar = new Map();
  for (const it of [...swingItems, ...eqItems]) {
    if (it.status !== "swept") continue;
    const key = `${it.side}${it.k}`;
    const cur = sweepsByBar.get(key);
    const more = !cur || (it.side === "BSL" ? it.level > cur.level : it.level < cur.level);
    if (more) sweepsByBar.set(key, { side: it.side, level: it.level, k: it.k, t: it.kt, wick: it.wick, close: it.close, eq: it.kind === "eq", levelT: it.t, levelI: it.firstI ?? it.i });
  }
  // t = waktu candle yang menyapu; levelT = waktu swing yang disapu
  const allSweeps = [...sweepsByBar.values()].sort((x, y) => x.k - y.k);
  const recentSweeps = allSweeps.filter((s) => n - 1 - s.k < cfg.SWEEP_LOOKBACK);
  const sweep = recentSweeps.length ? { ...recentSweeps[recentSweeps.length - 1], age: n - 1 - recentSweeps[recentSweeps.length - 1].k } : null;

  // ---- MSS = CHoCH + sweep sisi yang sesuai + displacement ----
  for (const e of events) {
    if (e.kind !== "CHoCH") continue;
    const need = e.dir === "bull" ? "SSL" : "BSL";
    const sw = allSweeps.filter((s) => s.side === need && s.k > e.refI && s.k <= e.k && e.k - s.k <= cfg.MSS_SWEEP_MAX_BARS).pop() || null;
    const disp = e.bodyAtr != null && e.bodyAtr >= cfg.DISPLACEMENT_ATR;
    e.sweepBefore = sw;
    e.displacement = disp;
    if (sw && disp) e.mss = { sweep: sw, bodyAtr: e.bodyAtr };
  }
  const withAge = (e) => (e ? { ...e, age: n - 1 - e.k } : null);
  const recent = (pred) => withAge([...events].reverse().find((e) => pred(e) && n - 1 - e.k < cfg.EVENT_LOOKBACK) || null);
  const bos = recent((e) => e.kind === "BOS");
  const choch = recent((e) => e.kind === "CHoCH");
  const mss = recent((e) => e.kind === "CHoCH" && e.mss);
  const lastEvent = events.length ? events[events.length - 1] : null;

  // ---- status sementara dari candle berjalan (Unconfirmed) ----
  let liveView = null;
  if (live) {
    const refH = lastHigh; // swing terakhir yang sama dengan yang dipakai walkStructure di akhir data
    const refL = lastLow;
    const used = new Set(events.map((e) => `${e.dir === "bull" ? "H" : "L"}${e.refI}`));
    let pending = null;
    if (refH && !used.has(swingKey(refH)) && live.c > refH.price) pending = { dir: "bull", level: refH.price };
    else if (refL && !used.has(swingKey(refL)) && live.c < refL.price) pending = { dir: "bear", level: refL.price };
    if (pending) {
      const against = (pending.dir === "bull" && walk.trend === "down") || (pending.dir === "bear" && walk.trend === "up");
      pending.kind = against ? "CHoCH" : "BOS";
    }
    const pendSweeps = [];
    const intactBSL = swingItems.filter((x) => x.side === "BSL" && x.status === "intact" && live.h > x.level && live.c <= x.level).sort((x, y) => y.level - x.level)[0];
    const intactSSL = swingItems.filter((x) => x.side === "SSL" && x.status === "intact" && live.l < x.level && live.c >= x.level).sort((x, y) => x.level - y.level)[0];
    if (intactBSL) pendSweeps.push({ side: "BSL", level: intactBSL.level, wick: live.h });
    if (intactSSL) pendSweeps.push({ side: "SSL", level: intactSSL.level, wick: live.l });
    liveView = { t: live.t, price: live.c, high: live.h, low: live.l, pending, sweeps: pendSweeps };
    if (!pending && !pendSweeps.length) liveView.empty = true;
  }

  // ---- penilaian bias (aturan tetap, alasan ikut dikembalikan) ----
  let bias = { value: "neutral", why: "range" };
  if (mss && lastEvent && mss.k === lastEvent.k) bias = { value: mss.dir === "bull" ? "bullish" : "bearish", why: mss.dir === "bull" ? "mss.bull" : "mss.bear" };
  else if (trend === "up") bias = walk.trend === "down" ? { value: "neutral", why: "conflict.up" } : { value: "bullish", why: "agree.up" };
  else if (trend === "down") bias = walk.trend === "up" ? { value: "neutral", why: "conflict.down" } : { value: "bearish", why: "agree.down" };

  return {
    n,
    price,
    lastT: last.t,
    atr: a,
    trend, // "up" | "down" | "range" | null (dari label swing)
    smTrend: walk.trend, // arah tembusan struktur terakhir
    structureSeq,
    swings,
    lastHigh,
    lastLow,
    liquidity: { bsl, ssl, nearestBSL, nearestSSL, eqh, eql, eqItems, swingItems },
    events: { bos, choch, mss },
    allEvents: events,
    sweep,
    allSweeps,
    live: liveView,
    bias,
    cfg: { PIVOT_WIN: cfg.PIVOT_WIN, MIN_SWING_PCT: cfg.MIN_SWING_PCT, EVENT_LOOKBACK: cfg.EVENT_LOOKBACK, SWEEP_LOOKBACK: cfg.SWEEP_LOOKBACK },
  };
}

module.exports = { CFG, analyzeStructure, walkStructure, levelStatus, eqClusters };
