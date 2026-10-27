"use strict";

/**
 * features/kripto/patternCommand.js
 * ------------------------------------------------------------------
 * !pola <koin> [15m|1H|4H|1D|semua]  (alias: !pattern)
 * Runner + pemformat teks untuk candlePatterns.js (logika murni). Data langsung dari Binance (market.js).
 * Teks ada di i18n id.js / en.js (kunci "pola.*"). Hasil = bukti bersyarat (level konfirmasi + level batal), bukan sinyal.
 *
 * Fase 1: hanya candlestick. Satu TF = chart bukti (patternChart.js) + teks; mode semua = teks ringkas. Statistik historis belum ada
 * (Fase 4), jadi keluaran selalu memuat catatan heuristik.
 */

const { t } = require("../../i18n");
const { PATTERN_CONFIG: CFG, HHLL_CONFIG } = require("../../config/indicatorConfig");
const { computeStructure } = require("./hhllCore");
const { scanCandlePatterns } = require("./candlePatterns");
const { scanSwingPatterns, capChoch } = require("./swingPatterns");
const core = require("./patternCore");
const { STATUS, DIR } = core;

const ALL_TFS = ["15M", "1H", "4H", "1D"];
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const ICON = { bullish: "🟢", bearish: "🔴", netral: "⚪" };
const GRADE_KEY = { kuat: "hhllalert.grade.strong", sedang: "hhllalert.grade.medium", lemah: "hhllalert.grade.weak" };
const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)
const NEEDS_NEXT_CLOSE = new Set(["hangingMan", "invertedHammer"]); // konfirmasi = candle berikutnya close searah

/** Sama dengan market.fmtLevel; ditulis ulang supaya modul ini bisa diuji tanpa memuat canvas/axios. */
const fmtLevel = (p) => {
  if (typeof p !== "number" || !isFinite(p)) return "-";
  const d = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

const labelOf = (lang, p) => t(lang, `pola.kind.${p.variant || p.kind}`);
const dirKey = (p) => (p.dir === DIR.BULL ? "bullish" : p.dir === DIR.BEAR ? "bearish" : "netral");

function whenText(lang, lastI, p) {
  const n = lastI - p.endI;
  return n <= 0 ? t(lang, "pola.when.now") : t(lang, "pola.when.ago", { n });
}

/** Baris bukti: [+] / [-] dengan teks terjemahan. */
function evidenceLines(lang, p) {
  const out = [];
  for (const e of p.evidence) {
    if (e.sign !== "+" && e.sign !== "-") continue;
    const params = { ...(e.params || {}) };
    if (typeof params.level === "number") params.level = fmtLevel(params.level);
    if (params.htf) params.htf = TF_LABEL[params.htf] || params.htf;
    out.push(`[${e.sign}] ${t(lang, `pola.ev.${e.key || e.text}`, params)}`);
  }
  return out;
}

/** Keterangan pola yang diserap aturan prioritas (satu episode, satu pola). */
function absorbedLine(lang, p) {
  const kinds = [...new Set(p.notes.map((n) => String(n).split(" (")[0]))].map((k) => {
    const key = `pola.kind.${k}`;
    const txt = t(lang, key);
    return txt === key ? k : txt;
  });
  return kinds.length ? t(lang, "pola.absorbed", { kinds: kinds.join(", ") }) : null;
}

function levelLine(lang, p) {
  const confirm = fmtLevel(p.confirmLevel);
  const invalid = fmtLevel(p.invalidLevel);
  if (p.dir === DIR.NEUTRAL) {
    // netral: confirmLevel = batas atas, invalidLevel = batas bawah (tidak dipakai sebagai konfirmasi/batal)
    return t(lang, "pola.lv.neutral", { high: confirm, low: invalid });
  }
  const side = p.dir === DIR.BULL ? "bull" : "bear";
  if (p.status === STATUS.CONFIRMED) return t(lang, `pola.lv.${side}.confirmed`, { price: fmtLevel(p.confirmPrice), invalid });
  return t(lang, `pola.lv.${side}`, { confirm, invalid });
}

/**
 * Pesan untuk satu timeframe (tanpa baris harga; ditambah pemanggil). Murni: tidak ada jaringan.
 * @param {{coin:string, tf:string, res:object}} a res = hasil scanCandlePatterns (ok:true)
 */
function formatOne(lang, { res }) {
  const lines = [];
  const shown = res.patterns.slice(0, CFG.MAX_SHOW);
  if (!shown.length) lines.push(t(lang, "pola.none", { n: CFG.RECENT_BARS }));
  for (const p of shown) {
    lines.push(
      t(lang, "pola.head", {
        icon: ICON[dirKey(p)],
        label: labelOf(lang, p),
        dir: t(lang, `pola.dir.${dirKey(p)}`),
        grade: t(lang, GRADE_KEY[p.grade]),
        status: t(lang, `pola.status.${p.status}`),
      }),
    );
    lines.push(whenText(lang, res.lastI, p));
    lines.push(...evidenceLines(lang, p));
    const ab = absorbedLine(lang, p);
    if (ab) lines.push(ab);
    lines.push(levelLine(lang, p));
    if (NEEDS_NEXT_CLOSE.has(p.variant) && p.status === STATUS.CANDIDATE) lines.push(t(lang, "pola.needConfirm"));
    lines.push("");
  }
  if (res.patterns.length > shown.length) lines.push(t(lang, "pola.more", { n: res.patterns.length - shown.length }), "");
  if (res.invalidated > 0) lines.push(t(lang, "pola.hidden", { n: res.invalidated }), "");
  lines.push(t(lang, "pola.heuristic"), t(lang, "pola.foot"));
  return lines.join("\n");
}

/** Ringkasan semua timeframe (res per TF boleh null = data belum cukup). */
function formatAll(lang, { coin, results, price, change }) {
  const lines = [t(lang, "pola.all.title", { coin, price, change }), ""];
  for (const tf of ALL_TFS) {
    const res = results[tf];
    const label = TF_LABEL[tf];
    if (!res || !res.ok) {
      lines.push(t(lang, "pola.all.na", { tf: label }));
      continue;
    }
    const p = res.patterns[0];
    if (!p) {
      lines.push(t(lang, "pola.all.none", { tf: label }));
      continue;
    }
    lines.push(
      t(lang, "pola.all.line", {
        icon: ICON[dirKey(p)],
        tf: label,
        label: labelOf(lang, p),
        dir: t(lang, `pola.dir.${dirKey(p)}`),
        grade: t(lang, GRADE_KEY[p.grade]),
        status: t(lang, `pola.status.${p.status}`),
        when: whenText(lang, res.lastI, p),
      }),
    );
  }
  lines.push("", t(lang, "pola.all.hint", { coin }), t(lang, "pola.heuristic"), t(lang, "pola.foot"));
  return lines.join("\n");
}

/** Tren struktur TF besar yang SUDAH closed saat candle X (TF kecil) closed; tanpa lookahead (htfClosedAt). */
function makeHtfTrendFn(tf, htfCandles) {
  if (!htfCandles || !htfCandles.length) return null;
  const { htfClosedAt } = require("./hhllContext");
  const cache = new Map();
  return (X) => {
    const closed = htfClosedAt(htfCandles, tf, X);
    if (closed.length < HHLL_CONFIG.MIN_CANDLES) return null;
    const key = `${closed[closed.length - 1].t}|${closed.length}`;
    if (!cache.has(key)) cache.set(key, computeStructure(closed).trend);
    return cache.get(key);
  };
}

/** Gabungkan hasil candlestick (Fase 1) dan pola swing (Fase 2); aturan prioritas dijalankan ulang di atas gabungan (satu episode, satu pola). */
function mergeScans(a, b) {
  if (!a.ok) return a;
  if (!b || !b.ok) return a; // pola swing butuh lebih banyak swing; kalau belum cukup, candlestick tetap tampil
  const res = core.resolvePatterns([...a.patterns, ...b.patterns], a.atrLast);
  capChoch(res.kept);
  const rank = { kuat: 3, sedang: 2, lemah: 1 };
  const patterns = res.kept
    .filter((p) => p.status !== STATUS.INVALIDATED)
    .sort((x, y) => (y.confirmI ?? y.endI) - (x.confirmI ?? x.endI) || rank[y.grade] - rank[x.grade]);
  return { ...a, patterns, absorbed: [...a.absorbed, ...b.absorbed, ...res.absorbed], dropped: [...a.dropped, ...b.dropped, ...res.dropped], invalidated: a.invalidated + b.invalidated };
}

/** Pindai satu TF dengan level SNR (computeLevels) dan tren TF besar. Hasil ok:false bila data belum cukup. */
function scanTf(tf, candles, htfCandles) {
  const { computeLevels } = require("./market");
  const { htfOf } = require("./hhllContext");
  const htfTf = htfOf(tf);
  const htfTrendFn = makeHtfTrendFn(tf, htfCandles);
  const candle = scanCandlePatterns(candles, {
    levelsFn: (slice, price) => computeLevels(slice, price, { count: 3 }),
    htfTrendFn,
    htfTf,
  });
  const swing = scanSwingPatterns(candles, {
    levels: computeLevels(candles, candles[candles.length - 1].c, { count: 3 }),
    htfTrend: htfTrendFn ? htfTrendFn(candles[candles.length - 1]) : null,
    htfTf,
  });
  return mergeScans(candle, swing);
}

async function runPola(sock, msg, { jid, lang }, { coin, tf, all }) {
  const { fetchCandles, fetchTicker, fmtUsd, fmtPct } = require("./market");
  const { htfOf } = require("./hhllContext");

  if (all) {
    // 4 set candle cukup: TF besar tiap TF = salah satu dari set yang sama (15M->1H, 1H->4H, 4H->1D)
    const [tick, ...sets] = await Promise.all([fetchTicker(coin), ...ALL_TFS.map((x) => fetchCandles(coin, x).catch(() => null))]);
    const by = Object.fromEntries(ALL_TFS.map((x, i) => [x, sets[i]]));
    if (ALL_TFS.every((x) => !by[x])) throw new Error("NO_DATA");
    const results = {};
    for (const x of ALL_TFS) {
      const htf = htfOf(x);
      results[x] = by[x] ? scanTf(x, by[x], htf ? by[htf] : null) : null;
    }
    await sock.sendMessage(jid, { text: formatAll(lang, { coin, results, price: fmtUsd(tick.price), change: fmtPct(tick.changePct) }) }, { quoted: msg });
    return;
  }

  const htfTf = htfOf(tf);
  const [candles, tick, htf] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin), htfTf ? fetchCandles(coin, htfTf).catch(() => null) : null]);
  const res = scanTf(tf, candles, htf);
  if (!res.ok) {
    await sock.sendMessage(jid, { text: t(lang, "pola.nodata", { coin, tf: TF_LABEL[tf], min: CFG.MIN_CANDLES }) }, { quoted: msg });
    return;
  }
  const head = t(lang, "pola.title", { coin, tf: TF_LABEL[tf], price: fmtUsd(tick.price), change: fmtPct(tick.changePct) });
  const caption = head + "\n\n" + formatOne(lang, { coin, tf, res });

  // Chart bukti. Kalau render gagal (font/canvas bermasalah) tetap kirim teks supaya fitur tidak mati total.
  let png = null;
  try {
    const { renderPatternChart } = require("./patternChart");
    png = renderPatternChart({ lang, candles, coin, tf: TF_LABEL[tf], res });
  } catch (err) {
    console.log("[kripto] !pola chart gagal, kirim teks saja:", err.message);
  }

  if (!png) {
    await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  } else if (caption.length <= CAPTION_MAX) {
    await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  } else {
    // Batas caption WhatsApp 1024 karakter -> gambar (dengan judul) dan teks lengkap dikirim terpisah.
    await sock.sendMessage(jid, { image: png, caption: head }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
}

module.exports = { runPola, formatOne, formatAll, scanTf, mergeScans, makeHtfTrendFn, ALL_TFS };
