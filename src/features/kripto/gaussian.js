"use strict";

/**
 * features/kripto/gaussian.js
 * ------------------------------------------------------------------
 * Fitur 4: ESTIMASI SEBARAN HARGA (kurva lonceng / Gaussian dari data lama). Logika MURNI: tanpa fetch, tanpa i18n,
 * tanpa canvas, bisa diuji unit (src/test/gaussian.test.js). Kalibrasi walk-forward ada di calibrate().
 *
 * Ini RINGKASAN SEBARAN MASA LALU, bukan prediksi dan bukan pembacaan psikologi / emosi pasar.
 *
 * Aturan:
 *   - Pakai log return h candle (ln(close[i+h] / close[i])), bukan harga mentah. Jendela tetap (WINDOW candle closed
 *     terakhir), hanya candle closed, tanpa lookahead (return hanya dari candle yang sudah ada di jendela).
 *   - mu = rata-rata, sigma = simpangan baku sampel. Peluang naik = P(return > 0) = Phi(mu / sigma).
 *   - Rentang harga = harga sekarang x exp(mu +- k x sigma), k = Z1 (~68%) dan Z2 (~95%).
 *   - Return h candle yang berdekatan tumpang tindih (tidak independen): N besar tidak berarti bukti besar.
 *   - Sampel < MIN_N -> state "nodata": JANGAN tampilkan angka.
 *   - Ekor tebal: kurtosis berlebih >= KURT_WARN -> fatTail true; rentang EMPIRIS (kuantil riil pada tingkat peluang
 *     yang sama dengan mu +- k sigma) ikut dikembalikan sebagai pendamping.
 *   - Versi bersyarat (estimateConditional): hanya kejadian lama yang mirip (pemanggil yang menentukan "mirip",
 *     mis. pola sama + tren TF besar sama dari patternBacktest). Sampel < COND_MIN_N -> "nodata".
 *
 * Semua ambang di GAUSSIAN_CONFIG: nilai awal usulan, validasi lewat calibrate() / scripts/kalibrasi-gaussian.js.
 */

const { GAUSSIAN_CONFIG: CFG } = require("../../config/indicatorConfig");

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Fungsi galat (Abramowitz & Stegun 7.1.26, galat maks ~1.5e-7). */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

/** CDF normal baku. */
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/** Simpangan baku sampel (n - 1). */
function stdev(a, m = mean(a)) {
  if (a.length < 2) return 0;
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (a.length - 1));
}

/** Kurtosis berlebih (0 = normal; > 0 = ekor lebih tebal). null bila sigma 0 / data kurang. */
function excessKurtosis(a, m = mean(a), sd = stdev(a, m)) {
  const n = a.length;
  if (n < 4 || !(sd > 0)) return null;
  let s4 = 0;
  for (const v of a) s4 += ((v - m) / sd) ** 4;
  const g2 = (n * (n + 1) * s4) / ((n - 1) * (n - 2) * (n - 3)) - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return g2;
}

/** Kuantil interpolasi linear dari array TERURUT naik. q di [0, 1]. */
function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Log return h candle dari jendela terakhir. Pasangan (i, i+h) di dalam jendela saja.
 * @param {{c:number}[]} candles candle closed, lama -> baru
 * @returns {number[]}
 */
function logReturns(candles, h = CFG.HORIZON, window = CFG.WINDOW) {
  if (!Array.isArray(candles) || !(h >= 1)) return [];
  const win = window > 0 ? candles.slice(-window) : candles;
  const out = [];
  for (let i = 0; i + h < win.length; i++) {
    const a = win[i].c;
    const b = win[i + h].c;
    if (isNum(a) && isNum(b) && a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

const priceRange = (last, mu, sd, k) => ({ lo: last * Math.exp(mu - k * sd), hi: last * Math.exp(mu + k * sd) });

/**
 * Inti: dari kumpulan log return + harga sekarang -> sebaran. Dipakai versi biasa dan bersyarat.
 * @param {number[]} returns
 * @param {number} last harga sekarang (close candle closed terakhir)
 * @param {{minN?:number, z1?:number, z2?:number, kurtWarn?:number, h?:number}} opts
 * @returns {{ok:boolean, state:"ok"|"nodata", n:number, minN:number, ...}}
 */
function fromReturns(returns, last, opts = {}) {
  const { minN = CFG.MIN_N, z1 = CFG.Z1, z2 = CFG.Z2, kurtWarn = CFG.KURT_WARN, h = CFG.HORIZON } = opts;
  const r = (returns || []).filter(isNum);
  const n = r.length;
  if (n < minN || !isNum(last) || !(last > 0)) return { ok: false, state: "nodata", n, minN, h };
  const mu = mean(r);
  const sigma = stdev(r, mu);
  if (!(sigma > 0)) return { ok: false, state: "nodata", n, minN, h }; // semua return sama: tidak ada sebaran
  const kurt = excessKurtosis(r, mu, sigma);
  const sorted = [...r].sort((a, b) => a - b);
  const empRange = (k) => ({ lo: last * Math.exp(quantileSorted(sorted, normCdf(-k))), hi: last * Math.exp(quantileSorted(sorted, normCdf(k))) });
  return {
    ok: true,
    state: "ok",
    n,
    minN,
    h,
    last,
    mu,
    sigma,
    kurt,
    fatTail: kurt != null && kurt >= kurtWarn,
    pUp: normCdf(mu / sigma),
    pUpEmp: r.filter((v) => v > 0).length / n,
    z1,
    z2,
    range1: priceRange(last, mu, sigma, z1),
    range2: priceRange(last, mu, sigma, z2),
    emp1: empRange(z1),
    emp2: empRange(z2),
  };
}

/**
 * Estimasi sebaran (versi biasa) dari jendela candle terakhir.
 * @param {{c:number}[]} candles candle closed, lama -> baru
 * @param {{h?:number, window?:number, minN?:number, z1?:number, z2?:number, kurtWarn?:number}} opts
 */
function estimateGaussian(candles, opts = {}) {
  const h = opts.h ?? CFG.HORIZON;
  const window = opts.window ?? CFG.WINDOW;
  if (!Array.isArray(candles) || !candles.length) return { ok: false, state: "nodata", n: 0, minN: opts.minN ?? CFG.MIN_N, h };
  const rets = logReturns(candles, h, window);
  const res = fromReturns(rets, candles[candles.length - 1].c, { ...opts, h });
  return { ...res, window: Math.min(window, candles.length), kind: "all" };
}

/**
 * Versi bersyarat: hanya return dari kejadian lama yang mirip. Pemanggil yang menentukan "mirip" dan memberi indeks
 * candle kejadian (mis. i dari sampel patternBacktest dengan pola + arah yang sama, TF besar searah).
 * Kejadian yang return h candle-nya belum ada (i + h di luar data) dibuang: tidak ada lookahead.
 * @param {{c:number}[]} candles
 * @param {number[]} eventIdx indeks candle (di array `candles`) saat kejadian terjadi
 */
function estimateConditional(candles, eventIdx, opts = {}) {
  const h = opts.h ?? CFG.HORIZON;
  const minN = opts.minN ?? CFG.COND_MIN_N;
  if (!Array.isArray(candles) || !candles.length) return { ok: false, state: "nodata", n: 0, minN, h };
  const rets = [];
  for (const i of [...new Set(eventIdx || [])]) {
    if (!Number.isInteger(i) || i < 0 || i + h >= candles.length) continue;
    const a = candles[i].c;
    const b = candles[i + h].c;
    if (isNum(a) && isNum(b) && a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  const res = fromReturns(rets, candles[candles.length - 1].c, { ...opts, minN, h });
  return { ...res, kind: "conditional" };
}

/**
 * Kalibrasi walk-forward: apakah rentang ~68% / ~95% benar-benar berisi ~68% / ~95% kejadian di data uji?
 * Di tiap titik uji t, sebaran dihitung HANYA dari candle <= t (jendela WINDOW), lalu dibandingkan dengan return
 * nyata ln(close[t+h] / close[t]). Langkah default = h supaya hasil uji tidak tumpang tindih.
 * @returns {{ok:boolean, n:number, ...}} cakupan dalam persen; dirUp = akurasi arah (pUp > 0.5 vs naik nyata)
 */
function calibrate(candles, opts = {}) {
  const h = opts.h ?? CFG.HORIZON;
  const window = opts.window ?? CFG.WINDOW;
  const minN = opts.minN ?? CFG.MIN_N;
  const z1 = opts.z1 ?? CFG.Z1;
  const z2 = opts.z2 ?? CFG.Z2;
  const step = opts.step ?? (CFG.CAL_STEP > 0 ? CFG.CAL_STEP : h);
  const tol = opts.tol ?? CFG.CAL_TOL;
  const n = Array.isArray(candles) ? candles.length : 0;
  // jendela terkecil yang cukup untuk MIN_N return h candle: minN + h candle
  const start = Math.max(minN + h, 1) - 1;
  let tests = 0;
  const hit = { g1: 0, g2: 0, e1: 0, e2: 0 };
  let dirOk = 0;
  let fat = 0;
  for (let t = start; t + h < n; t += step) {
    const from = Math.max(0, t + 1 - window);
    const est = fromReturns(logReturns(candles.slice(from, t + 1), h, 0), candles[t].c, { minN, z1, z2, h });
    if (!est.ok) continue;
    const real = Math.log(candles[t + h].c / candles[t].c);
    if (!isNum(real)) continue;
    tests++;
    const inG = (k) => real >= est.mu - k * est.sigma && real <= est.mu + k * est.sigma;
    const inE = (rg) => candles[t + h].c >= rg.lo && candles[t + h].c <= rg.hi;
    if (inG(z1)) hit.g1++;
    if (inG(z2)) hit.g2++;
    if (inE(est.emp1)) hit.e1++;
    if (inE(est.emp2)) hit.e2++;
    if ((est.pUp > 0.5) === (real > 0)) dirOk++;
    if (est.fatTail) fat++;
  }
  if (!tests) return { ok: false, n: 0, h, window, step };
  const pct = (x) => (x / tests) * 100;
  const target1 = (normCdf(z1) - normCdf(-z1)) * 100;
  const target2 = (normCdf(z2) - normCdf(-z2)) * 100;
  const g1 = pct(hit.g1);
  const g2 = pct(hit.g2);
  return {
    ok: true,
    n: tests,
    h,
    window,
    step,
    target1,
    target2,
    gauss1: g1,
    gauss2: g2,
    emp1: pct(hit.e1),
    emp2: pct(hit.e2),
    dirUp: pct(dirOk),
    fatShare: pct(fat),
    // terkalibrasi bila kedua cakupan Gaussian dalam toleransi dari target
    calibrated: Math.abs(g1 - target1) <= tol && Math.abs(g2 - target2) <= tol,
    tol,
  };
}

module.exports = { erf, normCdf, mean, stdev, excessKurtosis, quantileSorted, logReturns, fromReturns, estimateGaussian, estimateConditional, calibrate };
