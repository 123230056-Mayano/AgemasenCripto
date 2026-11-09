"use strict";

/**
 * features/kripto/mstructAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm market structure (!alertmstruct). Tanpa fetch, tanpa membaca store, tanpa kirim pesan,
 * jadi bisa diuji unit.
 *
 * Lima jenis kejadian, semuanya dari candle CLOSED dan memakai engine yang sama dengan !mstrut (mstrutCore.js):
 *   bos   : close pertama melewati swing high/low terakhir SEARAH tren (kelanjutan)
 *   choch : close pertama melewati swing high/low terakhir BERLAWANAN tren (tren berbalik)
 *   mss   : CHoCH yang didahului sweep likuiditas sisi yang sesuai + ditembus candle displacement
 *   bsl   : sweep Buy-Side Liquidity  (wick menembus swing high / EQH, close kembali di bawahnya)
 *   ssl   : sweep Sell-Side Liquidity (wick menembus swing low  / EQL, close kembali di atasnya)
 *
 * Kejadian dikabari hanya bila terjadi di candle closed TERAKHIR (k === n-1). Hasil analyzeStructure pada candle ke-k
 * tidak berubah ketika candle sesudahnya masuk (tanpa lookahead), jadi kejadian yang sama selalu bernilai sama
 * dan kunci dedupe cukup mencegah kiriman ganda.
 *
 * Satu CHoCH yang memenuhi syarat MSS dilaporkan sebagai MSS kalau langganan memilih `mss`, selain itu sebagai CHoCH
 * (kalau `choch` dipilih). Tidak pernah dua pesan untuk satu penembusan.
 *
 * Konfigurasi: config/indicatorConfig.js -> MSTRUCT_ALERT_CONFIG (alarm) dan MSTRUT_CONFIG (aturan struktur).
 */

const { t } = require("../../i18n");
const { MSTRUCT_ALERT_CONFIG: MA } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");
const { analyzeStructure } = require("./mstrutCore");

// Urutan tetap untuk menampilkan jenis. Tanpa kata kunci = semuanya.
const KINDS = ["bos", "choch", "mss", "bsl", "ssl"];
const DEFAULT_KINDS = [...KINDS];

// =====================================================================
// 1. Deteksi
// =====================================================================
/**
 * Kejadian struktur di candle closed TERAKHIR.
 * @param {object[]} closed candle closed urut lama -> baru
 * @param {object} [opts] override konfigurasi struktur (untuk uji)
 * @returns {{type:"bos"|"choch"|"mss"|"bsl"|"ssl", dir?:"bull"|"bear", side?:"BSL"|"SSL", level:number, close:number,
 *            refT?:number, bodyAtr?:number|null, sweepLevel?:number|null, wick?:number, eq?:boolean, canMss?:boolean}[]}
 */
function detectMstruct(closed, opts = {}) {
  if (!closed || !closed.length) return [];
  const a = analyzeStructure(closed, opts);
  if (!a) return [];
  const last = a.n - 1;
  const out = [];
  for (const e of a.allEvents) {
    if (e.k !== last || e.initial) continue; // "initial" = tembusan pertama saat tren belum ada: bukan BOS/CHoCH yang bermakna
    if (e.kind === "BOS") out.push({ type: "bos", dir: e.dir, level: e.level, close: e.close, refT: e.refT, bodyAtr: e.bodyAtr });
    else out.push({ type: e.mss ? "mss" : "choch", canMss: !!e.mss, dir: e.dir, level: e.level, close: e.close, refT: e.refT, bodyAtr: e.bodyAtr, sweepLevel: e.sweepBefore?.level ?? null });
  }
  for (const s of a.allSweeps) {
    if (s.k !== last) continue;
    out.push({ type: s.side === "BSL" ? "bsl" : "ssl", side: s.side, level: s.level, close: s.close, wick: s.wick, eq: !!s.eq });
  }
  return out;
}

/**
 * Saring kejadian sesuai jenis langganan. CHoCH yang memenuhi syarat MSS: jadi MSS kalau `mss` dipilih, kalau tidak
 * jadi CHoCH (kalau `choch` dipilih), kalau tidak dibuang.
 * @param {object[]} events hasil detectMstruct
 * @param {string[]} kinds subset KINDS
 */
function filterByKinds(events, kinds) {
  const want = new Set(kinds);
  const out = [];
  for (const ev of events) {
    if (ev.type === "bos" || ev.type === "bsl" || ev.type === "ssl") {
      if (want.has(ev.type)) out.push(ev);
    } else if (ev.type === "mss") {
      if (want.has("mss")) out.push(ev);
      else if (want.has("choch")) out.push({ ...ev, type: "choch" });
    } else if (ev.type === "choch" && want.has("choch")) out.push(ev);
  }
  return out;
}

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/** candleT = waktu BUKA candle yang dinilai. `which` = arah (bull/bear) untuk BOS/CHoCH/MSS, sisi (BSL/SSL) untuk sweep. */
const mstructKey = (chat, userJid, coin, tf, type, which, candleT) => ["mstruct", chat, userJid, coin, tf, type, which, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const KIND_TOKENS = {
  bos: ["bos"],
  choch: ["choch"],
  mss: ["mss"],
  bsl: ["bsl"],
  ssl: ["ssl"],
  sweep: ["bsl", "ssl"],
  sapu: ["bsl", "ssl"],
  liquidity: ["bsl", "ssl"],
  likuiditas: ["bsl", "ssl"],
};
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertmstruct <koin|pair|watchlist> [tf] [bos] [choch] [mss] [bsl] [ssl] [sweep]
 * !alertmstruct list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseMstructArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?m?(\d{1,6})$/);
    return m ? { action: "delete", id: `m${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  const picked = new Set();
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (KIND_TOKENS[low]) KIND_TOKENS[low].forEach((k) => picked.add(k));
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const kinds = picked.size ? KINDS.filter((k) => picked.has(k)) : [...DEFAULT_KINDS]; // urutan tetap, tanpa duplikat
  return { action: "create", coin, tf: tf || defaultTf, kinds };
}

// =====================================================================
// 4. Teks pesan
// =====================================================================
const fmt = () => require("./market");

/** Satu baris per kejadian (konfirmasi). */
function buildLine(lang, ev) {
  const { fmtLevel } = fmt();
  const which = ev.dir || ev.side;
  const vars = {
    coin: ev.coin,
    tf: TF_LABEL[ev.tf] || ev.tf,
    level: fmtLevel(ev.level),
    close: fmtLevel(ev.close),
    wick: Number.isFinite(ev.wick) ? fmtLevel(ev.wick) : "-",
    body: Number.isFinite(ev.bodyAtr) ? ev.bodyAtr.toFixed(1) : "-",
    sweep: Number.isFinite(ev.sweepLevel) ? fmtLevel(ev.sweepLevel) : "-",
    eq: ev.eq ? t(lang, ev.side === "BSL" ? "mstructalert.eqh" : "mstructalert.eql") : "",
  };
  return t(lang, `mstructalert.line.${ev.type}.${which}`, vars);
}

const TYPE_ORDER = { mss: 0, choch: 1, bos: 2, bsl: 3, ssl: 4 };

/** TF besar dulu, lalu koin, lalu MSS > CHoCH > BOS > sweep. */
function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort((a, b) => rank(a.tf) - rank(b.tf) || a.coin.localeCompare(b.coin) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = MA.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Teks satu pesan alarm. ms = waktu evaluasi. */
function buildMstructText(lang, events, { ms, part = 1, parts = 1 }) {
  const lines = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, "mstructalert.head", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${lines.join("\n")}\n\n${t(lang, "mstructalert.foot")}`;
}

/** Ringkasan satu langganan untuk !alertmstruct list / pesan konfirmasi. */
function describeMstruct(lang, sub) {
  const all = sub.kinds.length === KINDS.length;
  return all ? t(lang, "mstructalert.kind.all") : sub.kinds.map((k) => t(lang, `mstructalert.kind.${k}`)).join(" + ");
}

module.exports = {
  MA,
  KINDS,
  DEFAULT_KINDS,
  detectMstruct,
  filterByKinds,
  mstructKey,
  parseMstructArgs,
  buildLine,
  buildMstructText,
  sortEvents,
  chunk,
  describeMstruct,
};
