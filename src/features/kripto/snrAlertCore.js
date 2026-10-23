"use strict";

/**
 * features/kripto/snrAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm titik balik Support/Resistance (!alertsnr). Tanpa fetch, tanpa membaca store,
 * tanpa kirim pesan, jadi bisa diuji unit (src/test/snralert.test.js).
 *
 * Dua jenis kejadian di sebuah level S/R (hasil !snr):
 *   reject : harga menyentuh level lalu ditolak (resistance: turun lagi, support: naik lagi)
 *   break  : harga menembus level (resistance: ke atas, support: ke bawah)
 *
 * Hanya satu tahap: KONFIRMASI. Dinilai dari candle CLOSED (tidak ada sinyal dini / pembatalan).
 *
 * Level: zona dari computeSnr (snr.js) memakai candle closed SEBELUM candle yang dinilai, dengan harga acuan
 * = close candle sebelumnya, jadi level tidak berpindah sisi (R jadi S) untuk candle yang sama.
 *
 * Pita zona = harga level +-BUFFER (persen, SNR_ALERT_CONFIG.BUFFER_PCT):
 *   resistance R: break  = harga > R(1+b)           reject = high >= R(1-b) DAN harga < R(1-b)
 *   support    S: break  = harga < S(1-b)           reject = low  <= S(1+b) DAN harga > S(1+b)
 * (harga = close candle). Harga yang berhenti di dalam pita = belum ada
 * keputusan, tidak ada alarm.
 *
 * Konfigurasi: config/indicatorConfig.js -> SNR_ALERT_CONFIG.
 */

const { t } = require("../../i18n");
const { SNR_ALERT_CONFIG: SNR, SUDDEN_CONFIG } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");
const sudden = require("./suddenMove");
const { atr } = require("./indicators");

// Urutan tetap dipakai untuk menampilkan jenis. Default (tanpa kata kunci) hanya reject + break; wick dan sweep opt-in.
const KINDS = ["reject", "break", "wick", "sweep"];
const DEFAULT_KINDS = ["reject", "break"];
// Prioritas satu pesan per level per candle: yang lebih spesifik menang. Break tidak ikut disaring (maknanya berlawanan).
const KIND_PRIORITY = { sweep: 3, wick: 2, reject: 1 };

// =====================================================================
// 1. Level & deteksi
// =====================================================================
/**
 * Level yang dipantau, dihitung dari candle closed `history` (urut lama -> baru).
 * Default hanya R1 dan S1; `strong` = R1..R3 / S1..S3 yang sentuhannya >= STRONG_MIN_TOUCHES.
 * @param {object[]} history candle closed
 * @param {{strong?:boolean, computeSnr?:Function, minTouches?:number}} [opts]
 * @returns {{side:"R"|"S", rank:number, price:number, touches:number}[]}
 */
function watchedLevels(history, { strong = false, computeSnr, minTouches = SNR.STRONG_MIN_TOUCHES } = {}) {
  if (!history || history.length < SNR.MIN_CANDLES) return [];
  const compute = computeSnr || require("./snr").computeSnr;
  const ref = history[history.length - 1].c;
  const { resistance, support } = compute(history, ref, { count: 3 });
  const all = [
    ...resistance.map((z, i) => ({ side: "R", rank: i + 1, price: z.price, touches: z.touches })),
    ...support.map((z, i) => ({ side: "S", rank: i + 1, price: z.price, touches: z.touches })),
  ];
  return strong ? all.filter((l) => l.touches >= minTouches) : all.filter((l) => l.rank === 1);
}

/** "break" | "reject" | null untuk satu candle terhadap satu level. `buf` = pecahan (0.001 = 0,1%). */
function classify(candle, level, buf = SNR.BUFFER_PCT / 100) {
  const up = level.price * (1 + buf);
  const dn = level.price * (1 - buf);
  const { h, l, c } = candle;
  if (level.side === "R") {
    if (c > up) return "break";
    if (h >= dn && c < dn) return "reject";
  } else {
    if (c < dn) return "break";
    if (l <= up && c > up) return "reject";
  }
  return null;
}

/**
 * Semua kejadian satu candle terhadap daftar level.
 * @returns {{side:string, rank:number, price:number, touches:number, type:"reject"|"break", now:number, extreme:number}[]}
 *   now = close candle, extreme = high (resistance) atau low (support) candle
 */
function candleHits(candle, levels, buf) {
  const out = [];
  for (const lv of levels) {
    const type = classify(candle, lv, buf);
    if (type) out.push({ ...lv, type, now: candle.c, extreme: lv.side === "R" ? candle.h : candle.l });
  }
  return out;
}

/**
 * Kejadian wick-reject dan sweep untuk satu candle closed (suddenMove.js), terhadap level yang sama dengan reject/break.
 * `history` = candle closed SEBELUM candle yang dinilai, `X` = candle yang dinilai. ATR dari history (candle X tidak
 * ikut menaikkan pembandingnya). Sweep hanya dilaporkan bila terjadi di X sendiri (barsAgo 0): alarm tidak mengulang
 * kejadian lama. Satu level dipakai bergantian: R untuk wick/sweep bearish, S untuk bullish.
 * @param {object[]} history @param {object} X @param {{side,rank,price,touches}[]} levels
 * @param {{wick?:boolean, sweep?:boolean}} want
 * @returns {{side,rank,price,touches,type:"wick"|"sweep",now:number,extreme:number,wickPct?:number,volRatio:number|null}[]}
 */
function suddenHits(history, X, levels, want = {}) {
  const out = [];
  if (!X || !levels?.length || !(want.wick || want.sweep)) return out;
  const atrNow = atr(history).at(-1);
  const find = (side, price) => levels.find((l) => l.side === side && l.price === price);
  const asLevels = { resistance: levels.filter((l) => l.side === "R").map((l) => l.price), support: levels.filter((l) => l.side === "S").map((l) => l.price) };
  const vol = sudden.volumeSpike([...history.slice(-(SUDDEN_CONFIG.VOLUME_LOOKBACK + 1)), X]);
  const volRatio = vol?.ratio ?? null;

  if (want.wick && atrNow > 0) {
    const w = sudden.wickReject(X, asLevels, atrNow);
    const lv = w && find(w.dir === "bearish" ? "R" : "S", w.level);
    if (lv) out.push({ ...lv, type: "wick", now: X.c, extreme: w.extreme, wickPct: w.wickPct * 100, volRatio });
  }
  if (want.sweep) {
    const sw = sudden.sweep([X], asLevels); // hanya candle X (barsAgo 0)
    const lv = sw && find(sw.dir === "bearish" ? "R" : "S", sw.level);
    if (lv) out.push({ ...lv, type: "sweep", now: X.c, extreme: sw.extreme, volRatio });
  }
  return out;
}
/**
 * Satu pesan per level per candle: untuk tiap level ambil kejadian reject/wick/sweep berprioritas tertinggi
 * (sweep > wick > reject). Kejadian "break" dibiarkan. Level yang sama = side + rank.
 * @param {object[]} events kejadian satu candle (sudah termasuk type, side, rank)
 */
function prioritize(events) {
  const best = new Map();
  const keep = [];
  for (const ev of events) {
    const pr = KIND_PRIORITY[ev.type];
    if (!pr) {
      keep.push(ev);
      continue;
    }
    const k = levelId(ev);
    const cur = best.get(k);
    if (!cur || pr > KIND_PRIORITY[cur.type]) best.set(k, ev);
  }
  return [...keep, ...best.values()];
}

const levelId = (x) => `${x.side}${x.rank}`;

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/** candleT = waktu BUKA candle yang dinilai. Segmen "final" dipertahankan agar kunci lama (sudah terkirim) tetap dikenali. */
const snrKey = (chat, userJid, coin, tf, type, side, rank, candleT) => ["snr", "final", chat, userJid, coin, tf, type, `${side}${rank}`, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const KIND_TOKENS = { reject: "reject", rejected: "reject", tolak: "reject", ditolak: "reject", tembus: "break", break: "break", breakout: "break", breakdown: "break", wick: "wick", sweep: "sweep", fakeout: "sweep" };
// Kata tahap lama (dini/konfirmasi) tetap diterima dan diabaikan: alarm S/R sekarang selalu konfirmasi.
const STAGE_TOKENS = new Set(["dini", "early", "konfirmasi", "confirm", "confirmed", "final", "closed"]);
const STRONG_TOKENS = new Set(["kuat", "strong"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertsnr <koin|watchlist> [tf] [reject|tembus|wick|sweep] [kuat]
 * !alertsnr list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseSnrArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?s?(\d{1,6})$/);
    return m ? { action: "delete", id: `s${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let strong = false;
  const kinds = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (KIND_TOKENS[low]) kinds.push(KIND_TOKENS[low]);
    else if (STAGE_TOKENS.has(low)) continue;
    else if (STRONG_TOKENS.has(low)) strong = true;
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const uniq = (arr, all, dflt) => (arr.length ? all.filter((x) => arr.includes(x)) : [...dflt]); // urutan tetap, tanpa duplikat; tanpa kata kunci = default
  return { action: "create", coin, tf: tf || defaultTf, kinds: uniq(kinds, KINDS, DEFAULT_KINDS), strong };
}

// =====================================================================
// 4. Teks pesan
// =====================================================================
const fmt = () => require("./market");

/** Satu baris per kejadian (konfirmasi). */
function buildLine(lang, ev) {
  const { fmtLevel, fmtUsd } = fmt();
  const vars = {
    coin: ev.coin,
    tf: TF_LABEL[ev.tf] || ev.tf,
    rank: ev.rank,
    level: fmtLevel(ev.price),
    now: fmtUsd(ev.now),
    extreme: fmtUsd(ev.extreme),
    wick: Number.isFinite(ev.wickPct) ? Math.round(ev.wickPct) : "-",
    vol: Number.isFinite(ev.volRatio) ? t(lang, "snralert.volTxt", { x: ev.volRatio.toFixed(1) }) : "",
  };
  return t(lang, `snralert.line.${ev.type}.${ev.side}`, vars);
}

/** TF besar dulu, lalu koin, lalu resistance sebelum support. */
function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort(
    (a, b) =>
      rank(a.tf) - rank(b.tf) ||
      a.coin.localeCompare(b.coin) ||
      a.side.localeCompare(b.side) ||
      a.rank - b.rank,
  );
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = SNR.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Teks satu pesan alarm. ms = waktu evaluasi. */
function buildSnrText(lang, events, { ms, part = 1, parts = 1 }) {
  const lines = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, "snralert.head", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${lines.join("\n")}\n\n${t(lang, "snralert.foot")}`;
}

/** Ringkasan satu langganan untuk !alertsnr list / pesan konfirmasi. */
function describeSnr(lang, sub) {
  const kinds = sub.kinds.map((x) => t(lang, `snralert.kind.${x}`)).join(" + ");
  const levels = t(lang, sub.strong ? "snralert.levels.strong" : "snralert.levels.near");
  return `${kinds}, ${levels}`;
}

module.exports = {
  SNR,
  KINDS,
  DEFAULT_KINDS,
  KIND_PRIORITY,
  suddenHits,
  prioritize,
  watchedLevels,
  classify,
  candleHits,
  levelId,
  snrKey,
  parseSnrArgs,
  buildLine,
  buildSnrText,
  sortEvents,
  chunk,
  describeSnr,
};
