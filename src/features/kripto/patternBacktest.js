"use strict";

/**
 * features/kripto/patternBacktest.js
 * ------------------------------------------------------------------
 * Backtest pengenal pola (catatan saran Bagian 10, Fase 4). Logika MURNI: tanpa jaringan, tanpa file.
 * I/O ada di scripts/backtest-pola.js. Pola sama dengan hhllBacktest.js / trenStateBacktest.js.
 *
 * Sampel: tiap pola yang BARU terkonfirmasi (confirmI = candle terakhir jendela). Jendela dibatasi BT_WINDOW candle
 * yang berakhir di i, jadi tidak ada lookahead. Satu pola (kind + dir + titik awal/akhir absolut) hanya jadi satu sampel.
 *
 * Hasil, diamati BT_HORIZON (24) candle ke depan dari candle konfirmasi:
 *   continue ("jalan"): harga bergerak >= BT_CONTINUE_ATR x ATR searah pola SEBELUM close melewati level batal
 *   fail ("gagal")    : close kembali melewati level batal lebih dulu (dicek lebih dulu dalam satu candle = konservatif)
 *   neither           : keduanya tidak terjadi
 * Definisi "jalan" SAMA untuk pola dan baseline (gerak >= 1 ATR). Target ukuran pola dicatat terpisah (targetHit),
 * tidak dipakai untuk keputusan, supaya pola tidak diuntungkan oleh target yang lebih jauh.
 *
 * BASELINE ("tembus level yang sama tanpa pola"): candle yang close-nya menembus ekstrem BT_BASE_LOOKBACK candle
 * sebelumnya, di candle yang BUKAN konfirmasi pola. Level batal baseline = level tembus -/+ jarak risiko yang sama
 * (dalam ATR) dengan median jarak konfirmasi->batal sampel pola, supaya "gagal" sama sulitnya.
 *
 * Zona (FVG, order block) diuji terpisah oleh runZoneBacktest (reaksi saat kembali ke zona, baseline level acak).
 *
 * Keputusan bobot: pola dinilai pada kelompok OUT-OF-SAMPLE (bagian waktu terakhir), hanya bila N >= STATS_MIN_N untuk
 * pola DAN baseline. Bobot 0 bila pola tidak lebih baik dari baseline (lihat verdictOf).
 *
 * BATAS YANG HARUS DISEBUT DI LAPORAN:
 *   - tanpa fee/slip/spread/gap: ini statistik arah, bukan hasil trading;
 *   - sampel berdekatan tumpang tindih, jadi tidak independen;
 *   - jumlah kombinasi (pola x TF x ambang) yang dicoba dicatat di meta.combos; makin banyak, makin besar peluang kebetulan;
 *   - ambang disetel hanya pada bagian train; angka oos tidak boleh dipakai untuk menyetel ulang.
 */

const { PATTERN_CONFIG: CFG } = require("../../config/indicatorConfig");
const { atr: atrSeries } = require("./indicators");
const { scanSwingPatterns } = require("./swingPatterns");
const { scanCandlePatterns } = require("./candlePatterns");
const { scanLinePatterns } = require("./linePatterns");
const { fvgAt, orderBlockAt } = require("./zonePatterns");
const { computeStructure } = require("./hhllCore");

const ZONE_KINDS = Object.freeze(["fvg", "orderBlock"]);

const isNum = (v) => typeof v === "number" && isFinite(v);
const median = (a) => {
  const x = a.filter(isNum).sort((p, q) => p - q);
  return x.length ? (x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null;
};

/**
 * Hasil satu kejadian. up = true bila searah naik.
 * @param {{up:boolean, base:number, atr:number, inval:number}} ev base = close konfirmasi
 * @param {{h:number,l:number,c:number}[]} future candle sesudah candle konfirmasi (lama -> baru)
 * @returns {{outcome:"continue"|"fail"|"neither", mfe:number, mae:number, bars:number|null}}
 */
function outcomeOf(ev, future, { continueAtr = CFG.BT_CONTINUE_ATR } = {}) {
  const { up, base, atr, inval } = ev;
  let outcome = null;
  let bars = null;
  let mfe = 0;
  let mae = 0;
  future.forEach((f, k) => {
    const fav = (up ? f.h - base : base - f.l) / atr;
    const adv = (up ? base - f.l : f.h - base) / atr;
    if (outcome == null) {
      if (up ? f.c < inval : f.c > inval) {
        outcome = "fail";
        bars = k + 1;
      } else if (Math.max(mfe, fav) >= continueAtr) {
        outcome = "continue";
        bars = k + 1;
      }
    }
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
  });
  return { outcome: outcome || "neither", mfe, mae, bars };
}

function targetHit(up, target, future) {
  if (!isNum(target)) return null;
  return future.some((f) => (up ? f.h >= target : f.l <= target));
}

/**
 * Backtest pola satu koin + satu timeframe.
 * @param {object[]} candles candle closed, lama -> baru
 * @param {{coin?:string, tf:string, horizon?:number, warmup?:number, window?:number, families?:string[], htfTrend?:string|null, candleOpts?:object}} opts
 * @returns {{patterns:object[], baseline:object[]}}
 */
function runPatternBacktest(candles, opts = {}) {
  const { tf, coin = "?", horizon = CFG.BT_HORIZON, warmup = CFG.BT_WARMUP, window = CFG.BT_WINDOW } = opts;
  const families = opts.families || ["candle", "swing"];
  const n = candles ? candles.length : 0;
  const patterns = [];
  const baseline = [];
  if (!tf || n < warmup + horizon + 2) return { patterns, baseline };

  const seen = new Set();
  const confirmAt = new Set(); // index candle yang jadi konfirmasi pola mana pun (dikeluarkan dari baseline)
  const atrAll = atrSeries(candles, 14);
  const hasFam = (f) => families.includes(f);

  for (let i = warmup; i <= n - horizon - 1; i++) {
    const off = Math.max(0, i + 1 - window);
    const win = candles.slice(off, i + 1);
    const lastI = win.length - 1;
    const scans = [];
    if (hasFam("candle")) scans.push(scanCandlePatterns(win, opts.candleOpts)); // candleOpts mis. { momentum: { gate: false } } untuk membandingkan sebelum/sesudah
    if (hasFam("swing")) scans.push(scanSwingPatterns(win, { htfTrend: opts.htfTrend ?? null }));
    if (hasFam("line")) scans.push(scanLinePatterns(win));
    for (const sc of scans) {
      if (!sc || !sc.ok) continue;
      for (const p of sc.patterns) {
        if (p.status !== "confirmed" || p.confirmI !== lastI || p.dir === "netral") continue;
        const key = `${p.kind}|${p.dir}|${off + p.startI}|${off + p.endI}`;
        if (seen.has(key)) continue;
        seen.add(key);
        confirmAt.add(i);
        const atr = sc.atrLast;
        const up = p.dir === "bullish";
        const base = candles[i].c;
        if (!isNum(p.invalidLevel) || !isNum(atr) || atr <= 0) continue;
        const future = candles.slice(i + 1, i + 1 + horizon);
        const res = outcomeOf({ up, base, atr, inval: p.invalidLevel }, future);
        patterns.push({
          coin, tf, i, t: candles[i].t, kind: p.kind, family: p.family, dir: p.dir, grade: p.grade,
          riskAtr: Math.abs(base - p.invalidLevel) / atr,
          momAgainst: !!p.momentumAgainst, // tweezer yang MACD dan RSI-nya melawan (versi 4)
          outcome: res.outcome, mfe: res.mfe, mae: res.mae, bars: res.bars,
          targetHit: targetHit(up, p.target, future),
        });
      }
    }
  }

  // Baseline: tembus ekstrem BT_BASE_LOOKBACK candle tanpa pola. Jarak risiko = median jarak risiko pola (satuan ATR).
  const riskAtr = median(patterns.map((s) => s.riskAtr)) ?? 1;
  const L = CFG.BT_BASE_LOOKBACK;
  let lastBase = -Infinity;
  for (let i = Math.max(warmup, L); i <= n - horizon - 1; i++) {
    if (confirmAt.has(i) || i - lastBase < CFG.BT_BASE_COOLDOWN) continue;
    const atr = atrAll[i];
    if (!isNum(atr) || atr <= 0) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - L; k < i; k++) {
      hi = Math.max(hi, candles[k].h);
      lo = Math.min(lo, candles[k].l);
    }
    const c = candles[i].c;
    const up = c > hi;
    if (!up && !(c < lo)) continue;
    const level = up ? hi : lo;
    const inval = up ? level - riskAtr * atr : level + riskAtr * atr;
    const res = outcomeOf({ up, base: c, atr, inval }, candles.slice(i + 1, i + 1 + horizon));
    lastBase = i;
    baseline.push({ coin, tf, i, t: candles[i].t, kind: "baseline", dir: up ? "bullish" : "bearish", riskAtr, outcome: res.outcome, mfe: res.mfe, mae: res.mae, bars: res.bars });
  }
  return { patterns, baseline };
}


/**
 * Backtest ZONA (FVG, order block): reaksi saat harga KEMBALI menyentuh zona.
 *   continue ("tertahan"): setelah sentuhan pertama, harga bergerak >= BT_CONTINUE_ATR x ATR menjauhi zona (searah zona)
 *                          SEBELUM close menembus ujung jauh zona
 *   fail ("menembus")    : close menembus ujung jauh zona lebih dulu (candle sentuhan sendiri dicek dulu)
 * Sentuhan harus terjadi <= ZN_WAIT candle setelah zona terbentuk; zona tanpa sentuhan tidak jadi sampel.
 * Zona terbentuk di candle e hanya dari candle <= e (swing dari jendela yang berakhir di e); sentuhan dan hasil dari candle sesudahnya.
 *
 * BASELINE ZONA ("sentuhan level harga acak dengan jarak yang sama"): tiap ZN_BASE_STRIDE candle dibuat zona maya per arah:
 * ujung dekat = close - D x ATR (bullish) / + D x ATR (bearish), lebar = W x ATR, dengan D dan W = median jarak dan lebar
 * zona nyata arah itu. Lalu aturan sentuhan dan hasil yang SAMA persis.
 * @returns {{patterns:object[], baseline:object[]}}
 */
function runZoneBacktest(candles, opts = {}) {
  const { tf, coin = "?", horizon = CFG.BT_HORIZON, warmup = CFG.BT_WARMUP, window = CFG.BT_WINDOW } = opts;
  const n = candles ? candles.length : 0;
  const patterns = [];
  const baseline = [];
  if (!tf || n < warmup + horizon + 2) return { patterns, baseline };
  const atrAll = atrSeries(candles, 14);
  const wait = CFG.ZN_WAIT;

  const evalZone = (up, near, far, e, A, kind, dir, extra = {}) => {
    let t = null;
    for (let i = e + 1; i <= Math.min(n - 1, e + wait); i++) {
      if (up ? candles[i].l <= near : candles[i].h >= near) { t = i; break; }
    }
    if (t == null || t + horizon >= n) return null;
    const failNow = up ? candles[t].c < far : candles[t].c > far;
    const res = failNow
      ? { outcome: "fail", mfe: 0, mae: 0, bars: 0 }
      : outcomeOf({ up, base: near, atr: A, inval: far }, candles.slice(t + 1, t + 1 + horizon));
    return { coin, tf, i: t, t: candles[t].t, formedI: e, kind, dir, wait: t - e, outcome: res.outcome, mfe: res.mfe, mae: res.mae, bars: res.bars, ...extra };
  };

  const dists = { bullish: [], bearish: [] };
  const widths = { bullish: [], bearish: [] };
  const seenOb = new Set();
  for (let e = warmup; e <= n - horizon - 2; e++) {
    const A = atrAll[e];
    if (!isNum(A) || A <= 0) continue;
    const found = [];
    const f = fvgAt(candles, atrAll, e);
    if (f) found.push(f);
    {
      const off = Math.max(0, e + 1 - window);
      const st = computeStructure(candles.slice(off, e + 1));
      if (st.swings.length >= 2) {
        const shifted = st.swings.map((x) => ({ ...x, i: x.i + off }));
        const o = orderBlockAt(candles, atrAll, shifted, e);
        if (o && !seenOb.has(o.startI + "|" + o.dir)) { seenOb.add(o.startI + "|" + o.dir); found.push(o); }
      }
    }
    for (const z of found) {
      const up = z.dir === "bullish";
      const near = up ? z.zone.top : z.zone.bottom;
      const far = up ? z.zone.bottom : z.zone.top;
      dists[z.dir].push(Math.max(0, up ? candles[e].c - near : near - candles[e].c) / A);
      widths[z.dir].push((z.zone.top - z.zone.bottom) / A);
      const s = evalZone(up, near, far, e, A, z.kind, z.dir, { grade: null });
      if (s) patterns.push(s);
    }
  }
  for (const dir of ["bullish", "bearish"]) {
    const D = median(dists[dir]);
    const W = median(widths[dir]);
    if (D == null || W == null || !(W > 0)) continue;
    const up = dir === "bullish";
    for (let f = warmup; f <= n - horizon - 2; f += CFG.ZN_BASE_STRIDE) {
      const A = atrAll[f];
      if (!isNum(A) || A <= 0) continue;
      const c = candles[f].c;
      const near = up ? c - D * A : c + D * A;
      const far = up ? near - W * A : near + W * A;
      const s = evalZone(up, near, far, f, A, "baselineZone", dir);
      if (s) baseline.push(s);
    }
  }
  return { patterns, baseline };
}

// ---------- ringkasan ----------
function summarize(samples) {
  const n = samples.length;
  if (!n) return null;
  const c = (o) => samples.filter((s) => s.outcome === o).length;
  return { n, cont: (c("continue") / n) * 100, fail: (c("fail") / n) * 100, neither: (c("neither") / n) * 100 };
}

/** Kelompok pola: `${tf}|${kind}|any` dan `${tf}|${kind}|${dir}`. Baseline: `${tf}|baseline|${dir|any}`. */
function buildGroups(samples) {
  const buckets = new Map();
  const add = (k, s) => (buckets.has(k) ? buckets.get(k).push(s) : buckets.set(k, [s]));
  for (const s of samples) {
    add(`${s.tf}|${s.kind}|any`, s);
    add(`${s.tf}|${s.kind}|${s.dir}`, s);
  }
  const out = {};
  for (const [k, arr] of buckets) out[k] = summarize(arr);
  return out;
}

/** Waktu pemisah: TRAIN_FRAC awal (stel) vs sisanya (ukur / out-of-sample). Dihitung dari sampel pola + baseline. */
function cutoffTime(samples, frac = CFG.BT_TRAIN_FRAC) {
  if (!samples.length) return null;
  const ts = samples.map((s) => s.t).sort((a, b) => a - b);
  return ts[Math.min(ts.length - 1, Math.floor(ts.length * frac))];
}

/**
 * Keputusan bobot satu kelompok pola terhadap baseline pada periode oos yang sama.
 * @returns {{weight:0|"kecil"|null, reason:string}} weight null = belum bisa dinilai (N kurang), 0 = tidak lebih baik dari baseline.
 */
function verdictOf(pat, base, { minN = CFG.STATS_MIN_N, minEdge = CFG.BT_MIN_EDGE_PCT } = {}) {
  if (!pat || pat.n < minN) return { weight: null, reason: "N pola < " + minN + " (data belum cukup)" };
  if (!base || base.n < minN) return { weight: null, reason: "N baseline < " + minN + " (pembanding belum cukup)" };
  const edge = pat.cont - base.cont;
  const failEdge = pat.fail - base.fail;
  if (edge > minEdge && failEdge <= 0) return { weight: "kecil", reason: `unggul ${edge.toFixed(1)} poin "jalan", gagal ${failEdge.toFixed(1)} poin vs baseline` };
  return { weight: 0, reason: `tidak lebih baik dari baseline (jalan ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}, gagal ${failEdge >= 0 ? "+" : ""}${failEdge.toFixed(1)} poin)` };
}

/**
 * Isi data/pola-stats.json. Walk-forward: train hanya untuk melihat kestabilan; keputusan HANYA dari oos.
 * @param {object[]} patSamples
 * @param {object[]} baseSamples
 * @param {{combos?:number}} meta combos = jumlah kombinasi pola x TF x ambang yang dicoba (wajib dicatat)
 */
function buildStatsFile(patSamples, baseSamples, meta = {}) {
  const cut = cutoffTime([...patSamples, ...baseSamples]);
  const split = (arr) => ({ train: cut == null ? [] : arr.filter((s) => s.t < cut), oos: cut == null ? [] : arr.filter((s) => s.t >= cut) });
  const P = split(patSamples);
  const B = split(baseSamples);
  const baseOos = buildGroups(B.oos);
  const oos = buildGroups(P.oos);
  const verdicts = {};
  for (const [k, g] of Object.entries(oos)) {
    const [tf, , dir] = k.split("|");
    const kind = k.split("|")[1];
    verdicts[k] = verdictOf(g, baseOos[`${tf}|${ZONE_KINDS.includes(kind) ? "baselineZone" : "baseline"}|${dir}`]);
  }
  return {
    version: CFG.VERSION,
    generatedAt: new Date().toISOString(),
    horizon: CFG.BT_HORIZON,
    minN: CFG.STATS_MIN_N,
    cutoff: cut,
    nTrain: P.train.length,
    nOos: P.oos.length,
    nBaseOos: B.oos.length,
    combos: meta.combos ?? null,
    ...(meta.extra || {}),
    caveats: [
      "tanpa fee/slip/spread nyata; ini statistik arah, bukan hasil trading",
      "sampel berdekatan tumpang tindih (tidak independen)",
      "makin banyak kombinasi pola x TF x ambang yang dicoba, makin besar peluang temuan kebetulan",
      "ambang disetel hanya pada bagian train; angka oos tidak boleh dipakai untuk menyetel ulang",
    ],
    train: buildGroups(P.train),
    oos,
    baselineOos: baseOos,
    verdicts,
  };
}

/** Statistik untuk tampilan: hanya dari oos, hanya bila N >= minN dan pola sudah lolos baseline (bobot bukan 0 / null). */
function lookupPatternStats(stats, { tf, kind, dir }, minN = CFG.STATS_MIN_N) {
  if (!stats || !stats.oos || stats.version !== CFG.VERSION) return null;
  for (const k of [dir && `${tf}|${kind}|${dir}`, `${tf}|${kind}|any`].filter(Boolean)) {
    const g = stats.oos[k];
    if (g && g.n >= minN) return { ...g, verdict: stats.verdicts?.[k] ?? null, scope: k.endsWith("|any") ? "kind" : "dir" };
  }
  return null;
}

module.exports = { ZONE_KINDS, outcomeOf, runPatternBacktest, runZoneBacktest, summarize, buildGroups, cutoffTime, verdictOf, buildStatsFile, lookupPatternStats };
