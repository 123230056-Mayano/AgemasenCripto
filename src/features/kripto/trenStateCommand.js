"use strict";

/**
 * features/kripto/trenStateCommand.js
 * ------------------------------------------------------------------
 * !trenstate <koin> [15m|1H|4H|1D|semua]  (alias: !ts, !pullback)
 * Runner + pemformat teks untuk trenState.js (logika murni). Data langsung dari Binance (market.js).
 * Teks ada di i18n id.js / en.js (kunci "trenstate.*"). Hasil = label bersyarat + alasan + level batal, bukan ramalan.
 * Blok "Trendline" (trenStateTrendline.js) = alat bantu baca arah, terutama saat RANGE / koreksi belum jelas.
 * Statistik historis dibaca dari data/trenstate-stats.json (hasil scripts/backtest-trenstate.js); disembunyikan kalau
 * berkasnya belum ada, versinya beda, atau N < TRENSTATE_CONFIG.MIN_N_SHOW.
 */

const fs = require("fs");
const path = require("path");
const { t } = require("../../i18n");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct } = require("./market");
const { htfOf } = require("./hhllContext");
const { assessTrenState, assessTrendlineOnly, STATUS, CFG } = require("./trenState");
const { lookupTrenStats } = require("./trenStateBacktest");
const { TF_LABEL: TF_NAMES } = require("./divAlertCore");
const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

const ALL_TFS = ["15M", "1H", "4H", "1D"];
const ICON = { continue: "🟢", pullback: "🔄", warn: "⚠️", reversal: "🔴", range: "↔️", correction: "🟡" };
const GRADE_KEY = { strong: "hhllalert.grade.strong", medium: "hhllalert.grade.medium", weak: "hhllalert.grade.weak" };

const STATS_FILE = process.env.TRENSTATE_STATS_FILE || path.join(__dirname, "..", "..", "..", "data", "trenstate-stats.json");
let statsCache = { mtime: -1, data: null };
/** Baca data/trenstate-stats.json (di-cache menurut waktu ubah). null kalau belum ada / rusak: blok statistik tidak ditampilkan. */
function loadStats(file = STATS_FILE) {
  try {
    const m = fs.statSync(file).mtimeMs;
    if (m !== statsCache.mtime) statsCache = { mtime: m, data: JSON.parse(fs.readFileSync(file, "utf8")) };
    return statsCache.data;
  } catch {
    return null;
  }
}

/** Teks chart (id/en) untuk renderTrenStateChart. Status tanpa ikon karena font canvas. */
function chartLabels(lang, res) {
  const k = (x) => t(lang, `trenstate.chart.${x}`);
  const status = t(lang, `trenstate.status.${res.status}`);
  const grade = res.grade ? ` (${t(lang, GRADE_KEY[res.grade])})` : "";
  return { title: k("title"), status: status + grade, cont: k("cont"), rev: k("rev"), cancel: k("cancel"), brkUp: k("brkUp"), brkDown: k("brkDown"), zone: k("zone"), foot: k("foot"), inv: k("inv"), reclaim: k("reclaim"), high: k("high"), low: k("low"), tlSup: k("tlSup"), tlRes: k("tlRes"), tlReg: k("tlReg") };
}

const gradePart = (lang, grade) => (grade ? t(lang, "trenstate.grade.part", { grade: t(lang, GRADE_KEY[grade]) }) : "");
const trendWord = (lang, tr) => t(lang, tr ? `trenstate.trend.${tr}` : "trenstate.trend.na");
const pct = (v) => Math.round(v * 100);

/** Baris bukti: yang terpenuhi dulu ([+] lanjut / [!] reversal), lalu paling banyak 3 yang belum terpenuhi ([-]). */
function evidenceLines(lang, res) {
  const htf = res.htfTf ? TF_NAMES[res.htfTf] || res.htfTf : "-";
  const on = [];
  const off = [];
  for (const e of res.evidence) {
    if (e.ok == null) continue;
    // htfWith / htfAgainst saling cermin: tampilkan satu saja supaya tidak dobel
    if (e.ok === false && (e.key === "htfWith" || e.key === "htfAgainst")) continue;
    const line = t(lang, `trenstate.ev.${e.key}.${e.ok ? "yes" : "no"}`, { htf });
    if (e.ok) on.push(`${e.side === "reversal" ? "[!]" : "[+]"} ${line}`);
    else off.push(`[-] ${line}`);
  }
  return [...on, ...off.slice(0, 3)];
}

/** Angka desimal kecil (ATR, R2) dengan koma di bahasa Indonesia. */
const num = (lang, v, d = 1) => (lang === "id" ? v.toFixed(d).replace(".", ",") : v.toFixed(d));

/**
 * Blok trendline (kosong kalau tidak ada). Informasi saja, tidak ikut menentukan status.
 * Mode swing: garis support/resistance + posisi close + condong. Mode regresi: arah, kecocokan, batas jalur.
 * @returns {string[]}
 */
function trendlineLines(lang, res) {
  const tl = res.trendline;
  if (!tl) return [];
  const out = [t(lang, "trenstate.tl.head")];
  const slopeWord = (d) => t(lang, `trenstate.tl.slope.${d}`);
  const lineTxt = (key, ln) => t(lang, key, { slope: slopeWord(ln.dir), level: fmtLevel(ln.levelNow), touches: ln.touches, derived: ln.derived ? t(lang, "trenstate.tl.derived") : "" });

  if (tl.mode === "swing") {
    if (tl.resistance) out.push(lineTxt("trenstate.tl.res", tl.resistance));
    if (tl.support) out.push(lineTxt("trenstate.tl.sup", tl.support));
    const level = tl.lean ? fmtLevel(tl.lean.level) : "-";
    const dist = tl.pos === "aboveSupport" || tl.pos === "nearSupport" ? Math.abs(tl.dSup ?? 0) : Math.abs(tl.dRes ?? 0);
    out.push(t(lang, `trenstate.tl.pos.${tl.pos}`, { level, dist: num(lang, dist) }));
  } else {
    const r = tl.regression;
    out.push(t(lang, "trenstate.tl.reg", { bars: r.bars, slope: slopeWord(r.dir), fit: t(lang, `trenstate.tl.fit.${r.fit}`), r2: num(lang, r.r2, 2) }));
    out.push(t(lang, `trenstate.tl.regpos.${tl.pos}`, { mid: fmtLevel(r.midNow), lo: fmtLevel(r.lowerNow), hi: fmtLevel(r.upperNow) }));
  }

  if (tl.breakAgainst) out.push(t(lang, `trenstate.tl.breakAgainst.${res.dir}`, { level: fmtLevel(tl.breakLevel) }));
  if (tl.lean) {
    const key = tl.lean.basis === "break" ? (tl.lean.dir === "up" ? "breakUp" : "breakDown") : tl.lean.basis === "edge" ? (tl.lean.dir === "up" ? "edgeUp" : "edgeDown") : tl.lean.dir === "up" ? "slopeUp" : "slopeDown";
    out.push(t(lang, `trenstate.tl.lean.${key}`, { level: fmtLevel(tl.lean.level) }));
  } else out.push(t(lang, "trenstate.tl.lean.none"));
  return out;
}

/** Ekor satu baris !trenstate semua: condong garis, tampil hanya saat status belum jelas (range / koreksi) atau garis lawan tren patah. */
function trendlineTail(lang, res) {
  const tl = res.trendline;
  if (!tl) return "";
  if (tl.breakAgainst) return t(lang, "trenstate.all.tl.break");
  if (res.status !== STATUS.RANGE && res.status !== STATUS.CORRECTION) return "";
  return t(lang, tl.lean ? `trenstate.all.tl.${tl.lean.dir}` : "trenstate.all.tl.none");
}

/**
 * Pesan untuk satu timeframe (tanpa baris harga; ditambah pemanggil). Pure: tidak ada jaringan.
 * @returns {string}
 */
function formatOne(lang, { coin, tf, res, stats = null }) {
  const lines = [];
  const L = res.levels;
  const dir = res.dir;
  // fase, bukti, dan level selalu milik penilaian MENTAH candle terakhir; label status di atas = status stabil (histeresis)
  const view = res.rawStatus || res.status;
  lines.push(t(lang, "trenstate.status", { icon: ICON[res.status] || "▫️", status: t(lang, `trenstate.status.${res.status}`), grade: gradePart(lang, res.grade) }));
  const htfName = res.htfTf ? TF_NAMES[res.htfTf] || res.htfTf : null;
  lines.push(
    htfName
      ? t(lang, "trenstate.origin", { trend: trendWord(lang, res.trend), htf: htfName, htfTrend: trendWord(lang, res.htfTrend) })
      : t(lang, "trenstate.origin.nohtf", { trend: trendWord(lang, res.trend) }),
  );

  // histeresis: status mentah beda dari status stabil -> jelaskan tepat di bawah label supaya detail di bawahnya tidak membingungkan
  if (!res.stable && res.pending) lines.push(t(lang, "trenstate.pending", { raw: t(lang, `trenstate.status.${res.rawStatus}`), n: res.pending.count, k: CFG.HYST_BARS }));

  // fase
  if (view === STATUS.RANGE) lines.push(t(lang, "trenstate.phase.range", { high: fmtLevel(L.rangeHigh), low: fmtLevel(L.rangeLow) }));
  else if (view === STATUS.REVERSAL) lines.push(t(lang, "trenstate.phase.reversal", { level: fmtLevel(L.invalidation) }));
  else if (view === STATUS.CONTINUE) lines.push(t(lang, "trenstate.phase.continue"));
  else lines.push(t(lang, "trenstate.phase.correction", { depth: pct(res.depth) }));

  const ev = evidenceLines(lang, res);
  if (ev.length) lines.push("", ...ev);
  if (res.unknown > 0) lines.push(t(lang, "trenstate.unknown", { n: res.unknown }));

  // trendline (alat bantu, terutama saat RANGE / koreksi belum jelas)
  const tlLines = trendlineLines(lang, res);
  if (tlLines.length) lines.push("", ...tlLines, t(lang, "trenstate.tl.note"));

  // level bersyarat
  const lv = [];
  if (view === STATUS.RANGE) lv.push(t(lang, "trenstate.range.levels", { high: fmtLevel(L.rangeHigh), low: fmtLevel(L.rangeLow) }));
  else if (view === STATUS.REVERSAL) lv.push(t(lang, `trenstate.rev.cancel.${dir}`, { level: fmtLevel(L.invalidation) }));
  else if (view === STATUS.CONTINUE) lv.push(t(lang, `trenstate.hold.${dir}`, { level: fmtLevel(L.invalidation) }));
  else {
    if (L.reclaim != null) lv.push(t(lang, `trenstate.go.${dir}`, { level: fmtLevel(L.reclaim) }));
    if (L.invalidation != null) lv.push(t(lang, `trenstate.cancel.${dir}`, { level: fmtLevel(L.invalidation) }));
    if (L.target != null) lv.push(t(lang, "trenstate.target", { target: fmtLevel(L.target) }));
  }
  if (lv.length) lines.push("", ...lv);

  if (res.stable && res.barsSince != null) lines.push("", t(lang, "trenstate.since", { n: res.barsSince }));

  // statistik historis (hanya bila ada + N cukup) atau catatan heuristik
  const hit = res.status === STATUS.RANGE ? null : lookupTrenStats(stats, { tf, status: res.status, grade: res.grade }, CFG.MIN_N_SHOW);
  lines.push("");
  if (hit) {
    lines.push(t(lang, "trenstate.stats", { tf: TF_NAMES[tf] || tf, n: hit.n, cont: Math.round(hit.cont), fail: Math.round(hit.fail), h: CFG.BT_HORIZON }));
    lines.push(t(lang, "trenstate.stats.note"));
  } else lines.push(t(lang, "trenstate.heuristic"));
  lines.push(t(lang, "trenstate.foot"));
  return lines.join("\n");
}

/** Ringkasan semua timeframe (res per TF boleh null = data belum cukup). */
function formatAll(lang, { coin, results, price, change, candlesByTf = null }) {
  const lines = [t(lang, "trenstate.all.title", { coin, price, change }), ""];
  for (const tf of ALL_TFS) {
    const res = results[tf];
    const label = TF_LABEL[tf];
    if (!res) {
      // struktur tidak bisa dinilai: tetap beri condong dari trendline kalau ada (informasi saja)
      const only = candlesByTf && candlesByTf[tf] ? assessTrendlineOnly(candlesByTf[tf]) : null;
      lines.push(t(lang, "trenstate.all.na", { tf: label }) + (only ? trendlineTail(lang, only) : ""));
      continue;
    }
    const showDepth = res.stable && res.depth != null && res.status !== STATUS.CONTINUE && res.status !== STATUS.REVERSAL;
    lines.push(
      t(lang, "trenstate.all.line", {
        icon: ICON[res.status] || "▫️",
        tf: label,
        status: t(lang, `trenstate.status.${res.status}`),
        grade: gradePart(lang, res.grade),
        trend: trendWord(lang, res.trend),
        depth: showDepth ? t(lang, "trenstate.all.depth", { depth: pct(res.depth) }) : "",
        tl: trendlineTail(lang, res),
      }),
    );
  }
  lines.push("", t(lang, "trenstate.all.hint", { coin }), t(lang, "trenstate.heuristic"), t(lang, "trenstate.foot"));
  return lines.join("\n");
}

async function runTrenState(sock, msg, { jid, lang }, { coin, tf, all }) {
  const stats = loadStats();

  if (all) {
    // 4 set candle cukup: TF besar tiap TF = salah satu dari set yang sama (15M->1H, 1H->4H, 4H->1D)
    const [tick, ...sets] = await Promise.all([fetchTicker(coin), ...ALL_TFS.map((x) => fetchCandles(coin, x).catch(() => null))]);
    const by = Object.fromEntries(ALL_TFS.map((x, i) => [x, sets[i]]));
    if (ALL_TFS.every((x) => !by[x])) throw new Error("NO_DATA");
    const results = {};
    for (const x of ALL_TFS) {
      const htf = htfOf(x);
      results[x] = by[x] ? assessTrenState(by[x], htf ? by[htf] : null, { tf: x }) : null;
    }
    await sock.sendMessage(jid, { text: formatAll(lang, { coin, results, price: fmtUsd(tick.price), change: fmtPct(tick.changePct), candlesByTf: by }) }, { quoted: msg });
    return;
  }

  const htfTf = htfOf(tf);
  const [candles, tick, htf] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin), htfTf ? fetchCandles(coin, htfTf).catch(() => null) : null]);
  const res = assessTrenState(candles, htf, { tf });
  // struktur tidak bisa dinilai: tetap tampilkan trendline / jalur regresi (saat "tidak ada pola" justru paling berguna)
  const only = res ? null : assessTrendlineOnly(candles);
  const none = t(lang, "trenstate.none", { coin, tf: TF_LABEL[tf], min: CFG.MIN_CANDLES });
  if (!res && !only) {
    await sock.sendMessage(jid, { text: none }, { quoted: msg });
    return;
  }
  const caption = res
    ? t(lang, "trenstate.title", { coin, tf: TF_LABEL[tf], price: fmtUsd(tick.price), change: fmtPct(tick.changePct) }) + "\n" + formatOne(lang, { coin, tf, res, stats })
    : [none, "", ...trendlineLines(lang, only), t(lang, "trenstate.tl.note"), "", t(lang, "trenstate.foot")].join("\n");

  // chart skenario (panah lanjut / reversal); kalau render gagal tetap kirim teks supaya fitur tidak mati
  // (tanpa status penilaian: chart hanya memuat trendline, tanpa label status / panah)
  let png = null;
  try {
    const { renderTrenStateChart } = require("./trenStateChart");
    const chartRes = res || only;
    const labels = res ? chartLabels(lang, res) : { ...chartLabels(lang, only), status: "" };
    png = renderTrenStateChart({ candles, coin, tf: TF_LABEL[tf], res: chartRes, labels });
  } catch (err) {
    console.log("[kripto] !trenstate chart gagal, kirim teks saja:", err.message);
  }
  if (!png) await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  else if (caption.length <= CAPTION_MAX) await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  else {
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
}

module.exports = { runTrenState, formatOne, formatAll, chartLabels, loadStats, trendlineLines, ALL_TFS };
