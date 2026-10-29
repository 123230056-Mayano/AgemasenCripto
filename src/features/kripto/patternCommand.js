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
const { PATTERN_CONFIG: CFG, HHLL_CONFIG, GAUSSIAN_CONFIG: GCFG } = require("../../config/indicatorConfig");
const { computeStructure } = require("./hhllCore");
const { scanCandlePatterns } = require("./candlePatterns");
const { scanSwingPatterns, capChoch } = require("./swingPatterns");
const core = require("./patternCore");
const { buildTrendline, trendlineStatus } = require("./patternTrendline");
const { htfSummary, labelPatterns } = require("./htfPriority");
const { trendStrength } = require("./trendStrength");
const { estimateGaussian } = require("./gaussian");
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

/** Baris arah TF besar di atas hasil satu TF (kosong bila tidak ada TF besar, mis. 1D). */
function htfHeadLine(lang, htf) {
  if (!htf || htf.state === "none") return null;
  return t(lang, `pola.htf.${htf.state}`, { htf: TF_LABEL[htf.tf] || htf.tf });
}

/** Label prioritas satu pola (null = pola berarah netral / tidak ada TF besar). */
function priorityLine(lang, p, htf) {
  if (!p.priority || !htf || !htf.tf) return null;
  return t(lang, `pola.prio.${p.priority}`, { htf: TF_LABEL[htf.tf] || htf.tf });
}

/** Angka desimal kecil dengan koma di bahasa Indonesia. */
const numTxt = (lang, v, d = 1) => (lang === "id" ? v.toFixed(d).replace(".", ",") : v.toFixed(d));

/** Kata tingkat kekuatan (kunci i18n) dan arah. */
const STR_LEVEL_KEY = { strong: "pola.str.level.strong", medium: "pola.str.level.medium", weak: "pola.str.level.weak" };

/** Satu baris alasan [+] / [-] untuk satu komponen kekuatan tren (null = tidak bisa dinilai, tidak ditampilkan). */
function strengthReason(lang, it, st) {
  if (it.ok == null) return null;
  const sign = it.ok ? "+" : "-";
  const yn = it.ok ? "yes" : "no";
  const d = st.dir === "up" ? "up" : "down";
  let key;
  let params = {};
  switch (it.key) {
    case "swing":
      key = `pola.str.ev.swing.${d}.${yn}`;
      params = { n: it.value };
      break;
    case "slope":
      key = `pola.str.ev.slope.${yn}`;
      params = { atr: numTxt(lang, it.value ?? 0, 2) };
      break;
    case "r2":
      key = `pola.str.ev.r2.${yn}`;
      params = { r2: numTxt(lang, it.value ?? 0, 2) };
      break;
    case "candles":
      key = `pola.str.ev.candles.${d}.${yn}`;
      params = { n: it.value.count, of: it.value.of };
      break;
    case "retrace":
      if (it.value == null) key = "pola.str.ev.broken";
      else {
        key = `pola.str.ev.retrace.${yn}`;
        params = { pct: Math.round(it.value * 100) };
      }
      break;
    case "volume":
      key = `pola.str.ev.volume.${yn}`;
      params = { x: numTxt(lang, it.value ?? 0, 1) };
      break;
    case "htf":
      key = `pola.str.ev.htf.${yn}`;
      params = { htf: TF_LABEL[st.htfTf] || st.htfTf, dir: t(lang, `pola.str.dir.${d}`) };
      break;
    default:
      return null;
  }
  return `[${sign}] ${t(lang, key, params)}`;
}

/**
 * Blok "Kekuatan tren" untuk satu TF: tingkat KUAT / SEDANG / LEMAH + alasan [+] / [-]. Tanpa persen. Informasi saja:
 * tidak mengubah grade / status pola. Kosong bila hasil tidak ada (gagal hitung).
 * @returns {string[]}
 */
function strengthBlock(lang, tf, st) {
  if (!st) return [];
  const label = TF_LABEL[tf] || tf;
  if (st.state === "range") return [t(lang, "pola.str.range", { tf: label })];
  if (st.state !== "ok") return [t(lang, "pola.str.nodata", { tf: label })];
  const out = [t(lang, "pola.str.head", { tf: label, level: t(lang, STR_LEVEL_KEY[st.level]), dir: t(lang, `pola.str.dir.${st.dir}`) })];
  for (const it of st.items) {
    const line = strengthReason(lang, it, st);
    if (line) out.push(line);
  }
  if (st.capped) out.push(t(lang, "pola.str.capped"));
  out.push(t(lang, "pola.str.note"));
  return out;
}

/** Satu baris ringkas kekuatan tren untuk mode semua TF (kosong bila data belum cukup). */
function strengthLine(lang, st) {
  if (!st || st.state === "nodata") return null;
  if (st.state === "range") return "   " + t(lang, "pola.str.all.range");
  return "   " + t(lang, "pola.str.all.line", { level: t(lang, STR_LEVEL_KEY[st.level]), dir: t(lang, `pola.str.dir.${st.dir}`) });
}

/**
 * Blok trendline untuk satu TF (kosong bila tidak ada). Informasi saja: tidak mengubah grade / status pola.
 * Status: garis utuh / dekat garis / baru tembus; tanpa garis swing valid = jalur regresi cadangan.
 * @returns {string[]}
 */
function trendlineBlock(lang, res) {
  const tl = res && res.trendline;
  const st = trendlineStatus(tl);
  if (!st) return [];
  const out = [t(lang, "pola.tl.head")];
  const slopeWord = (d) => t(lang, `trenstate.tl.slope.${d}`);
  const lineTxt = (key, ln) => t(lang, key, { slope: slopeWord(ln.dir), level: fmtLevel(ln.levelNow), touches: ln.touches, derived: ln.derived ? t(lang, "trenstate.tl.derived") : "" });
  if (st.kind === "regression") {
    const r = tl.regression;
    out.push(t(lang, "pola.tl.reg", { bars: r.bars, slope: slopeWord(r.dir), fit: t(lang, `trenstate.tl.fit.${r.fit}`), r2: numTxt(lang, r.r2, 2) }));
  } else {
    if (tl.resistance) out.push(lineTxt("pola.tl.res", tl.resistance));
    if (tl.support) out.push(lineTxt("pola.tl.sup", tl.support));
    const key = st.kind === "intact" ? "pola.tl.st.intact" : st.kind === "near" ? `pola.tl.st.near.${st.side}` : `pola.tl.st.broke.${st.side}`;
    out.push(t(lang, key, { dist: numTxt(lang, st.dist ?? 0), level: fmtLevel(st.level) }));
  }
  out.push(t(lang, "pola.tl.note"));
  return out;
}

/** Lama horizon dalam teks ("24 jam", "6 hari"), dari jumlah candle x lama satu TF. */
const TF_MIN = { "15M": 15, "1H": 60, "4H": 240, "1D": 1440 };
function spanText(lang, tf, h) {
  const mins = (TF_MIN[tf] || 0) * h;
  if (!mins) return String(h);
  if (mins < 60) return t(lang, "pola.gs.span.m", { n: mins });
  const hours = mins / 60;
  if (hours >= 48) return t(lang, "pola.gs.span.d", { n: Math.round(hours / 24) });
  return t(lang, "pola.gs.span.h", { n: Math.round(hours) });
}

/**
 * Kesimpulan satu baris untuk blok sebaran: terjemahan angka yang sudah ada ke bahasa awam. Bukan prediksi.
 * - gerak wajar = setengah lebar rentang ~68% terhadap harga sekarang (+/- %)
 * - kecenderungan = dari peluang naik historis (55-100 = condong naik, 0-45 = condong turun, sisanya seimbang)
 */
function gaussianConclusion(lang, tf, g, up) {
  const pct = ((g.range1.hi - g.range1.lo) / 2 / g.last) * 100;
  const move = pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
  const lean = up >= 65 ? "up2" : up >= 55 ? "up1" : up <= 35 ? "down2" : up <= 45 ? "down1" : "flat";
  const key = g.fatTail ? "pola.gs.sum.fat" : "pola.gs.sum";
  return t(lang, key, { span: spanText(lang, tf, g.h), move, lean: t(lang, `pola.gs.lean.${lean}`) });
}

/**
 * Blok "Estimasi sebaran harga" (Fitur 4) untuk satu TF. Informasi saja: tidak mengubah grade / status pola.
 * Data kurang -> tulis "data belum cukup", TANPA angka. Ekor tebal -> rentang dari sebaran riil ikut ditampilkan.
 * @returns {string[]}
 */
function gaussianBlock(lang, tf, g) {
  if (!g) return [];
  if (!g.ok) return [t(lang, "pola.gs.nodata", { n: g.n ?? 0, min: g.minN ?? GCFG.MIN_N }), t(lang, "pola.gs.note")];
  const up = Math.round(g.pUp * 100);
  const out = [
    t(lang, "pola.gs.head", { h: g.h, span: spanText(lang, tf, g.h) }),
    t(lang, "pola.gs.data", { candles: g.window, n: g.n }),
    t(lang, "pola.gs.dir", { up, down: 100 - up }),
    t(lang, "pola.gs.r68", { lo: fmtLevel(g.range1.lo), hi: fmtLevel(g.range1.hi) }),
    t(lang, "pola.gs.r95", { lo: fmtLevel(g.range2.lo), hi: fmtLevel(g.range2.hi) }),
  ];
  out.push(gaussianConclusion(lang, tf, g, up));
  if (g.fatTail) out.push(t(lang, "pola.gs.fat", { lo68: fmtLevel(g.emp1.lo), hi68: fmtLevel(g.emp1.hi), lo95: fmtLevel(g.emp2.lo), hi95: fmtLevel(g.emp2.hi) }));
  out.push(t(lang, "pola.gs.note"));
  return out;
}

/**
 * Pesan untuk satu timeframe (tanpa baris harga; ditambah pemanggil). Murni: tidak ada jaringan.
 * @param {{coin:string, tf:string, res:object}} a res = hasil scanCandlePatterns (ok:true)
 */
function formatOne(lang, { tf, res }) {
  const lines = [];
  const shown = res.patterns.slice(0, CFG.MAX_SHOW);
  const htfLine = htfHeadLine(lang, res.htf);
  if (htfLine) lines.push(htfLine, "");
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
    const pl = priorityLine(lang, p, res.htf);
    if (pl) lines.push(pl);
    lines.push(...evidenceLines(lang, p));
    const ab = absorbedLine(lang, p);
    if (ab) lines.push(ab);
    lines.push(levelLine(lang, p));
    if (NEEDS_NEXT_CLOSE.has(p.variant) && p.status === STATUS.CANDIDATE) lines.push(t(lang, "pola.needConfirm"));
    lines.push("");
  }
  if (res.patterns.length > shown.length) lines.push(t(lang, "pola.more", { n: res.patterns.length - shown.length }), "");
  if (res.invalidated > 0) lines.push(t(lang, "pola.hidden", { n: res.invalidated }), "");
  const strLines = strengthBlock(lang, tf, res.strength);
  if (strLines.length) lines.push(...strLines, "");
  const tlLines = trendlineBlock(lang, res);
  if (tlLines.length) lines.push(...tlLines, "");
  const gsLines = gaussianBlock(lang, tf, res.gauss);
  if (gsLines.length) lines.push(...gsLines, "");
  lines.push(t(lang, "pola.heuristic"), t(lang, "pola.foot"));
  return lines.join("\n");
}

/** Ringkasan semua timeframe (res per TF boleh null = data belum cukup). */
function formatAll(lang, { coin, results, price, change }) {
  const lines = [t(lang, "pola.all.title", { coin, price, change }), ""];
  // kesimpulan arah TF besar: struktur 1D (TF tertinggi); tidak tersedia = ditulis, bukan ditebak
  const top = results["1D"];
  const topState = top && top.ok && top.trend ? top.trend : "na";
  lines.push(t(lang, `pola.all.htf.${topState}`, { htf: TF_LABEL["1D"] }), "");
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
      const sl0 = strengthLine(lang, res.strength);
      if (sl0) lines.push(sl0);
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
    const pl = priorityLine(lang, p, res.htf);
    if (pl) lines.push("   " + pl);
    const sl = strengthLine(lang, res.strength);
    if (sl) lines.push(sl);
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
  const res = mergeScans(candle, swing);
  if (res.ok) {
    // Fitur 2: label prioritas dari tren TF besar yang sudah closed (tanpa lookahead). Tidak mengubah grade / status.
    const htfTrend = htfTrendFn ? htfTrendFn(candles[candles.length - 1]) : null;
    res.htf = htfSummary(htfTf, htfTrend);
    labelPatterns(res.patterns, htfTrend, !!htfTf);
  }
  // trendline = informasi tambahan (tidak mengubah grade / status pola); gagal hitung -> null, !pola tetap jalan
  if (res.ok) res.trendline = buildTrendline(candles, res.atrLast, res.trend);
  // Fitur 3: kekuatan tren (informasi saja, tidak mengubah grade / status); gagal hitung -> null, !pola tetap jalan
  if (res.ok) {
    try {
      res.strength = trendStrength(candles, htfCandles, { tf, trendline: res.trendline || undefined });
    } catch {
      res.strength = null;
    }
  }
  return res;
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
  const { fetchCandlesHistory } = require("./market");
  const [candles, tick, htf, hist] = await Promise.all([
    fetchCandles(coin, tf),
    fetchTicker(coin),
    htfTf ? fetchCandles(coin, htfTf).catch(() => null) : null,
    fetchCandlesHistory(coin, tf, { bars: GCFG.WINDOW + GCFG.HORIZON }).catch(() => null), // Fitur 4: jendela lebih panjang dari 320; gagal = pakai candle biasa
  ]);
  const res = scanTf(tf, candles, htf);
  // Fitur 4: estimasi sebaran (informasi saja); gagal hitung -> null, !pola tetap jalan
  if (res.ok) {
    try {
      res.gauss = estimateGaussian(hist && hist.length > candles.length ? hist : candles);
    } catch {
      res.gauss = null;
    }
  }
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

module.exports = { runPola, strengthBlock, trendlineBlock, gaussianBlock, formatOne, formatAll, scanTf, mergeScans, makeHtfTrendFn, ALL_TFS };
