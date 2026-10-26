"use strict";

/**
 * features/kripto/dusdtAlertCore.js
 * ------------------------------------------------------------------
 * Logika MURNI alarm USDT.D masuk golden zone (!alertdusdt). Tanpa fetch, tanpa membaca store, tanpa kirim
 * pesan, jadi bisa diuji unit tanpa jaringan. Mesin yang memakainya: dusdtAlertEngine.js.
 *
 * Golden zone = area retracement Fibonacci 0.5 - 0.618 pada swing USDT.D (swing yang sama dengan !dusdt / !fib).
 * Kedalaman retracement (depth) = seberapa jauh level sekarang sudah kembali dari ujung swing:
 *   tren naik  : (high swing - level) / range      tren turun : (level - low swing) / range
 *
 * "Masuk" = sebelumnya di luar zona, sekarang di dalam. Supaya level yang bolak-balik di tepi zona tidak memicu
 * alarm berulang, zona baru dianggap ditinggalkan kalau level keluar lebih dari REARM_MARGIN dari tepinya.
 * Kalau swing Fibonacci berganti (atau status belum pernah dinilai), status hanya disinkronkan ulang tanpa alarm:
 * zona yang bergeser bukan berarti harga yang bergerak, dan kondisi yang sudah ada saat alarm dibuat tidak diumumkan.
 *
 * Konfigurasi: config/indicatorConfig.js -> DUSDT_ALERT_CONFIG.
 */

const { t } = require("../../i18n");
const { DUSDT_ALERT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_MS, TF_LABEL, fmtCandleTime } = require("./divAlertCore");

// =====================================================================
// 1. Zona & status
// =====================================================================
const isNum = (v) => typeof v === "number" && isFinite(v);

/** Kedalaman retracement level terhadap swing fib (hasil computeFib). Sama dengan retraceDepth() di fib.js. */
function depthOf(fib, level) {
  if (!fib || !isNum(level) || !(fib.range > 0)) return null;
  return fib.trend === "up" ? (fib.end - level) / fib.range : (level - fib.end) / fib.range;
}

/** Harga (persen dominasi) pada kedalaman retracement tertentu. */
const priceAtDepth = (fib, depth) => (fib.trend === "up" ? fib.end - depth * fib.range : fib.end + depth * fib.range);

/**
 * Batas golden zone dalam persen dominasi.
 * @returns {{min:number, max:number, p50:number, p618:number}|null}
 */
function goldenZone(fib, cfg = CFG) {
  if (!fib || !(fib.range > 0)) return null;
  const a = priceAtDepth(fib, cfg.ZONE_LOW);
  const b = priceAtDepth(fib, cfg.ZONE_HIGH);
  return { min: Math.min(a, b), max: Math.max(a, b), p50: a, p618: b };
}

/**
 * Penanda swing: waktu candle awal & akhir swing. Waktu (bukan indeks) dipakai karena indeks bergeser tiap candle baru.
 * Kalau candle tidak tersedia, pakai harga ujung swing.
 */
function swingKey(fib, candles) {
  if (!fib) return null;
  const a = candles?.[fib.startIdx]?.t;
  const b = candles?.[fib.endIdx]?.t;
  return isNum(a) && isNum(b) ? `${a}|${b}` : `${fib.start}|${fib.end}`;
}

/**
 * Satu langkah mesin status.
 * @param {{prevInZone:boolean|null|undefined, prevSwing:string|null|undefined, depth:number, swing:string}} s
 * @returns {{inZone:boolean, swing:string, entered:boolean, resynced:boolean}}
 */
function stepZone({ prevInZone, prevSwing, depth, swing }, cfg = CFG) {
  const inside = depth >= cfg.ZONE_LOW && depth <= cfg.ZONE_HIGH;
  // Belum pernah dinilai, atau swing berganti: catat posisi sekarang saja, tanpa alarm.
  if (prevInZone == null || prevSwing !== swing) return { inZone: inside, swing, entered: false, resynced: true };
  if (!prevInZone) return { inZone: inside, swing, entered: inside, resynced: false };
  const m = cfg.REARM_MARGIN;
  const stillNear = depth >= cfg.ZONE_LOW - m && depth <= cfg.ZONE_HIGH + m;
  return { inZone: stillNear, swing, entered: false, resynced: false };
}

// =====================================================================
// 2. Parser argumen
// =====================================================================
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * "4h" -> buat alarm; "list" / "off" / "hapus d1|semua" -> kelola. Kosong atau tidak dikenal -> null (penjelasan command).
 * @returns {{action:"create", tf:string}|{action:"list"}|{action:"deleteAll", viaOff?:boolean}|{action:"delete", id:string}|null}
 */
function parseDusdtAlertArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?d?(\d{1,6})$/);
    return m ? { action: "delete", id: `d${Number(m[1])}` } : null;
  }
  if (tokens.length !== 1) return null;
  const tf = tokens[0].toUpperCase();
  return TF_MS[tf] ? { action: "create", tf } : null;
}

// =====================================================================
// 3. Teks
// =====================================================================
const fmtDom = (v) => `${v.toFixed(3)}%`;

/** Ringkasan satu alarm untuk pesan "dibuat" dan tabel list. */
const describeDusdtAlert = (lang) => t(lang, "dusdtalert.what", { lo: CFG.ZONE_LOW, hi: CFG.ZONE_HIGH });

/**
 * Pesan alarm satu kejadian "masuk golden zone".
 * @param {string} lang
 * @param {{tf:string, level:number, depth:number, fib:object, zone:object}} ev
 * @param {{ms?:number}} [opts]
 */
function buildDusdtAlertText(lang, ev, { ms = Date.now() } = {}) {
  const { fib, zone } = ev;
  const up = fib.trend === "up";
  const swingPct = (Math.abs(fib.end - fib.start) / fib.start) * 100;
  const trend = t(lang, up ? "kripto.fib.trendUp" : "kripto.fib.trendDown", {
    from: fmtDom(fib.start),
    to: fmtDom(fib.end),
    pct: swingPct.toFixed(1),
  });
  return [
    t(lang, "dusdtalert.head", { time: fmtCandleTime(lang, ms) }),
    "",
    t(lang, "dusdtalert.line", { tf: TF_LABEL[ev.tf] || ev.tf, lo: CFG.ZONE_LOW, hi: CFG.ZONE_HIGH }),
    t(lang, "dusdtalert.level", { v: fmtDom(ev.level) }),
    t(lang, "dusdtalert.zone", { min: fmtDom(zone.min), max: fmtDom(zone.max) }),
    t(lang, "dusdtalert.depth", { pct: (ev.depth * 100).toFixed(1) }),
    trend,
    "",
    t(lang, up ? "dusdtalert.note.up" : "dusdtalert.note.down"),
    t(lang, "dusdtalert.foot"),
  ].join("\n");
}

module.exports = {
  depthOf,
  priceAtDepth,
  goldenZone,
  swingKey,
  stepZone,
  parseDusdtAlertArgs,
  describeDusdtAlert,
  buildDusdtAlertText,
};
