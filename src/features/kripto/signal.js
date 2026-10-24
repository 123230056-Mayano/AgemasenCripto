"use strict";

/**
 * features/kripto/signal.js
 * ------------------------------------------------------------------
 * !signal <koin> [tf|semua]  (alias !sinyal, !amd, !powerof3, !po3)
 * Skenario entry / SL / TP1 / TP2 / RR untuk 15m, 1H, 4H, 1D dalam SATU pesan ringkas, DITAMBAH kondisi
 * Accumulation / Manipulation / Distribution (AMD) tiap timeframe (amdCore.js). Satu timeframe saja -> chart AMD
 * + penjelasan fase lengkap (amd.js) dikirim lebih dulu. Command !amd lama sudah digabung ke sini.
 * Pengganti jalur lama "!analisis via Gemini" (1 TF per panggilan, tanpa sideways).
 *
 * Semua angka dihitung di backend dari candle closed + ATR + level S/R; TIDAK ada angka dari AI.
 * Arah skenario = bias per TF dari computeBias (item 07), jadi !bias dan !sinyal selalu searah:
 *   bias bullish -> skenario LONG | bearish -> SHORT | netral -> SIDEWAYS (batas range + syarat keluar)
 *
 * Susunan file:
 *   1. Konstanta (dibaca dari config/indicatorConfig.js -> SIGNAL_CONFIG)
 *   2. Fungsi murni: calcRR, pickEntry, pickStopLoss, buildDirectional, buildRange, computeScenario
 *   3. Pengumpul data (memakai collectBias dari bias.js, jadi candle & skor satu sumber)
 *   4. Format pesan + runner + parser
 *
 * Skenario = ilustrasi level dari indikator, BUKAN ajakan beli/jual.
 *
 * Changelog:
 *   v3 (2026-10-24) !amd digabung ke !signal: tiap baris TF dapat satu baris status AMD (dihitung dari candle yang sama dengan
 *                   skenario, tanpa fetch tambahan) + catatan bila arah AMD berlawanan dengan skenario; satu TF -> chart AMD.
 *   v2 (2026-10-22) Sudden Move Guard: tiap skenario LONG/SHORT dinilai suddenMove.assessEntry (status VALID / TUNGGU /
 *                   HINDARI), SL diperlebar saat volatil / di luar ekstrem sweep-wick, TP ikut kelipatan R dari risiko final, RR dihitung ulang.
 *   v1 (2026-10-17) item 08 pertama. Gaya entry (trend/retest/breakout) dan dasar SL (atr/sr)
 *                   masih opsi config karena client belum menjawab; default: ikut tren + SL ATR 1.5x.
 */

const { t } = require("../../i18n");
const { SIGNAL_CONFIG: CFG } = require("../../config/indicatorConfig");
const { computeEmas, atr: atrSeries } = require("./indicators");
const { computeOverallBias, collectBias, confidenceLevel, parseBiasArgs, BIAS_TFS } = require("./bias");
const { computeProbability, formatProbLine, formatProbBasis, PROB_VERSION } = require("./probability");
const sudden = require("./suddenMove");
const { reasonText } = require("./suddenMoveText");
const { detectAmd, CFG: AMD_CFG } = require("./amdCore");
const { computeSnr } = require("./snr");

const SIGNAL_VERSION = CFG.VERSION;
const TF_LABEL = { "15M": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const ENTRY_STYLES = ["trend", "retest", "breakout"];
const SL_MODES = ["atr", "sr"];

const isNum = (v) => typeof v === "number" && isFinite(v);

// =====================================================================
// 2. Fungsi murni
// =====================================================================

/**
 * Risk:Reward dari harga nyata. Long (sl < entry) maupun short (sl > entry) memakai rumus yang sama:
 * reward = |tp - entry|, risk = |entry - sl|. Mengembalikan null bila risk 0 / input tidak valid.
 * Dipisah sebagai fungsi sendiri supaya RR yang tampil SELALU dihitung dari entry/SL/TP final
 * (bukan dari angka konfigurasi), dan mudah diuji.
 */
function calcRR(entry, sl, tp) {
  if (![entry, sl, tp].every(isNum)) return null;
  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;
  return Math.abs(tp - entry) / risk;
}

/**
 * Tentukan entry sesuai gaya. Mengembalikan { price, kind, source, fallback }.
 *   kind:   "market" (harga sekarang) | "retest" (menunggu pullback) | "breakout" (menunggu tembus)
 *   source: "S1" | "R1" | "EMA20" | "EMA50" | null  (level acuan, untuk label)
 *   fallback: true bila gaya yang diminta tidak punya level yang layak -> kembali ke harga sekarang
 */
function pickEntry({ dir, price, atr, levels, emas }, cfg = CFG) {
  const market = { price, kind: "market", source: null, fallback: false };
  const style = cfg.ENTRY_STYLE;
  const within = (v) => isNum(v) && Math.abs(v - price) <= cfg.LEVEL_MAX_ATR * atr;
  const fallback = () => ({ ...market, fallback: style !== "trend" });

  if (style === "retest") {
    const cands = [];
    if (dir === "long") {
      if (isNum(levels?.support?.[0])) cands.push({ v: levels.support[0], source: "S1" });
      for (const p of [20, 50]) if (isNum(emas?.[p]) && emas[p] < price) cands.push({ v: emas[p], source: `EMA${p}` });
      const ok = cands.filter((c) => c.v < price && within(c.v));
      if (!ok.length) return fallback();
      const best = ok.reduce((a, b) => (b.v > a.v ? b : a)); // pullback paling dekat dari bawah
      return { price: best.v, kind: "retest", source: best.source, fallback: false };
    }
    if (isNum(levels?.resistance?.[0])) cands.push({ v: levels.resistance[0], source: "R1" });
    for (const p of [20, 50]) if (isNum(emas?.[p]) && emas[p] > price) cands.push({ v: emas[p], source: `EMA${p}` });
    const ok = cands.filter((c) => c.v > price && within(c.v));
    if (!ok.length) return fallback();
    const best = ok.reduce((a, b) => (b.v < a.v ? b : a)); // pullback paling dekat dari atas
    return { price: best.v, kind: "retest", source: best.source, fallback: false };
  }

  if (style === "breakout") {
    const buf = cfg.BREAKOUT_BUFFER_ATR * atr;
    if (dir === "long") {
      const r1 = levels?.resistance?.[0];
      if (!within(r1) || r1 <= price) return fallback();
      return { price: r1 + buf, kind: "breakout", source: "R1", fallback: false };
    }
    const s1 = levels?.support?.[0];
    if (!within(s1) || s1 >= price) return fallback();
    return { price: s1 - buf, kind: "breakout", source: "S1", fallback: false };
  }

  return market; // "trend"
}

/**
 * Tentukan SL. Mengembalikan { price, mode, fallback }.
 *   mode "atr": entry -/+ ATR_SL_MULT x ATR.
 *   mode "sr" : tepat di luar level S/R terdekat di sisi SL (+ buffer ATR). Level tidak ada / jarak
 *               di luar SL_MIN_ATR..SL_MAX_ATR -> pakai ATR dengan fallback: true.
 */
function pickStopLoss({ dir, entry, atr, levels }, cfg = CFG) {
  const sign = dir === "long" ? -1 : 1;
  const atrSl = entry + sign * cfg.ATR_SL_MULT * atr;
  if (cfg.SL_MODE !== "sr") return { price: atrSl, mode: "atr", fallback: false };

  const pool = dir === "long" ? (levels?.support || []).filter((v) => isNum(v) && v < entry) : (levels?.resistance || []).filter((v) => isNum(v) && v > entry);
  if (pool.length) {
    const nearest = dir === "long" ? Math.max(...pool) : Math.min(...pool);
    const sl = nearest + sign * cfg.SR_SL_BUFFER_ATR * atr;
    const dist = Math.abs(entry - sl);
    if (dist >= cfg.SL_MIN_ATR * atr && dist <= cfg.SL_MAX_ATR * atr) return { price: sl, mode: "sr", fallback: false };
  }
  return { price: atrSl, mode: "atr", fallback: true };
}

/**
 * Skenario LONG / SHORT lengkap: entry, SL, TP1/TP2, RR (dihitung ulang dari harga), catatan penghalang.
 * Bila `candles` diberikan, Sudden Move Guard menilai skenario (status + SL yang disesuaikan). TP tetap
 * kelipatan R yang sama dari risiko FINAL (SL dilebarkan -> TP ikut menjauh); RR selalu dihitung ulang dari entry/SL/TP final.
 * Tanpa `candles` perilaku sama seperti v1 (guard = null).
 */
function buildDirectional({ dir, price, atr, levels, emas, candles, atrSeries }, cfg = CFG) {
  const entry = pickEntry({ dir, price, atr, levels, emas }, cfg);
  const baseSl = pickStopLoss({ dir, entry: entry.price, atr, levels }, cfg);
  const sign = dir === "long" ? 1 : -1;
  const baseRisk = Math.abs(entry.price - baseSl.price);
  const baseTps = cfg.TP_RR.map((mult) => ({ price: entry.price + sign * mult * baseRisk }));

  let guard = null;
  let sl = baseSl;
  if (candles?.length && atrSeries?.length) {
    guard = sudden.assessEntry({ dir, price, entry, sl: baseSl, tps: baseTps, atr, candles, atrSeries, levels, emas, slMaxAtr: cfg.SL_MAX_ATR });
    if (guard.slWidened) sl = { ...baseSl, price: guard.sl, widened: true };
  }

  const risk = Math.abs(entry.price - sl.price);
  const finalTps = guard?.tps?.length === baseTps.length ? guard.tps : baseTps;
  const tps = finalTps.map((tp) => ({ price: tp.price, rr: calcRR(entry.price, sl.price, tp.price) }));
  // Level S/R pertama yang menghalangi jalan menuju TP1 (info jujur: TP1 mungkin sulit tercapai).
  const ahead = dir === "long" ? levels?.resistance : levels?.support;
  const tp1 = tps[0].price;
  const blocker = (ahead || []).filter((v) => isNum(v) && (dir === "long" ? v > entry.price && v < tp1 : v < entry.price && v > tp1));
  const tp1BlockedBy = blocker.length ? (dir === "long" ? Math.min(...blocker) : Math.max(...blocker)) : null;

  return {
    status: dir,
    entry,
    sl,
    tps,
    risk,
    riskPct: (risk / entry.price) * 100,
    entryDistPct: ((entry.price - price) / price) * 100,
    tp1BlockedBy,
    guard,
  };
}

/**
 * Skenario SIDEWAYS: batas atas/bawah range dari RANGE_LOOKBACK candle closed terakhir
 * + kondisi keluar range (berdasarkan CLOSE candle TF itu, bukan sumbu/wick).
 */
function buildRange({ price, atr, candles }, cfg = CFG) {
  const slice = candles.slice(-cfg.RANGE_LOOKBACK);
  const upper = Math.max(...slice.map((c) => c.h));
  const lower = Math.min(...slice.map((c) => c.l));
  const width = upper - lower;
  const outside = price > upper ? "above" : price < lower ? "below" : null;
  const posPct = width > 0 ? Math.max(0, Math.min(100, ((price - lower) / width) * 100)) : 50;
  return {
    status: "range",
    upper,
    lower,
    widthPct: lower > 0 ? (width / lower) * 100 : 0,
    narrow: width < cfg.RANGE_MIN_ATR * atr,
    posPct,
    outside,
    candlesUsed: slice.length,
  };
}

/**
 * Skenario satu TF (murni, tanpa I/O).
 * @param {{ bias: {bias:string, score:number, confidence:number, insufficient?:boolean}|null,
 *           price: number, atr: number|null, levels: {resistance:number[], support:number[]},
 *           emas: Record<number, number|null>, candles: object[] }} input
 * @returns {object} { status: "long"|"short"|"range"|"nodata", ... }
 */
function computeScenario(input, cfg = CFG) {
  const { bias, price, atr, levels, emas, candles, atrSeries } = input;
  if (!bias || bias.insufficient || !isNum(price) || !isNum(atr) || atr <= 0 || !candles?.length) return { status: "nodata" };
  if (bias.bias === "bullish") return buildDirectional({ dir: "long", price, atr, levels, emas, candles, atrSeries }, cfg);
  if (bias.bias === "bearish") return buildDirectional({ dir: "short", price, atr, levels, emas, candles, atrSeries }, cfg);
  return buildRange({ price, atr, candles }, cfg);
}

// =====================================================================
// 3. Pengumpul data (I/O)
// =====================================================================

/**
 * Skenario semua TF yang diminta untuk satu koin. Skor bias = collectBias (sama persis dengan !bias),
 * candle yang sama dipakai untuk ATR dan level S/R, jadi tidak ada fetch tambahan.
 * TF gagal -> { tf, bias: null, scenario: {status:"nodata"}, err }, tidak menggagalkan TF lain.
 * ctx.skipAmd = true -> AMD tidak dihitung (dipakai !signal all, yang hanya butuh status skenario).
 */
async function collectSignal(coin, tfs, ctx) {
  const { computeLevels } = require("./market");
  const rows = await collectBias(coin, tfs, ctx);
  return rows.map((r) => {
    if (!r.result || !r.candles) return { tf: r.tf, bias: null, limited: false, scenario: { status: "nodata" }, amd: null, err: r.err };
    const candles = r.candles;
    const atrAll = atrSeries(candles);
    const atr = atrAll.at(-1);
    const levels = computeLevels(candles, ctx.tick.price);
    const emas = computeEmas(candles).latest;
    const scenario = computeScenario({ bias: r.result, price: ctx.tick.price, atr, levels, emas, candles, atrSeries: atrAll });
    // AMD dari candle yang sama; gagal dihitung tidak boleh menggagalkan skenario sinyal.
    let amd = null;
    try {
      amd = !ctx.skipAmd && candles.length >= AMD_CFG.MIN_CANDLES ? detectAmd(candles, { computeSnr }) : null;
    } catch (err) {
      console.log(`[kripto] AMD ${coin} ${r.tf} gagal dihitung:`, err.message);
    }
    return { tf: r.tf, bias: r.result, limited: r.limited, scenario, amd, err: undefined };
  });
}

// =====================================================================
// 4. Format pesan, runner, parser
// =====================================================================
const fmtScore = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const fmtSignedPct = (v) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}%`;
const fmtRR = (v) => (v == null ? "-" : v.toFixed(2).replace(/\.?0+$/, ""));

function entryLabel(lang, entry) {
  if (entry.kind === "market") return t(lang, "sinyal.entry.market");
  return t(lang, `sinyal.entry.${entry.kind}`, { src: entry.source });
}

const STATUS_ICON = { VALID: "✅", TUNGGU: "⏳", HINDARI: "⛔" };

/** Baris status entri + alasan + saran tindak lanjut. Kosong bila skenario tidak dinilai guard. */
function formatGuardLines(lang, sc, tf) {
  const g = sc.guard;
  if (!g) return [];
  const { fmtLevel } = require("./market");
  const label = t(lang, `sudden.status.${g.status}`);
  const head = g.status === "VALID" && g.conditional ? t(lang, "sudden.statusConditional", { label }) : label;
  const out = [`${STATUS_ICON[g.status]} ${t(lang, "sudden.line.status", { status: head })}`];
  for (const r of g.reasons) out.push(`↳ ${reasonText(lang, r)}`);
  if (g.status === "TUNGGU") {
    if (g.confirmAt != null) {
      out.push(`↳ ${t(lang, sc.status === "long" ? "sudden.advice.confirmAbove" : "sudden.advice.confirmBelow", { lvl: fmtLevel(g.confirmAt), tf: TF_LABEL[tf] || tf })}`);
    }
    if (g.pullback) out.push(`↳ ${t(lang, "sudden.advice.pullback", { src: g.pullback.source, lvl: fmtLevel(g.pullback.price) })}`);
  }
  if (g.status === "VALID" && g.conditional) out.push(`↳ ${t(lang, "sudden.advice.conditional", { sl: fmtLevel(sc.sl.price) })}`);
  if (g.status !== "HINDARI") out.push(`↳ ${t(lang, "sudden.advice.invalid", { sl: fmtLevel(sc.sl.price), tf: TF_LABEL[tf] || tf })}`);
  return out;
}

/**
 * Satu baris ringkas status AMD satu TF (detail lengkap + chart: !signal <koin> <tf>).
 * @returns {string|null} null bila AMD tidak dihitung (data kurang / baris dari alarm).
 */
function formatAmdLine(lang, amd) {
  if (!amd) return null;
  const { fmtLevel } = require("./market");
  if (amd.phase === "none") return t(lang, "sinyal.amd.none");
  const dirKey = amd.dir === "bullish" ? "bull" : "bear";
  if (amd.phase === "accumulation") {
    return t(lang, "sinyal.amd.accumulation", { lo: fmtLevel(amd.range.lo), hi: fmtLevel(amd.range.hi), bars: amd.range.bars });
  }
  const vars = {
    extreme: fmtLevel(amd.sweep.extreme),
    level: amd.level ? fmtLevel(amd.level.price) : "-",
    ago: amd.barsSince,
  };
  return t(lang, `sinyal.amd.${amd.phase}.${dirKey}`, vars);
}

/** Skenario LONG/SHORT yang berlawanan dengan arah AMD yang sedang berjalan (manipulasi / distribusi). */
function amdConflicts(sc, amd) {
  if (!amd || (amd.phase !== "manipulation" && amd.phase !== "distribution")) return false;
  return (sc.status === "long" && amd.dir === "bearish") || (sc.status === "short" && amd.dir === "bullish");
}

function formatTfBlock(lang, row, ctx) {
  const { fmtLevel } = require("./market");
  const tf = TF_LABEL[row.tf];
  const sc = row.scenario;
  if (sc.status === "nodata") return `*${tf}* ⚪ ${t(lang, "sinyal.nodata")}`;

  const biasTag = `${t(lang, `bias.label.${row.bias.bias}`)} ${fmtScore(row.bias.score)} · ${t(lang, `bias.conf.${confidenceLevel(row.bias.confidence)}`)}`;

  const prob = computeProbability(row.bias);
  const probLine = prob ? t(lang, "prob.tfLine", { line: formatProbLine(lang, prob) }) : null;

  if (sc.status === "range") {
    const lines = [
      `*${tf}* ⚪ SIDEWAYS | ${biasTag}`,
      ...(probLine ? [probLine] : []),
      t(lang, "sinyal.range.bounds", { lo: fmtLevel(sc.lower), hi: fmtLevel(sc.upper), pos: Math.round(sc.posPct) }),
      t(lang, "sinyal.range.exit", { tf, hi: fmtLevel(sc.upper), lo: fmtLevel(sc.lower) }),
    ];
    if (sc.outside) lines.push(t(lang, `sinyal.range.outside.${sc.outside}`, { tf }));
    if (sc.narrow) lines.push(t(lang, "sinyal.range.narrow"));
    const amdRange = ctx.amdLine === false ? null : formatAmdLine(lang, row.amd);
    if (amdRange) lines.push(amdRange);
    return lines.join("\n");
  }

  const isLong = sc.status === "long";
  const lines = [
    `*${tf}* ${isLong ? "🟢 LONG" : "🔴 SHORT"} | ${biasTag}`,
    ...(probLine ? [probLine] : []),
    t(lang, "sinyal.line.entrySl", {
      entry: fmtLevel(sc.entry.price),
      elabel: entryLabel(lang, sc.entry),
      sl: fmtLevel(sc.sl.price),
      slPct: fmtSignedPct(((sc.sl.price - sc.entry.price) / sc.entry.price) * 100),
    }),
    t(lang, "sinyal.line.tp", {
      tp1: fmtLevel(sc.tps[0].price),
      rr1: fmtRR(sc.tps[0].rr),
      tp2: fmtLevel(sc.tps[1].price),
      rr2: fmtRR(sc.tps[1].rr),
    }),
  ];
  const guardLines = formatGuardLines(lang, sc, row.tf);
  const notes = [];
  if (sc.entry.kind !== "market") notes.push(t(lang, "sinyal.note.entryDist", { pct: fmtSignedPct(sc.entryDistPct) }));
  if (sc.entry.fallback) notes.push(t(lang, "sinyal.note.entryFallback"));
  if (sc.sl.fallback) notes.push(t(lang, "sinyal.note.slFallback"));
  if (sc.tp1BlockedBy != null) notes.push(t(lang, "sinyal.note.tp1Blocked", { lvl: fmtLevel(sc.tp1BlockedBy) }));
  if (ctx.overall && !ctx.overall.insufficient && ctx.overall.bias !== "netral" && ctx.overall.bias !== row.bias.bias) {
    notes.push(t(lang, "sinyal.note.counter"));
  }
  if (notes.length) lines.push(...notes.map((n) => `↳ ${n}`));
  lines.push(...guardLines);
  const amdDir = ctx.amdLine === false ? null : formatAmdLine(lang, row.amd);
  if (amdDir) {
    lines.push(amdDir);
    if (amdConflicts(sc, row.amd)) lines.push(`↳ ${t(lang, "sinyal.amd.conflict")}`);
  }
  return lines.join("\n");
}

function formatSignal(lang, { coin, price, rows, overall, failedAny, limitedAny, amdLine = true }) {
  const parts = [t(lang, "sinyal.head", { coin, ver: SIGNAL_VERSION, price })];
  if (overall && !overall.insufficient) {
    parts.push(
      t(lang, "bias.overall.line", {
        bias: t(lang, `bias.label.${overall.bias}`),
        score: fmtScore(overall.score),
        conf: t(lang, `bias.conf.${confidenceLevel(overall.confidence)}`),
      }),
    );
  }
  const overallProb = overall && !overall.insufficient ? computeProbability(overall) : null;
  if (overallProb) {
    parts.push(t(lang, "prob.overallLine", { ver: PROB_VERSION, line: formatProbLine(lang, overallProb), basis: formatProbBasis(lang, overallProb) }));
  }
  parts.push(
    t(lang, "sinyal.style", {
      entry: t(lang, `sinyal.styleName.${CFG.ENTRY_STYLE}`),
      sl: CFG.SL_MODE === "sr" ? t(lang, "sinyal.slName.sr") : t(lang, "sinyal.slName.atr", { mult: CFG.ATR_SL_MULT }),
      tp: CFG.TP_RR.map((r) => `${r}R`).join(" / "),
    }),
    "",
  );
  const ctx = { overall, amdLine };
  parts.push(rows.map((r) => formatTfBlock(lang, r, ctx)).join("\n\n"));

  const notes = [];
  if (limitedAny) notes.push(t(lang, "bias.note.limited"));
  if (failedAny) notes.push(t(lang, "bias.note.failed"));
  if (rows.some((r) => r.bias && !r.bias.insufficient)) notes.push(t(lang, "prob.note"));
  notes.push(t(lang, "sinyal.note.method"));
  if (amdLine && rows.some((r) => r.amd)) notes.push(t(lang, rows.length > 1 ? "sinyal.note.amdMulti" : "sinyal.note.amd"));
  if (rows.some((r) => r.scenario?.guard)) notes.push(t(lang, "sudden.note.method"));
  parts.push("", ...notes, "", t(lang, "sinyal.disclaimer"));
  return parts.join("\n");
}

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

/**
 * Chart AMD + penjelasan fase lengkap (isi lama !amd) untuk SATU timeframe.
 * @returns {Promise<boolean>} true kalau terkirim. Pola belum ada / render gagal -> false (baris ringkas di pesan sinyal tetap ada).
 */
async function sendAmdDetail(sock, msg, { jid, lang }, { coin, row, tick }) {
  const { buildPhaseText, renderAmdChart } = require("./amd");
  const { TF_LABEL: MKT_TF, fetchCandles, fmtUsd, fmtPct } = require("./market");
  const st = row.amd;
  if (!st || st.phase === "none") return false;

  const candles = row.candles || (await fetchCandles(coin, row.tf));
  const caption = t(lang, "amd.body", {
    coin,
    tf: MKT_TF[row.tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    phase: buildPhaseText(lang, st, candles, row.tf, tick.price),
    minBars: AMD_CFG.RANGE_MIN_BARS,
    maxAtr: AMD_CFG.RANGE_MAX_ATR,
    confirmBars: AMD_CFG.CONFIRM_BARS,
  });

  // Render gagal (font/canvas bermasalah) -> tetap kirim versi teks supaya detail AMD tidak hilang.
  let png = null;
  try {
    png = renderAmdChart({ candles, coin, tf: MKT_TF[row.tf], st });
  } catch (err) {
    console.log("[kripto] !signal chart AMD gagal, kirim teks saja:", err.message);
  }
  if (!png) await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  else if (caption.length <= CAPTION_MAX) await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  else {
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
  return true;
}

/**
 * !signal <koin> [tf|semua] (juga !sinyal, !amd, !powerof3, !po3). Tanpa Gemini.
 * TF gagal ditandai, tidak menggagalkan seluruh perintah.
 * Satu TF: chart AMD + penjelasan fase dikirim dulu, lalu skenario sinyal (tanpa baris AMD ringkas, sudah ada di chart).
 * Banyak TF: satu pesan, tiap TF berisi skenario + satu baris AMD.
 */
async function runSinyal(sock, msg, ctx, { coin, tfs, allCoins }) {
  if (allCoins) return require("./signalAll").runSinyalAll(sock, msg, ctx, { tfs }); // !signal all [tf...] -> signalAll.js
  const { jid, lang } = ctx;
  const { fetchTicker, fmtUsd, UnsupportedCoinError } = require("./market");
  const stat = require("./statistik");

  const tick = await fetchTicker(coin); // koin tidak dikenal -> UnsupportedCoinError (ditangani handler)

  if (tfs.some((tf) => !stat.isSnapshotWarm(tf))) {
    await sock.sendMessage(jid, { text: t(lang, "sinyal.scanning", { coin }) }, { quoted: msg });
  }

  const rows = await collectSignal(coin, tfs, { lang, tick });
  const ok = rows.filter((r) => r.bias);
  if (!ok.length) {
    const e = rows.find((r) => r.err)?.err;
    if (e instanceof UnsupportedCoinError) throw e;
    throw e || new Error("SINYAL_FAILED");
  }

  // Satu TF: detail AMD (chart) dulu. Kalau gagal dikirim, baris ringkas tetap ditampilkan di pesan sinyal.
  let amdSent = false;
  if (rows.length === 1 && rows[0].bias) {
    try {
      amdSent = await sendAmdDetail(sock, msg, ctx, { coin, row: rows[0], tick });
    } catch (err) {
      console.log("[kripto] !signal detail AMD gagal:", err.message);
    }
  }

  const overall = ok.length > 1 ? computeOverallBias(rows.map((r) => ({ tf: r.tf, result: r.bias }))) : null;
  const text = formatSignal(lang, {
    coin,
    price: fmtUsd(tick.price),
    rows,
    overall,
    failedAny: rows.some((r) => !r.bias),
    limitedAny: ok.some((r) => r.limited),
    amdLine: !amdSent,
  });
  await sock.sendMessage(jid, { text }, amdSent ? undefined : { quoted: msg });
}

// !amd / !powerof3 / !po3 (command lama) sekarang masuk ke sini: satu command untuk skenario sinyal + kondisi AMD.
const SIGNAL_COMMANDS = { sinyal: { re: /^!(?:sinyal|signal|amd|powerof3|po3)(?:\s+([\s\S]*))?$/i } };

/**
 * Format argumen:
 *   satu koin : sama persis dengan !bias -> "btc" | "btc 4h" | "btc semua" | "4h btc"
 *   semua koin: tanpa koin, pakai "all"/"semua" -> { allCoins: true, tfs }
 *               "all"        -> semua koin, semua timeframe
 *               "all 4h"     -> semua koin, hanya 4H   (juga "4h all", "all 1h 4h")
 */
function parseSignalArgs(name, raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const ups = tokens.map((x) => x.toUpperCase());
  const hasAll = ups.includes("ALL") || ups.includes("SEMUA");
  const rest = ups.filter((x) => x !== "ALL" && x !== "SEMUA");
  if (hasAll && rest.length && rest.every((x) => BIAS_TFS.includes(x))) {
    const tfs = BIAS_TFS.filter((x) => rest.includes(x)); // urutan tampil tetap 15m, 1H, 4H, 1D
    return { allCoins: true, tfs };
  }
  if (hasAll && !rest.length && ups.filter((x) => x === "ALL" || x === "SEMUA").length === 1) {
    return { allCoins: true, tfs: [...BIAS_TFS] };
  }
  return parseBiasArgs(name, raw);
}

const SIGNAL_RUNNERS = { sinyal: runSinyal };

module.exports = {
  SIGNAL_VERSION,
  ENTRY_STYLES,
  SL_MODES,
  SIGNAL_COMMANDS,
  SIGNAL_RUNNERS,
  parseSignalArgs,
  calcRR,
  pickEntry,
  pickStopLoss,
  buildDirectional,
  buildRange,
  computeScenario,
  collectSignal,
  formatSignal,
  formatTfBlock,
  formatGuardLines,
  formatAmdLine,
  amdConflicts,
  sendAmdDetail,
};
