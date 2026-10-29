"use strict";

/**
 * features/kripto/patternCore.js
 * ------------------------------------------------------------------
 * FONDASI pengenal pola (catatan saran "Pengenalan Pola", file 00_Dasar: Bagian 1, 2, 7, 9, 11, 12).
 * Logika MURNI: tanpa fetch, tanpa kirim pesan, tanpa canvas, jadi bisa diuji unit (src/test/patternCore.test.js).
 * Belum ada detektor pola di sini; detektor (Fase 1 dst) memakai modul ini supaya semuanya seragam.
 *
 * Isi:
 *   1. prepare()        : candle closed + ATR + swing hhllCore. Data kurang -> { ok:false } "data belum cukup" (tidak menebak).
 *   2. makePattern()    : pabrik objek pola. Pola = bukti bersyarat: wajib punya level konfirmasi dan level batal.
 *   3. gradeOf()        : grade tiga tingkat (kuat / sedang / lemah) dari bukti (+/-), tanpa persentase.
 *   4. resolvePatterns(): aturan prioritas tertulis (Bagian 9) -> satu episode, satu pola, tidak dilaporkan dobel.
 *   5. stableStatus()   : histeresis status (calon -> terkonfirmasi / batal), fungsi murni seperti !trenstate.
 *   6. filterNew()      : dedupe alarm.
 *   7. formatPattern()  : format keluaran Bagian 7 + catatan jujur Bagian 12.
 *
 * Aturan: hanya candle CLOSED, tanpa lookahead. Semua ambang di PATTERN_CONFIG (nilai awal usulan, belum tervalidasi).
 */

const { PATTERN_CONFIG: CFG, INDICATOR_CONFIG } = require("../../config/indicatorConfig");
const { atr: atrSeries } = require("./indicators");
const { computeStructure } = require("./hhllCore");
const { fmtPrice: fmtPriceExact } = require("../../utils/priceFormat");

const NO_DATA = "data belum cukup";

const STATUS = Object.freeze({
  CANDIDATE: "candidate", // calon: terbentuk, belum ada close menembus garis leher / batas
  CONFIRMED: "confirmed", // terkonfirmasi: close menembus garis leher / batas
  INVALIDATED: "invalidated", // batal: close melewati level batal
});
const STATUS_LABEL = Object.freeze({ candidate: "CALON", confirmed: "TERKONFIRMASI", invalidated: "BATAL" });

const GRADE = Object.freeze({ STRONG: "kuat", MEDIUM: "sedang", WEAK: "lemah" });
const DIR = Object.freeze({ BULL: "bullish", BEAR: "bearish", NEUTRAL: "netral" });

/** Keluarga pola = skala. Dipakai aturan "pola lebih besar menang" (Bagian 9). */
const FAMILY = Object.freeze({ CANDLE: "candle", SWING: "swing", LINE: "line", ZONE: "zone", STRUCTURE: "structure" });

const isNum = (v) => typeof v === "number" && isFinite(v);

// ------------------------------------------------------------------
// 1. Persiapan data
// ------------------------------------------------------------------

/**
 * @param {{t:number,o:number,h:number,l:number,c:number,v?:number}[]} candles candle CLOSED, lama -> baru
 * @returns {{ok:false, reason:string, have:number, need:number} | {ok:true, candles, atr:(number|null)[], atrLast:number, structure:object, swings:object[]}}
 */
function prepare(candles, opts = {}) {
  const need = opts.minCandles ?? CFG.MIN_CANDLES;
  if (!Array.isArray(candles) || candles.length < need) {
    return { ok: false, reason: NO_DATA, have: Array.isArray(candles) ? candles.length : 0, need };
  }
  const atr = atrSeries(candles, opts.atrPeriod ?? INDICATOR_CONFIG?.ATR_PERIOD ?? 14);
  const atrLast = atr[atr.length - 1];
  if (!isNum(atrLast) || atrLast <= 0) return { ok: false, reason: NO_DATA, have: candles.length, need };
  const structure = computeStructure(candles);
  if (structure.swings.length < (opts.minSwings ?? CFG.MIN_SWINGS)) {
    return { ok: false, reason: NO_DATA, have: candles.length, need, swings: structure.swings.length };
  }
  return { ok: true, candles, atr, atrLast, structure, swings: structure.swings };
}

// ------------------------------------------------------------------
// 2. Objek pola
// ------------------------------------------------------------------

/**
 * Pabrik objek pola. Menolak pola tanpa level konfirmasi dan level batal (pola = bukti bersyarat, bukan sinyal).
 * @param {object} p
 * @param {string} p.kind        contoh "doubleTop", "engulfing", "bos"
 * @param {string} p.family      salah satu FAMILY
 * @param {string} p.dir         salah satu DIR
 * @param {number} p.startI      index candle awal pola
 * @param {number} p.endI        index candle akhir pola
 * @param {number[]} [p.keyIdx]  index titik kunci (puncak, lembah, ...); default [startI, endI]
 * @param {number} p.confirmLevel level konfirmasi (neckline / batas)
 * @param {number} p.invalidLevel level batal
 * @param {number} [p.target]    target ukuran pola (dihitung dari konfirmasi, bukan dari puncak)
 * @param {string} p.status      salah satu STATUS
 * @param {{sign:"+"|"-", text:string}[]} [p.evidence]
 */
function makePattern(p) {
  if (!p || typeof p.kind !== "string" || !Object.values(FAMILY).includes(p.family)) throw new Error("makePattern: kind/family tidak valid");
  if (!Object.values(DIR).includes(p.dir)) throw new Error("makePattern: dir tidak valid");
  if (!Object.values(STATUS).includes(p.status)) throw new Error("makePattern: status tidak valid");
  if (!isNum(p.startI) || !isNum(p.endI) || p.endI < p.startI) throw new Error("makePattern: startI/endI tidak valid");
  if (!isNum(p.confirmLevel) || !isNum(p.invalidLevel)) throw new Error("makePattern: wajib ada confirmLevel dan invalidLevel");
  return {
    kind: p.kind,
    family: p.family,
    dir: p.dir,
    startI: p.startI,
    endI: p.endI,
    keyIdx: Array.isArray(p.keyIdx) && p.keyIdx.length ? [...p.keyIdx] : [p.startI, p.endI],
    status: p.status,
    confirmLevel: p.confirmLevel,
    invalidLevel: p.invalidLevel,
    confirmPrice: isNum(p.confirmPrice) ? p.confirmPrice : null, // harga close saat konfirmasi; target dan R/R dihitung dari sini
    target: isNum(p.target) ? p.target : null,
    trendBefore: p.trendBefore ?? null, // wajib untuk BOS / CHoCH
    stage: p.stage ?? null, // mis. "retest" (tahap lanjutan pola induk)
    evidence: Array.isArray(p.evidence) ? p.evidence.map((e) => ({ sign: e.sign, text: e.text, ...(e.key ? { key: e.key } : {}), ...(e.params ? { params: e.params } : {}) })) : [], // key/params = kunci i18n + parameter (opsional)
    notes: Array.isArray(p.notes) ? [...p.notes] : [], // sub-jenis dan pola yang diserap (keterangan, bukan label sendiri)
    grade: null,
  };
}

// ------------------------------------------------------------------
// 3. Grade
// ------------------------------------------------------------------

/**
 * Grade tiga tingkat dari bukti. Bukti tanpa tanda "+"/"-" (netral) tidak dihitung.
 * p.gradeCap = "lemah" (opsional, diisi detektor) memaksa lemah, apa pun buktinya.
 * Kuat butuh status terkonfirmasi, net >= GRADE_STRONG_NET, dan (bila diberikan) close melewati level >= CONFIRM_BEYOND_ATR x ATR.
 * Calon tidak pernah di atas sedang. Bukti yang bisa dinilai < MIN_EVIDENCE = lemah.
 */
function gradeOf(p, atrLast = null) {
  if (p.status === STATUS.INVALIDATED) return GRADE.WEAK;
  if (p.gradeCap === GRADE.WEAK) return GRADE.WEAK; // batas atas dari detektor (mis. tweezer yang momentumnya melawan)
  const ev = p.evidence.filter((e) => e.sign === "+" || e.sign === "-");
  if (ev.length < CFG.MIN_EVIDENCE) return GRADE.WEAK;
  const net = ev.filter((e) => e.sign === "+").length - ev.filter((e) => e.sign === "-").length;
  let beyondOk = true;
  if (isNum(atrLast) && isNum(p.confirmPrice) && atrLast > 0) {
    beyondOk = Math.abs(p.confirmPrice - p.confirmLevel) >= CFG.CONFIRM_BEYOND_ATR * atrLast;
  }
  if (p.status === STATUS.CONFIRMED && beyondOk && net >= CFG.GRADE_STRONG_NET) return GRADE.STRONG;
  if (net >= CFG.GRADE_MEDIUM_NET) return GRADE.MEDIUM;
  return GRADE.WEAK;
}

const GRADE_RANK = { [GRADE.STRONG]: 3, [GRADE.MEDIUM]: 2, [GRADE.WEAK]: 1 };

// ------------------------------------------------------------------
// 4. Aturan prioritas (Bagian 9): satu episode, satu pola
// ------------------------------------------------------------------

/**
 * Tabel prioritas tertulis. mode:
 *   "overlap"  : pola kalah bila rentang index-nya beririsan dengan pemenang (skala sama / pola induk).
 *   "location" : pola kalah bila titik akhirnya dekat titik kunci pemenang (candlestick di lokasi pola besar).
 *   "same"     : candle yang sama (engulfing vs harami, dst): endI sama.
 * Yang kalah TIDAK dibuang diam-diam: jadi keterangan (notes) pada pemenang.
 */
const PRIORITY_RULES = Object.freeze([
  { winner: "headAndShoulders", losers: ["doubleTop"], mode: "overlap", why: "double top di dalam head and shoulders" },
  { winner: "inverseHeadAndShoulders", losers: ["doubleBottom"], mode: "overlap", why: "double bottom di dalam inverse head and shoulders" },
  { winner: "engulfing", losers: ["piercing", "darkCloud", "harami"], mode: "same", why: "engulfing > piercing/dark cloud > harami" },
  { winner: "piercing", losers: ["harami"], mode: "same", why: "piercing > harami" },
  { winner: "darkCloud", losers: ["harami"], mode: "same", why: "dark cloud > harami" },
  { winner: "harami", losers: ["insideBar"], mode: "same", why: "harami (body di dalam body) > inside bar" },
  // Tambahan Langkah 1 (Fase 1 candlestick): candle yang sama tidak boleh dilaporkan dobel.
  { winner: "pinBar", losers: ["doji"], mode: "same", why: "pin bar (punya arah) > doji pada candle yang sama" },
  { winner: "morningStar", losers: ["engulfing", "piercing", "darkCloud", "harami", "insideBar"], mode: "same", why: "pola lebih besar (3 candle) menang atas pola 2 candle di candle penutup yang sama" },
  { winner: "eveningStar", losers: ["engulfing", "piercing", "darkCloud", "harami", "insideBar"], mode: "same", why: "pola lebih besar (3 candle) menang atas pola 2 candle di candle penutup yang sama" },
  { winner: "threeMethods", losers: ["engulfing", "marubozu", "insideBar"], mode: "same", why: "three methods menyerap candle penutupnya" },
  { winner: "threeWhiteSoldiers", losers: ["marubozu"], mode: "overlap", why: "three soldiers menyerap marubozu di dalamnya" },
  { winner: "threeBlackCrows", losers: ["marubozu"], mode: "overlap", why: "three crows menyerap marubozu di dalamnya" },
  { winner: "doubleTop", losers: ["tweezerTop"], mode: "overlap", why: "double top > tweezer (beda skala)" },
  { winner: "doubleBottom", losers: ["tweezerBottom"], mode: "overlap", why: "double bottom > tweezer (beda skala)" },
  { winner: "doubleTop", losers: ["equalHighs"], mode: "overlap", why: "double top sudah memuat dua puncak setara" },
  { winner: "doubleBottom", losers: ["equalLows"], mode: "overlap", why: "double bottom sudah memuat dua dasar setara" },
  { winner: "rectangle", losers: ["equalHighs", "equalLows"], mode: "overlap", why: "rectangle menyerap equal highs/lows" },
  // Sub-jenis hanya keterangan pola induk (Lampiran A):
  { winner: "doji", losers: ["dragonflyDoji", "gravestoneDoji", "longLeggedDoji", "spinningTop"], mode: "same", why: "sub-jenis doji" },
  { winner: "marubozu", losers: ["beltHold"], mode: "same", why: "sub-jenis marubozu" },
  { winner: "insideBar", losers: ["doubleInsideBar"], mode: "overlap", why: "sub-jenis inside bar" },
]);

/** Induk "pola lebih besar" untuk retest: retest jadi tahap lanjutan induknya, bukan label baru. */
const RETEST_PARENTS = Object.freeze(["rectangle", "triangleAscending", "triangleDescending", "triangleSymmetric", "snrFlip"]);

const overlaps = (a, b) => a.startI <= b.endI && b.startI <= a.endI;
const nearKey = (small, big) => big.keyIdx.some((k) => Math.abs(small.endI - k) <= CFG.LOCATION_TOL_CANDLES);
const spanOf = (p) => p.endI - p.startI + 1;

function absorb(winner, loser, why) {
  winner.notes.push(`${loser.kind} (${why})`);
  // bukti yang sama (tanda + teks/kunci) tidak dihitung dua kali, supaya penyerapan tidak menggelembungkan grade
  for (const e of loser.evidence) if (!winner.evidence.some((w) => w.sign === e.sign && (w.key || w.text) === (e.key || e.text))) winner.evidence.push(e);
}

/**
 * BOS searah tren sebelumnya, CHoCH melawan. Pola yang salah label dibuang (tidak bisa bersamaan).
 * Tanpa trendBefore (null / "range") -> tidak sah, karena BOS/CHoCH butuh tren yang jelas.
 */
function validBosChoch(p) {
  if (p.kind !== "bos" && p.kind !== "choch") return true;
  if (p.trendBefore !== "up" && p.trendBefore !== "down") return false;
  const withTrend = (p.trendBefore === "up" && p.dir === DIR.BULL) || (p.trendBefore === "down" && p.dir === DIR.BEAR);
  return p.kind === "bos" ? withTrend : !withTrend;
}

/**
 * Terapkan aturan prioritas ke daftar kandidat. Murni: tidak mengubah input.
 * @returns {{kept:object[], absorbed:{kind:string, into:string, reason:string}[], dropped:{kind:string, reason:string}[]}}
 */
function resolvePatterns(input, atrLast = null) {
  let list = input.map((p) => ({ ...p, evidence: [...p.evidence], notes: [...p.notes], keyIdx: [...p.keyIdx] }));
  const absorbed = [];
  const dropped = [];

  // a. BOS / CHoCH: arah tren sebelum tembus menentukan label.
  list = list.filter((p) => {
    if (validBosChoch(p)) return true;
    dropped.push({ kind: p.kind, reason: "BOS/CHoCH tidak sesuai arah tren sebelumnya (atau tren belum jelas)" });
    return false;
  });

  // b. Order block hanya bila ada BOS searah yang mendahuluinya (OB lalu impuls yang menembus swing).
  list = list.filter((p) => {
    if (p.kind !== "orderBlock") return true;
    const ok = list.some((b) => b.kind === "bos" && b.dir === p.dir && b.endI >= p.endI && b.endI - p.endI <= CFG.OB_BOS_MAX_GAP);
    if (!ok) dropped.push({ kind: p.kind, reason: "order block tanpa BOS searah" });
    return ok;
  });

  // c. Retest menjadi tahap lanjutan pola induk.
  const retests = list.filter((p) => p.kind === "breakoutRetest");
  for (const r of retests) {
    const parent = list.find((p) => RETEST_PARENTS.includes(p.kind) && overlaps(p, r));
    if (parent) {
      parent.stage = "retest";
      absorb(parent, r, "retest = tahap lanjutan pola induk");
      absorbed.push({ kind: r.kind, into: parent.kind, reason: "retest = tahap lanjutan pola induk" });
      list = list.filter((p) => p !== r);
    }
  }

  // d. Tabel prioritas spesifik.
  for (const rule of PRIORITY_RULES) {
    const winners = list.filter((p) => p.kind === rule.winner);
    for (const w of winners) {
      for (const loserKind of rule.losers) {
        const losers = list.filter((p) => p.kind === loserKind && p !== w);
        for (const l of losers) {
          const hit = rule.mode === "same" ? l.endI === w.endI : overlaps(l, w);
          if (!hit) continue;
          absorb(w, l, rule.why);
          absorbed.push({ kind: l.kind, into: w.kind, reason: rule.why });
          list = list.filter((p) => p !== l);
        }
      }
    }
  }

  // e. Pola lebih besar (lebih banyak candle) menang atas candlestick di lokasi yang sama; candlestick jadi bukti tambahan.
  const bigs = list.filter((p) => p.family !== FAMILY.CANDLE && p.family !== FAMILY.ZONE && p.family !== FAMILY.STRUCTURE);
  for (const c of list.filter((p) => p.family === FAMILY.CANDLE)) {
    const big = bigs.find((b) => spanOf(b) > spanOf(c) && nearKey(c, b));
    if (!big) continue;
    absorb(big, c, "candlestick di lokasi pola lebih besar");
    absorbed.push({ kind: c.kind, into: big.kind, reason: "pola lebih besar menang; candlestick jadi bukti tambahan" });
    list = list.filter((p) => p !== c);
  }

  // f. Duplikat sejenis (kind + arah sama, rentang beririsan): sisakan yang grade-nya lebih tinggi, lalu yang lebih baru.
  for (const p of list) p.grade = gradeOf(p, atrLast);
  const kept = [];
  for (const p of list) {
    const dupIdx = kept.findIndex((k) => k.kind === p.kind && k.dir === p.dir && overlaps(k, p));
    if (dupIdx < 0) {
      kept.push(p);
      continue;
    }
    const k = kept[dupIdx];
    const better = GRADE_RANK[p.grade] > GRADE_RANK[k.grade] || (GRADE_RANK[p.grade] === GRADE_RANK[k.grade] && p.endI > k.endI);
    const [win, lose] = better ? [p, k] : [k, p];
    kept[dupIdx] = win;
    dropped.push({ kind: lose.kind, reason: "duplikat episode yang sama" });
  }

  // Grade dihitung ulang karena bukti bertambah setelah penyerapan.
  for (const p of kept) p.grade = gradeOf(p, atrLast);
  return { kept, absorbed, dropped };
}

// ------------------------------------------------------------------
// 5. Histeresis
// ------------------------------------------------------------------

/**
 * Status stabil dari riwayat status per candle closed (lama -> baru), fungsi murni tanpa state.
 * Status baru dianggap berlaku setelah bertahan HYST_BARS candle berturut-turut. INVALIDATED bersifat final.
 * Hanya HYST_WINDOW candle terakhir yang diputar ulang.
 */
function stableStatus(history, bars = CFG.HYST_BARS, windowN = CFG.HYST_WINDOW) {
  const h = history.slice(-windowN);
  if (!h.length) return null;
  let stable = h[0];
  let run = 1;
  for (let i = 1; i < h.length; i++) {
    if (stable === STATUS.INVALIDATED) break;
    if (h[i] === h[i - 1]) run++;
    else run = 1;
    if (h[i] !== stable && run >= bars) stable = h[i];
  }
  return stable;
}

// ------------------------------------------------------------------
// 6. Dedupe alarm
// ------------------------------------------------------------------

/** Kunci dedupe per koin + TF + pola + arah + jangkar waktu + status (status berubah = layak diberitahu lagi). */
function dedupeKey(symbol, tf, p, candles) {
  const anchor = candles?.[p.endI]?.t ?? p.endI;
  return [symbol, tf, p.kind, p.dir, anchor, p.status].join("|");
}

/** @returns {object[]} pola yang belum pernah dikirim; `seen` (Set) diperbarui. */
function filterNew(patterns, seen, symbol, tf, candles) {
  const fresh = [];
  for (const p of patterns) {
    const k = dedupeKey(symbol, tf, p, candles);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(p);
  }
  return fresh;
}

// ------------------------------------------------------------------
// 7. Format keluaran (Bagian 7) + kejujuran (Bagian 12)
// ------------------------------------------------------------------

const DISCLAIMER = "Skenario bersyarat, bukan ramalan. Edukasi, bukan saran investasi.";
const HEURISTIC_NOTE = "Ambang dan bobot masih heuristik, belum tervalidasi backtest.";

const fmtPrice = (v, dp) => fmtPriceExact(v, dp); // tanpa pembulatan; pemisah desimal titik (lihat utils/priceFormat.js)

/**
 * Teks keluaran satu pola. Statistik historis (kalau ada) hanya tampil bila N >= STATS_MIN_N, dan selalu menyertakan N + periode.
 * @param {object} p pola dari makePattern/resolvePatterns
 * @param {{title?:string, label?:string, stats?:{n:number, periode:string, text:string}, heuristic?:boolean, dp?:number}} [opts] dp = presisi koin (coinDecimals)
 */
function formatPattern(p, opts = {}) {
  const fmtP = (v) => fmtPrice(v, opts.dp);
  const lines = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`${opts.label || p.kind} (grade: ${p.grade || gradeOf(p)}) - ${STATUS_LABEL[p.status]}${p.stage ? ` (${p.stage})` : ""}`);
  lines.push(`Konfirmasi: ${fmtP(p.confirmLevel)} | Batal: ${fmtP(p.invalidLevel)}`);
  for (const e of p.evidence) if (e.sign === "+" || e.sign === "-") lines.push(`[${e.sign}] ${e.text}`);
  for (const n of p.notes) lines.push(`(+ ${n})`);
  lines.push("");
  const dirWord = p.dir === DIR.BEAR ? "di atas" : p.dir === DIR.BULL ? "di bawah" : "melewati";
  lines.push(`> Batal jika close kembali ${dirWord} ${fmtP(p.invalidLevel)}`);
  if (isNum(p.target)) {
    lines.push(`> Target ukuran pola: ${fmtP(p.target)}`);
    lines.push("> Catatan: konfirmasi datang setelah sebagian gerakan terjadi; hitung target dan risk/reward dari titik konfirmasi, bukan dari puncaknya.");
  }
  if (opts.stats) {
    if (opts.stats.n >= CFG.STATS_MIN_N) lines.push(`Statistik historis: ${opts.stats.text} (N=${opts.stats.n}, ${opts.stats.periode})`);
    else lines.push(`Statistik historis: sampel belum cukup (N=${opts.stats.n} < ${CFG.STATS_MIN_N}), tidak ditampilkan.`);
  }
  if (opts.heuristic !== false) lines.push(HEURISTIC_NOTE);
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

module.exports = {
  CFG,
  NO_DATA,
  STATUS,
  STATUS_LABEL,
  GRADE,
  DIR,
  FAMILY,
  PRIORITY_RULES,
  RETEST_PARENTS,
  prepare,
  makePattern,
  gradeOf,
  validBosChoch,
  resolvePatterns,
  stableStatus,
  dedupeKey,
  filterNew,
  formatPattern,
};
