"use strict";

/**
 * features/kripto/bias.js
 * ------------------------------------------------------------------
 * !bias <koin> [tf|semua]  -> kesimpulan arah (bullish / netral / bearish) per timeframe
 * dari gabungan beberapa indikator, lengkap skor, keyakinan, dan alasan singkat.
 *
 * Bias = kondisi pasar saat ini, BUKAN sinyal entry.
 *
 * Susunan file:
 *   1. Konstanta bobot & ambang (dibaca dari config/indicatorConfig.js -> BIAS_CONFIG;
 *      naikkan BIAS_CONFIG.VERSION kalau diubah)
 *   2. Fungsi skor per komponen (murni)
 *   3. computeBias(inputs)  -> murni: tanpa fetch, tanpa cache, tanpa kirim pesan
 *   4. gatherBiasInputs()   -> pengumpul data (Binance + snapshot cache 3 menit)
 *   5. Format pesan + runner + parser command
 *
 * Semua angka dihitung di backend (tanpa Gemini). Indikator RSI/MACD dihitung dari
 * candle closed; harga untuk posisi EMA memakai harga live (sama seperti !tren).
 *
 * Changelog:
 *   v1 (2026-10-16) bobot awal usulan PDF: trend .30, cross .15, rsi .10, macd .15,
 *                   mood .10, btc .10, oiFunding .10. Ambang +-0.25 (eksklusif).
 *   v2 (2026-10-17) item 07 dirapikan: aturan skor pindah ke config; tambah bias KESELURUHAN
 *                   lintas TF (computeOverallBias, bobot TF 15m .10 / 1H .20 / 4H .30 / 1D .40);
 *                   collectBias() dipisah dari runBias agar bisa dipakai ulang 08 dan 09.
 *                   Skor per komponen dan per TF TIDAK berubah dari v1.
 */

const { t } = require("../../i18n");
const { BIAS_CONFIG: CFG } = require("../../config/indicatorConfig");
const {
  computeEmas,
  classifyTrend,
  classifyTrendLimited,
  detectCrossPair,
  strengthScore,
  rsi,
  macd,
} = require("./indicators");
const { computeProbability, formatProbTable, formatProbBasis, PROB_VERSION } = require("./probability");

// =====================================================================
// 1. Konstanta: semua nilai dibaca dari config/indicatorConfig.js (BIAS_CONFIG)
// =====================================================================
const BIAS_VERSION = CFG.VERSION;
const BIAS_WEIGHTS = CFG.WEIGHTS; // total 1.00
const BIAS_BULL = CFG.BULL; // skor > +0.25 -> bullish (batas eksklusif)
const BIAS_BEAR = CFG.BEAR; // skor < -0.25 -> bearish (batas eksklusif)

const BIAS_CROSS_LOOKBACK = CFG.CROSS_LOOKBACK; // cross dianggap relevan <= 20 candle; skor menurun linear
const BIAS_CROSS_PAIR_WEIGHTS = CFG.CROSS_PAIR_WEIGHTS; // 20/50 lebih berisik
const BIAS_RSI_MODE = CFG.RSI_MODE; // "momentum" (usulan) | "contrarian" (jenuh beli = bearish)
const BIAS_RSI_EXTREME_HI = CFG.RSI_EXTREME_HI;
const BIAS_RSI_EXTREME_LO = CFG.RSI_EXTREME_LO;
const BIAS_RSI_EXTREME_DAMP = CFG.RSI_EXTREME_DAMP; // skor RSI di zona ekstrem dikurangi 40%
const BIAS_AGREE_NEUTRAL = CFG.AGREE_NEUTRAL; // |skor komponen| <= ini dianggap "searah" dengan hasil netral
const BIAS_CONF_HIGH = CFG.CONF_HIGH;
const BIAS_CONF_MID = CFG.CONF_MID;
const BIAS_REASON_MIN = CFG.REASON_MIN; // komponen dengan |bobot*skor| di bawah ini tidak ditampilkan di alasan
const BIAS_REASON_MAX = CFG.REASON_MAX;
const BIAS_TF_WEIGHTS = CFG.TF_WEIGHTS; // bobot TF untuk bias keseluruhan

const BIAS_TFS = ["15M", "1H", "4H", "1D"]; // urutan tampilan (sama dengan !mtf)
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const COMPONENT_ORDER = ["trend", "cross", "rsi", "macd", "mood", "btc", "oiFunding"];

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const round4 = (v) => Math.round(v * 1e4) / 1e4;

// =====================================================================
// 2. Skor per komponen (-1..+1). Semua murni. Mengembalikan null kalau data tidak ada.
//    `reason` = { id, p } (id kunci i18n + parameter), dirender oleh renderReason().
// =====================================================================

/**
 * Komponen 1 - tren EMA.
 * strengthScore() bernilai 0..4 (bullish = 4, bearish = 0), jadi dipetakan linear
 * (skor - 2) / 2 supaya bearish menjadi negatif. Mode data terbatas: skor 0..3 -> (skor - 1.5) / 1.5.
 * @param {{trend:string, above:number[], limited?:boolean, score?:number, max?:number}|null} trend
 */
function scoreTrend(trend) {
  if (!trend) return null;
  const score = trend.limited ? clamp((trend.score - trend.max / 2) / (trend.max / 2)) : clamp((trend.score - 2) / 2);
  return {
    score,
    reason: trend.limited
      ? { id: "trendLimited", p: { label: trend.trend } }
      : { id: "trend", p: { label: trend.trend, above: trend.above.length, total: 3 } },
  };
}

/**
 * Komponen 2 - crossover. crosses = { "50/200": {type,barsAgo}|null, "20/50": ... }.
 * Besar skor menurun linear terhadap umur (1 - barsAgo / lookback). Tidak ada cross baru =
 * tidak ada informasi -> null (dilewati, bukan 0, agar skor tidak ditarik ke netral).
 */
function scoreCross(crosses, lookback = BIAS_CROSS_LOOKBACK) {
  if (!crosses) return null;
  let total = 0;
  let wsum = 0;
  let best = null;
  for (const [pair, w] of Object.entries(BIAS_CROSS_PAIR_WEIGHTS)) {
    const c = crosses[pair];
    if (!c) continue;
    const mag = clamp(1 - c.barsAgo / lookback, 0, 1);
    if (mag <= 0) continue;
    const signed = (c.type === "golden" ? 1 : -1) * mag;
    total += w * signed;
    wsum += w;
    if (!best || w * mag > best.contrib) best = { pair, type: c.type, barsAgo: c.barsAgo, contrib: w * mag };
  }
  if (!best) return null;
  return {
    score: clamp(total / wsum),
    reason: { id: best.type === "golden" ? "golden" : "death", p: { pair: best.pair, barsAgo: best.barsAgo } },
  };
}

/** Komponen 3 - RSI. Momentum: (RSI - 50) / 25; zona ekstrem diredam. Kontrarian membalik di zona ekstrem. */
function scoreRsi(value, mode = BIAS_RSI_MODE) {
  if (value == null || !isFinite(value)) return null;
  let s = clamp((value - 50) / 25);
  const hi = value > BIAS_RSI_EXTREME_HI;
  const lo = value < BIAS_RSI_EXTREME_LO;
  if (mode === "contrarian") {
    if (hi || lo) s = -s; // jenuh beli = bearish, jenuh jual = bullish
  } else if (hi || lo) {
    s *= 1 - BIAS_RSI_EXTREME_DAMP;
  }
  const id = hi ? "rsiHigh" : lo ? "rsiLow" : "rsi";
  return { score: clamp(s), reason: { id, p: { v: Math.round(value) } } };
}

/** Komponen 4 - MACD histogram: +-0.5 untuk tanda histogram, +-0.5 untuk arah (naik/turun vs candle sebelumnya). */
function scoreMacd(m) {
  if (!m || m.hist == null || m.prevHist == null) return null;
  const pos = m.hist > 0;
  const rising = m.hist > m.prevHist;
  const score = (pos ? 0.5 : -0.5) + (rising ? 0.5 : -0.5);
  return { score, reason: { id: `macd${pos ? "Pos" : "Neg"}${rising ? "Up" : "Down"}`, p: {} } };
}

/** Komponen 5 - mood pasar: (persen koin di atas EMA200 - 50) / 30, dibatasi -1..+1. */
function scoreMood(abovePct) {
  if (abovePct == null || !isFinite(abovePct)) return null;
  return { score: clamp((abovePct - 50) / 30), reason: { id: "mood", p: { pct: Math.round(abovePct) } } };
}

/** Komponen 6 - tren BTC di TF yang sama (pemetaan sama dengan komponen 1). */
function scoreBtc(btcTrend) {
  const r = scoreTrend(btcTrend);
  if (!r) return null;
  return { score: r.score, reason: { id: "btc", p: { label: btcTrend.trend } } };
}

/**
 * Komponen 7 - OI + funding (Bagian 2 / futures.js). Belum ada di kode, jadi inputnya null
 * dan komponen dilewati. Bentuk input saat nanti tersedia:
 *   { state: "longBuildup"|"shortBuildup"|"shortCover"|"longUnwind", fundingExtreme?: -1|0|1 }
 */
const OI_SCORES = { longBuildup: 0.5, shortBuildup: -0.5, shortCover: 0.2, longUnwind: -0.2 };
function scoreOiFunding(oi) {
  if (!oi || OI_SCORES[oi.state] == null) return null;
  const s = OI_SCORES[oi.state] - (oi.fundingExtreme || 0) * 0.1; // funding ekstrem = penyeimbang kontrarian kecil
  return { score: clamp(s), reason: { id: "oi", p: { state: oi.state } } };
}

// =====================================================================
// 3. computeBias (murni)
// =====================================================================

/**
 * @param {{
 *   trend?: object|null,    // keluaran classifyTrend + strengthScore (lihat gatherBiasInputs)
 *   crosses?: object|null,
 *   rsi?: number|null,
 *   macd?: {hist:number, prevHist:number}|null,
 *   moodAbovePct?: number|null,
 *   btcTrend?: object|null,
 *   oiFunding?: object|null,
 * }} inputs
 * @param {{ weights?: object, rsiMode?: string }} [opts]
 * @returns {{
 *   version: number, bias: "bullish"|"bearish"|"netral", score: number, confidence: number,
 *   components: {key:string, score:number|null, weight:number, used:boolean, reason:object|null}[],
 *   skipped: string[], insufficient: boolean
 * }}
 */
function computeBias(inputs, opts = {}) {
  const weights = opts.weights || BIAS_WEIGHTS;
  const raw = {
    trend: scoreTrend(inputs.trend),
    cross: scoreCross(inputs.crosses),
    rsi: scoreRsi(inputs.rsi, opts.rsiMode),
    macd: scoreMacd(inputs.macd),
    mood: scoreMood(inputs.moodAbovePct),
    btc: scoreBtc(inputs.btcTrend),
    oiFunding: scoreOiFunding(inputs.oiFunding),
  };

  const components = [];
  const skipped = [];
  let num = 0;
  let den = 0;
  for (const key of COMPONENT_ORDER) {
    const r = raw[key];
    const weight = weights[key] ?? 0;
    const used = !!r && weight > 0;
    components.push({ key, score: r ? r.score : null, weight, used, reason: r ? r.reason : null });
    if (used) {
      num += weight * r.score;
      den += weight;
    } else {
      skipped.push(key);
    }
  }

  // Komponen tanpa data DILEWATI dan bobotnya dinormalisasi ulang (bukan dihitung 0).
  if (den === 0) {
    return { version: BIAS_VERSION, bias: "netral", score: 0, confidence: 0, components, skipped, insufficient: true };
  }
  const score = round4(num / den); // pembulatan 4 digit menghindari noise float tepat di ambang
  const bias = score > BIAS_BULL ? "bullish" : score < BIAS_BEAR ? "bearish" : "netral";

  // Keyakinan = porsi bobot komponen yang searah hasil akhir.
  let agree = 0;
  for (const c of components) {
    if (!c.used) continue;
    const same =
      bias === "bullish" ? c.score > 0 : bias === "bearish" ? c.score < 0 : Math.abs(c.score) <= BIAS_AGREE_NEUTRAL;
    if (same) agree += c.weight;
  }
  return { version: BIAS_VERSION, bias, score, confidence: round4(agree / den), components, skipped, insufficient: false };
}

const confidenceLevel = (c) => (c >= BIAS_CONF_HIGH ? "high" : c >= BIAS_CONF_MID ? "mid" : "low");

/**
 * Bias KESELURUHAN lintas timeframe (murni). Rata-rata berbobot skor tiap TF memakai
 * BIAS_TF_WEIGHTS (TF tinggi lebih berat), ambang bullish/bearish sama dengan per TF.
 * TF gagal / data kurang dilewati dan bobotnya dinormalisasi ulang (bukan dihitung 0).
 * Keyakinan = porsi bobot TF yang searah hasil akhir (aturan sama dengan computeBias).
 * Dipakai ulang oleh 08 (!sinyal) dan 09 (probabilitas) agar semua command satu sumber skor.
 *
 * @param {{tf:string, result:{score:number, insufficient?:boolean}|null}[]} rows
 * @param {{ tfWeights?: Record<string, number> }} [opts]
 * @returns {{ version:number, bias:"bullish"|"bearish"|"netral", score:number, confidence:number,
 *             used:string[], skipped:string[], insufficient:boolean }}
 */
function computeOverallBias(rows, opts = {}) {
  const tfWeights = opts.tfWeights || BIAS_TF_WEIGHTS;
  const used = [];
  const skipped = [];
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const w = tfWeights[r.tf] ?? 0;
    if (r.result && !r.result.insufficient && w > 0) {
      used.push(r.tf);
      num += w * r.result.score;
      den += w;
    } else {
      skipped.push(r.tf);
    }
  }
  if (den === 0) {
    return { version: BIAS_VERSION, bias: "netral", score: 0, confidence: 0, used, skipped, insufficient: true };
  }
  const score = round4(num / den);
  const bias = score > BIAS_BULL ? "bullish" : score < BIAS_BEAR ? "bearish" : "netral";
  let agree = 0;
  for (const r of rows) {
    if (!used.includes(r.tf)) continue;
    const sc = r.result.score;
    const same = bias === "bullish" ? sc > 0 : bias === "bearish" ? sc < 0 : Math.abs(sc) <= BIAS_AGREE_NEUTRAL;
    if (same) agree += tfWeights[r.tf];
  }
  return { version: BIAS_VERSION, bias, score, confidence: round4(agree / den), used, skipped, insufficient: false };
}

// =====================================================================
// 4. Pengumpul input (I/O). Require berat dibuat lazy supaya computeBias bisa diuji tanpa jaringan.
// =====================================================================

/**
 * Hitung input bias satu koin di satu TF dari candle closed + harga live.
 * Indikator memakai fungsi dasar yang sama dengan analyzeCoin / !tren (computeEmas, classifyTrend,
 * detectCrossPair), jadi tidak ada jalur hitung kedua yang bisa berbeda hasil.
 */
function buildCoinInputs(candles, price) {
  if (!candles || candles.length < 51) return null; // EMA50 + RSI/MACD perlu warmup
  const { series, latest } = computeEmas(candles);
  const closes = candles.map((c) => c.c);

  let trend;
  const full = latest[200] != null;
  if (full) {
    const info = classifyTrend(price, latest);
    trend = { ...info, score: strengthScore(info), limited: false };
  } else {
    trend = classifyTrendLimited(price, latest);
  }

  const crosses = {
    "50/200": full ? detectCrossPair(series, 50, 200, BIAS_CROSS_LOOKBACK) : null,
    "20/50": detectCrossPair(series, 20, 50, BIAS_CROSS_LOOKBACK),
  };
  const rsiSeries = rsi(closes);
  const m = macd(closes);
  const n = closes.length;
  return {
    trend,
    crosses,
    rsi: rsiSeries[n - 1],
    macd: m.hist[n - 1] != null && m.hist[n - 2] != null ? { hist: m.hist[n - 1], prevHist: m.hist[n - 2] } : null,
    limited: !full,
  };
}

/** Input BTC + mood dari snapshot (cache 3 menit). Gagal -> { mood: null, btc: null } (komponen dilewati). */
async function marketInputsFromSnapshot(snapshot, coin) {
  if (!snapshot) return { moodAbovePct: null, btcTrend: null };
  const { computeStats } = require("./statistik");
  const s = computeStats(snapshot.coins);
  const moodAbovePct = s.n > 0 ? (s.above200 / s.n) * 100 : null;
  let btcTrend = null;
  if (coin !== "BTC") {
    const btc = snapshot.coins.find((c) => c.ticker === "BTC");
    if (btc) btcTrend = { ...btc.info, score: strengthScore(btc.info), limited: false };
  }
  return { moodAbovePct, btcTrend };
}

/**
 * Kumpulkan input untuk satu koin di satu TF. Tiap TF gagal-sendiri: lempar error
 * supaya pemanggil bisa menandai TF itu tanpa menggagalkan TF lain.
 * @param {string} coin
 * @param {string} tf "15M"|"1H"|"4H"|"1D"
 * @param {{ lang: string, tick: {price:number}, snapshot: object|null, candles?: object[] }} ctx
 */
async function gatherBiasInputs(coin, tf, ctx) {
  const { fetchCandles } = require("./market");
  const candles = ctx.candles || (await fetchCandles(coin, tf)); // ctx.candles: dipakai !sinyal agar candle tidak diambil dua kali
  const own = buildCoinInputs(candles, ctx.tick.price);
  if (!own) throw new Error("BIAS_DATA_TOO_SHORT");
  const market = await marketInputsFromSnapshot(ctx.snapshot, coin);
  return {
    trend: own.trend,
    crosses: own.crosses,
    rsi: own.rsi,
    macd: own.macd,
    moodAbovePct: market.moodAbovePct,
    btcTrend: market.btcTrend,
    oiFunding: null, // menunggu futures.js / correlate() (Langkah 5)
    limited: own.limited,
  };
}

// =====================================================================
// 5. Format pesan, runner, parser
// =====================================================================
const pad = (s, n) => String(s).padEnd(n, " ");
const fmtScore = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

function agoText(lang, barsAgo) {
  return barsAgo === 0 ? t(lang, "kripto.tren.justNow") : t(lang, "kripto.tren.barsAgo", { n: barsAgo });
}

/** Satu baris alasan (maks 1 baris per komponen). */
function renderReason(lang, comp) {
  const r = comp.reason;
  if (!r) return null;
  const p = { ...r.p };
  if (r.id === "trend" || r.id === "trendLimited" || r.id === "btc") p.label = t(lang, `bias.label.${p.label}`);
  if (r.id === "golden" || r.id === "death") p.ago = agoText(lang, p.barsAgo);
  if (r.id === "oi") p.state = t(lang, `bias.oi.${p.state}`);
  const mark = comp.score > 0.1 ? "+" : comp.score < -0.1 ? "-" : "•";
  return `${mark} ${t(lang, `bias.r.${r.id}`, p)}`;
}

/** Alasan yang ditampilkan: komponen berkontribusi besar saja, urut dari yang terbesar, maks BIAS_REASON_MAX. */
function pickReasons(result, lang) {
  return result.components
    .filter((c) => c.used && Math.abs(c.weight * c.score) >= BIAS_REASON_MIN)
    .sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))
    .slice(0, BIAS_REASON_MAX)
    .map((c) => renderReason(lang, c))
    .filter(Boolean);
}

function formatBias(lang, { coin, price, rows, reasonTf, reasonResult, limitedAny, failedAny, overall }) {
  const W = overall ? 5 : 4; // kolom pertama melebar agar label "Total" muat
  const header = `${pad(t(lang, "kripto.mtf.colTf"), W)} ${pad("Bias", 8)} ${pad(t(lang, "bias.col.score"), 6)} ${t(lang, "bias.col.conf")}`;
  const rowLine = (name, res) => {
    const label = res.insufficient ? "-" : t(lang, `bias.label.${res.bias}`);
    const conf = res.insufficient ? "-" : t(lang, `bias.conf.${confidenceLevel(res.confidence)}`);
    return `${pad(name, W)} ${pad(label, 8)} ${pad(fmtScore(res.score), 6)} ${conf}`;
  };
  const body = rows.map((r) => (r.result ? rowLine(TF_LABEL[r.tf], r.result) : `${pad(TF_LABEL[r.tf], W)} ${t(lang, "bias.failed")}`));
  if (overall && !overall.insufficient) body.push("-".repeat(header.length), rowLine(t(lang, "bias.overall.row"), overall));

  const parts = [t(lang, "bias.head", { coin, ver: BIAS_VERSION, price })];
  if (overall && !overall.insufficient) {
    parts.push(
      t(lang, "bias.overall.line", {
        bias: t(lang, `bias.label.${overall.bias}`),
        score: fmtScore(overall.score),
        conf: t(lang, `bias.conf.${confidenceLevel(overall.confidence)}`),
      }),
    );
  }
  parts.push("", "```\n" + [header, ...body].join("\n") + "\n```");

  // Item 09: probabilitas bull/bear/sideways dari skor yang sama (tanpa AI), jumlah selalu 100%.
  const probRows = rows.filter((r) => r.result && !r.result.insufficient).map((r) => ({ label: TF_LABEL[r.tf], prob: computeProbability(r.result) }));
  if (probRows.length) {
    const totalProb = overall && !overall.insufficient ? computeProbability(overall) : null;
    const basis = totalProb || probRows[probRows.length - 1].prob;
    parts.push(
      t(lang, "prob.head", { ver: PROB_VERSION }),
      "```\n" + formatProbTable(lang, probRows, totalProb ? { label: t(lang, "bias.overall.row"), prob: totalProb } : null) + "\n```",
      t(lang, "prob.basisLine", { basis: formatProbBasis(lang, basis) }),
    );
  }

  if (reasonResult) {
    const lines = pickReasons(reasonResult, lang);
    if (lines.length) parts.push(t(lang, "bias.reasonsHead", { tf: TF_LABEL[reasonTf] }), ...lines);
    // N/A hanya untuk data yang memang tidak ada. "Tidak ada cross baru" bukan N/A, dan tren BTC
    // memang dilewati saat koinnya BTC sendiri.
    const na = reasonResult.skipped.filter((k) => k !== "cross" && !(k === "btc" && coin === "BTC")).map((k) => t(lang, `bias.comp.${k}`));
    if (na.length) parts.push(t(lang, "bias.na", { list: na.join(", ") }));
  }
  const notes = [];
  if (overall && !overall.insufficient) {
    const weights = BIAS_TFS.map((tf) => `${TF_LABEL[tf]} ${Math.round((BIAS_TF_WEIGHTS[tf] ?? 0) * 100)}%`).join(", ");
    notes.push(t(lang, "bias.overall.note", { weights }));
  }
  if (probRows.length) notes.push(t(lang, "prob.note"));
  if (limitedAny) notes.push(t(lang, "bias.note.limited"));
  if (failedAny) notes.push(t(lang, "bias.note.failed"));
  if (notes.length) parts.push("", ...notes);
  parts.push("", t(lang, "bias.disclaimer"));
  return parts.join("\n");
}

/**
 * Kumpulkan hasil bias per TF untuk satu koin (I/O). Dipisah dari runBias supaya 08 (!sinyal)
 * dan 09 (probabilitas) memakai skor yang SAMA. Satu snapshot per TF (cache 3 menit statistik.js).
 * TF yang gagal -> { tf, result: null, err }, tidak menggagalkan TF lain.
 * @param {string} coin
 * @param {string[]} tfs
 * @param {{ lang: string, tick: {price:number} }} ctx
 * Tiap baris juga membawa `candles` (candle closed yang dipakai menghitung) supaya 08 (!sinyal)
 * bisa menghitung ATR / level S/R tanpa fetch kedua.
 * @returns {Promise<{tf:string, result:object|null, limited:boolean, candles?:object[], err?:Error}[]>}
 */
async function collectBias(coin, tfs, ctx) {
  const stat = require("./statistik");
  const { fetchCandles } = require("./market");
  // ctx.market (adapter pasar, lihat kripto/marketAdapter.js dan forex/forexMarket.js) opsional. Tanpa itu = kripto seperti sebelumnya.
  // Pasar tanpa snapshot (forex, noSnapshot) melewati mood pasar & tren BTC: komponen itu null -> dilewati, bobot dinormalisasi ulang.
  const mkt = ctx.market || null;
  return Promise.all(
    tfs.map(async (tf) => {
      let snapshot = null;
      if (!mkt?.noSnapshot) {
        try {
          snapshot = await stat.getSnapshot(ctx.lang, tf); // gagal -> mood & BTC dilewati
        } catch {
          snapshot = null;
        }
      }
      try {
        const candles = mkt ? await mkt.fetchCandles(tf) : await fetchCandles(coin, tf);
        const inputs = await gatherBiasInputs(coin, tf, { lang: ctx.lang, tick: ctx.tick, snapshot, candles });
        return { tf, result: computeBias(inputs), limited: inputs.limited, candles };
      } catch (err) {
        return { tf, result: null, limited: false, err };
      }
    }),
  );
}

/**
 * !bias <koin> [tf|semua]. Tanpa Gemini. TF yang gagal ditandai, tidak menggagalkan seluruh perintah.
 * Lebih dari satu TF berhasil -> ditambah baris Total (bias keseluruhan, computeOverallBias).
 */
async function runBias(sock, msg, ctx, { coin, tfs }) {
  const { jid, lang } = ctx;
  const { fetchTicker, fmtUsd, UnsupportedCoinError } = require("./market");
  const stat = require("./statistik");

  const tick = await fetchTicker(coin); // koin tidak dikenal -> UnsupportedCoinError (ditangani handler)

  // Satu pesan "memindai" saja kalau ada snapshot yang belum hangat.
  if (tfs.some((tf) => !stat.isSnapshotWarm(tf))) {
    await sock.sendMessage(jid, { text: t(lang, "bias.scanning", { coin }) }, { quoted: msg });
  }

  const results = await collectBias(coin, tfs, { lang, tick });

  const ok = results.filter((r) => r.result);
  if (!ok.length) {
    const e = results.find((r) => r.err)?.err;
    if (e instanceof UnsupportedCoinError) throw e;
    throw e || new Error("BIAS_FAILED");
  }

  // Alasan: untuk satu TF = TF itu; untuk semua = 4H kalau ada, kalau tidak TF tertinggi yang berhasil.
  const pick = ok.find((r) => r.tf === "4H") || ok[ok.length - 1];
  const overall = ok.length > 1 ? computeOverallBias(results) : null;
  const text = formatBias(lang, {
    coin,
    price: fmtUsd(tick.price),
    rows: results,
    reasonTf: pick.tf,
    reasonResult: pick.result,
    limitedAny: ok.some((r) => r.limited),
    failedAny: results.some((r) => !r.result),
    overall,
  });
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

const BIAS_COMMANDS = { bias: { re: /^!bias(?:\s+([\s\S]*))?$/i } };

/**
 * "btc" | "btc 4h" | "btc semua" | "4h btc"  ->  { coin, tfs }.
 * Tanpa tf = semua (konsisten dengan !mtf). null kalau format salah.
 */
function parseBiasArgs(name, raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  let coin = null;
  let tf = null;
  let all = false;
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (BIAS_TFS.includes(up)) {
      if (tf || all) return null;
      tf = up;
    } else if (up === "SEMUA" || up === "ALL") {
      if (tf || all) return null;
      all = true;
    } else if (!coin && /^[A-Z0-9]{1,15}$/.test(up)) coin = up;
    else return null;
  }
  if (!coin) return null;
  return { coin, tfs: tf ? [tf] : [...BIAS_TFS] };
}

const BIAS_RUNNERS = { bias: runBias };

module.exports = {
  BIAS_VERSION,
  BIAS_WEIGHTS,
  BIAS_BULL,
  BIAS_BEAR,
  BIAS_TF_WEIGHTS,
  BIAS_TFS,
  BIAS_COMMANDS,
  BIAS_RUNNERS,
  parseBiasArgs,
  computeBias,
  computeOverallBias,
  collectBias,
  gatherBiasInputs,
  buildCoinInputs,
  confidenceLevel,
  renderReason,
  formatBias,
  // skor per komponen (untuk pengujian)
  scoreTrend,
  scoreCross,
  scoreRsi,
  scoreMacd,
  scoreMood,
  scoreBtc,
  scoreOiFunding,
};
