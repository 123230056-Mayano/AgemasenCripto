"use strict";

/**
 * features/kripto/fibbCore.js
 * ------------------------------------------------------------------
 * Logika MURNI Fibo + Bollinger (!fibb dan !alertfibb): hitung swing Fibonacci (sama dengan !fib), Bollinger Bands,
 * konfluens keduanya, deteksi BUY / SELL area, kunci dedupe, parser command, dan teks pesan alarm.
 * Tanpa fetch, tanpa store, tanpa kirim pesan.
 *
 * Aturan (candle CLOSED terakhir = X):
 *   BUY area  : tren naik (swing low -> swing high), close X di zona retracement, low X menyentuh pita BAWAH
 *               (toleransi TOUCH_ATR x ATR) dan close X kembali di dalam pita (close >= pita bawah).
 *   SELL area : tren turun (swing high -> swing low), close X di zona retracement, high X menyentuh pita ATAS
 *               dan close X kembali di dalam pita (close <= pita atas).
 *   Zona retracement default 0.382 - 0.786; opsi `golden` = 0.5 - 0.618.
 *   Konfluens = level retracement fib yang berimpit dengan pita yang disentuh (selisih <= CONFLUENCE_ATR x ATR).
 *               Opsi `kuat` mewajibkan konfluens.
 *   "Baru"    : sekarang memenuhi syarat DAN candle closed sebelumnya (dengan swing/pita yang dihitung ulang) tidak.
 * Semua angka di config/indicatorConfig.js -> FIBB_CONFIG (default sistem, belum di-backtest).
 */

const { t } = require("../../i18n");
const { FIBB_CONFIG: CFG, FIBB_ALERT_CONFIG: ACFG } = require("../../config/indicatorConfig");
const { TF_MS, TF_ORDER, TF_LABEL, COIN_WATCHLIST, fmtCandleTime } = require("./divAlertCore");
const { sma, bollinger, percentileOfLast } = require("./farleyCore");
const { atr } = require("./indicators");

const DIRS = ["buy", "sell"];

// =====================================================================
// 1. Analisis
// =====================================================================
/** Bollinger (period, k dari config) sejajar indeks candle. */
function bollingerSeries(candles) {
  const closes = candles.map((c) => c.c);
  return bollinger(closes, CFG.BB_PERIOD, CFG.BB_K, sma(closes, CFG.BB_PERIOD));
}

const zoneOf = (golden) => (golden ? [CFG.GOLDEN_MIN, CFG.GOLDEN_MAX] : [CFG.ZONE_MIN, CFG.ZONE_MAX]);

/**
 * Level retracement fib yang berimpit dengan pita Bollinger (upper / mid / lower) terakhir.
 * @returns {{ratio:number, fibPrice:number, band:"upper"|"mid"|"lower", bandPrice:number, dist:number}[]} terdekat dulu
 */
function confluences(fib, bands, atrNow) {
  if (!fib || !bands || !(atrNow > 0)) return [];
  const tol = CFG.CONFLUENCE_ATR * atrNow;
  const out = [];
  for (const lv of fib.retracement) {
    if (!CFG.CONFLUENCE_RATIOS.includes(lv.ratio)) continue;
    for (const band of ["upper", "mid", "lower"]) {
      const bp = bands[band];
      if (bp == null) continue;
      const dist = Math.abs(lv.price - bp);
      if (dist <= tol) out.push({ ratio: lv.ratio, fibPrice: lv.price, band, bandPrice: bp, dist });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * Analisis lengkap dari candle closed (urut lama -> baru). Candle terakhir = X.
 * @param {object[]} closed
 * @param {{golden?:boolean, strong?:boolean}} [opts]
 * @returns {null | {
 *   status: "buy"|"sell"|"zone"|"outside"|"none",
 *   fib: object|null, bb: object, price:number, depth:number|null, zone:[number,number], atr:number|null,
 *   bands: {upper,mid,lower,pctB,bandwidth,bwPct}|null,
 *   touch: "lower"|"upper"|null, conf: object|null, confs: object[]
 * }}  null = candle terlalu sedikit
 */
function evalFibb(closed, { golden = false, strong = false } = {}) {
  if (!closed || closed.length < CFG.MIN_CANDLES) return null;
  const i = closed.length - 1;
  const X = closed[i];
  const bb = bollingerSeries(closed);
  const zone = zoneOf(golden);
  const atrNow = atr(closed)[i];
  const bands =
    bb.upper[i] == null
      ? null
      : { upper: bb.upper[i], mid: bb.mid[i], lower: bb.lower[i], pctB: bb.pctB[i], bandwidth: bb.bandwidth[i], bwPct: percentileOfLast(bb.bandwidth, CFG.BW_LOOKBACK) };
  const { computeFib, retraceDepth } = require("./fib");
  const fib = computeFib(closed);
  const base = { fib, bb, price: X.c, depth: null, zone, atr: atrNow, bands, touch: null, conf: null, confs: [] };
  if (!fib || !bands) return { ...base, status: "none" };

  const depth = retraceDepth(fib, X.c);
  const up = fib.trend === "up";
  const inZone = depth >= zone[0] && depth <= zone[1];
  const touchTol = CFG.TOUCH_ATR * (atrNow || 0);
  let touch = null;
  if (inZone) {
    if (up && X.l <= bands.lower + touchTol && X.c >= bands.lower) touch = "lower";
    else if (!up && X.h >= bands.upper - touchTol && X.c <= bands.upper) touch = "upper";
  }
  const confs = confluences(fib, bands, atrNow);
  const conf = touch ? confs.find((c) => c.band === touch) || null : null;
  const res = { ...base, depth, touch, conf, confs };
  if (touch && (!strong || conf)) return { ...res, status: up ? "buy" : "sell" };
  return { ...res, status: inZone ? "zone" : "outside" };
}

const qualifies = (ev, sub) => !!ev && (ev.status === "buy" || ev.status === "sell") && sub.dirs.includes(ev.status);

/** @returns {{dir:"buy"|"sell"}|null} */
function detectNewFibb(cur, prev, sub) {
  if (!qualifies(cur, sub)) return null;
  if (qualifies(prev, sub) && prev.status === cur.status) return null; // sinyal arah sama sudah berjalan
  return { dir: cur.status };
}

/** candleT = waktu BUKA candle closed yang dinilai. Satu alarm per penerima + koin + TF + arah + candle. */
const fibbKey = (chat, userJid, coin, tf, dir, candleT) => ["fibbalert", chat, userJid, coin, tf, dir, candleT].join("|");

// =====================================================================
// 2. Parser command alarm
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { buy: "buy", long: "buy", naik: "buy", sell: "sell", short: "sell", turun: "sell" };
const GOLDEN_TOKENS = new Set(["golden", "emas"]);
const STRONG_TOKENS = new Set(["kuat", "strong", "konfluens", "confluence"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertfibb <koin|watchlist> [tf] [buy|sell] [golden] [kuat] | list | off | hapus <id|semua>
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 */
function parseFibbAlertArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?b?(\d{1,6})$/);
    return m ? { action: "delete", id: `b${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let golden = false;
  let strong = false;
  const dirs = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (GOLDEN_TOKENS.has(low)) golden = true;
    else if (STRONG_TOKENS.has(low)) strong = true;
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const picked = dirs.length ? DIRS.filter((d) => dirs.includes(d)) : [...DIRS];
  return { action: "create", coin, tf: tf || defaultTf, dirs: picked, zone: golden ? "golden" : "wide", strong };
}

// =====================================================================
// 3. Teks
// =====================================================================
const fmtM = () => require("./market");
const pct1 = (x) => (x * 100).toFixed(1);

/** "BB bawah" / "BB lower" dst. */
const bandName = (lang, band) => t(lang, `fibb.band.${band}`);

/** Satu baris konfluens: "0.618 (123) ≈ BB bawah (124)". */
function confText(lang, c) {
  const { fmtLevel } = fmtM();
  const { ratioLabel } = require("./fib");
  return t(lang, "fibb.confLine", { ratio: ratioLabel(c.ratio), fib: fmtLevel(c.fibPrice), band: bandName(lang, c.band), bandPrice: fmtLevel(c.bandPrice) });
}

/** Blok satu kejadian alarm. */
function buildBlock(lang, ev) {
  const { fmtUsd, fmtLevel } = fmtM();
  const a = ev.analysis;
  const up = a.fib.trend === "up";
  const side = ev.dir; // buy | sell
  const lastBar = ev.closed[ev.closed.length - 1];
  return t(lang, `fibbalert.block.${side}`, {
    coin: ev.coin,
    tf: TF_LABEL[ev.tf] || ev.tf,
    price: fmtUsd(ev.price),
    depth: pct1(a.depth),
    a: pct1(a.zone[0]),
    b: pct1(a.zone[1]),
    trend: t(lang, up ? "fibbalert.trend.up" : "fibbalert.trend.down", { from: fmtLevel(a.fib.start), to: fmtLevel(a.fib.end) }),
    band: fmtLevel(a.touch === "lower" ? a.bands.lower : a.bands.upper),
    extreme: fmtLevel(a.touch === "lower" ? lastBar.l : lastBar.h),
    mid: fmtLevel(a.bands.mid),
    swingEnd: fmtLevel(a.fib.end),
    swingStart: fmtLevel(a.fib.start),
    conf: a.conf ? t(lang, "fibbalert.confYes", { line: confText(lang, a.conf) }) : t(lang, "fibbalert.confNo"),
  });
}

function sortEvents(events) {
  const rank = (tf) => TF_ORDER.indexOf(tf);
  return [...events].sort((a, b) => rank(a.tf) - rank(b.tf) || a.coin.localeCompare(b.coin) || a.dir.localeCompare(b.dir));
}

function chunk(list, size = ACFG.BLOCKS_PER_MSG) {
  const out = [];
  const n = Math.max(1, size);
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** Teks satu pesan alarm. ms = waktu tutup candle. */
function buildFibbAlertText(lang, events, { ms, part = 1, parts = 1 }) {
  const blocks = sortEvents(events).map((ev) => buildBlock(lang, ev));
  const head = t(lang, "fibbalert.head", { time: fmtCandleTime(lang, ms), n: events.length });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n\n${blocks.join("\n\n")}\n\n${t(lang, "fibbalert.foot")}`;
}

/** Ringkasan satu langganan untuk list / pesan konfirmasi. */
function describeFibbAlert(lang, sub) {
  const dir = sub.dirs.length === DIRS.length ? t(lang, "fibbalert.dir.both") : t(lang, `fibbalert.dir.${sub.dirs[0]}`);
  const zone = t(lang, sub.zone === "golden" ? "fibbalert.zone.golden" : "fibbalert.zone.wide");
  return `${dir}, ${zone}${sub.strong ? ", " + t(lang, "fibbalert.strongTag") : ""}`;
}

module.exports = {
  CFG,
  ACFG,
  DIRS,
  bollingerSeries,
  zoneOf,
  confluences,
  evalFibb,
  qualifies,
  detectNewFibb,
  fibbKey,
  parseFibbAlertArgs,
  confText,
  buildBlock,
  sortEvents,
  chunk,
  buildFibbAlertText,
  describeFibbAlert,
};
