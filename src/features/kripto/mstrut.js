"use strict";

/**
 * features/kripto/mstrut.js
 * ------------------------------------------------------------------
 * !mstrut <koin|pair> [M15|H1|H4|D1]: analisis MARKET STRUCTURE (SMC/ICT).
 * Laporan: Trend Structure, Swing Points, Liquidity (BSL/SSL/EQH/EQL), Structure Events (BOS/CHoCH/MSS),
 * Liquidity Event (sweep), Market Assessment, ditambah blok "candle berjalan" (Unconfirmed) bila ada, dan chart.
 *
 * Alur: command -> ambil OHLCV Binance (market.js; candle berjalan ikut diambil tetapi hanya untuk status
 * Unconfirmed) -> mstrutCore.analyzeStructure (aturan tetap, bukan AI) -> teks laporan (i18n id/en) + chart.
 * Gemini / LLM TIDAK dipakai untuk menghitung level maupun menentukan hasil.
 *
 * Penulisan command: !mstrut BTCUSDT H1 / !mstrut btc 1h / !mstrut BTC/USDT m15. Forex ikut lewat adapter pasar
 * seperti !hhll (!mstrut eurusd 4h): data Yahoo, hanya candle closed (tanpa status Unconfirmed).
 */

const { t } = require("../../i18n");
const { MSTRUT_CONFIG: CFG } = require("../../config/indicatorConfig");
const { TF_LABEL, fetchCandles, pctFrom } = require("./market");
const { resolveMarket } = require("./marketAdapter");
const { resolvePair } = require("../forex/forexPairs");
const { DAILY_TZ, DAILY_TZ_LABEL } = require("./divAlertCore");
const { analyzeStructure } = require("./mstrutCore");

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

// ---------- parser ----------
/** Penulisan timeframe yang diterima -> kunci internal market.js. */
const TF_ALIASES = Object.freeze({
  M1: "1M", "1M": "1M",
  M5: "5M", "5M": "5M",
  M15: "15M", "15M": "15M",
  H1: "1H", "1H": "1H",
  H4: "4H", "4H": "4H",
  D1: "1D", "1D": "1D",
});
/** Nama timeframe gaya MetaTrader (dipakai di laporan: "Timeframe: H1"). */
const TF_SHORT = Object.freeze({ "1M": "M1", "5M": "M5", "15M": "M15", "1H": "H1", "4H": "H4", "1D": "D1" });

/**
 * "BTCUSDT H1" -> { coin: "BTC", tf: "1H" } | "btc" -> { coin: "BTC", tf: null } | "eur/usd 4h" -> { coin: "EURUSD", tf: "4H" }.
 * null kalau format salah (tidak ada simbol, simbol/timeframe dobel, karakter aneh).
 */
function parseMstrutArgs(raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  let coin = null;
  let tf = null;
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (TF_ALIASES[up]) {
      if (tf) return null;
      tf = TF_ALIASES[up];
      continue;
    }
    if (coin) return null;
    const sym = up.replace(/[/\-_]/g, ""); // "BTC/USDT", "eur-usd"
    const fx = resolvePair(sym);
    if (fx) {
      coin = fx;
      continue;
    }
    const base = sym.length > 4 && sym.endsWith("USDT") ? sym.slice(0, -4) : sym; // "BTCUSDT" -> "BTC"
    if (!/^[A-Z0-9]{1,15}$/.test(base)) return null;
    coin = base;
  }
  return coin ? { coin, tf } : null;
}

// ---------- format teks ----------
/** "12 Okt 04:00" (id) / "12 Oct 04:00" (en); 1D tanpa jam. Waktu dalam DAILY_TZ (default WIB). */
function fmtWhen(lang, ms, tf) {
  const loc = lang === "en" ? "en-GB" : "id-ID";
  const day = new Intl.DateTimeFormat(loc, { timeZone: DAILY_TZ, day: "numeric", month: "short" }).format(new Date(ms));
  if (tf === "1D") return day;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: DAILY_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return `${day} ${time} ${DAILY_TZ_LABEL}`;
}

const DIR = { bull: "Bullish", bear: "Bearish" };
const STATUS = { intact: "Intact", swept: "Swept", broken: "Broken" };
const BIAS = { bullish: "Bullish Bias", bearish: "Bearish Bias", neutral: "Neutral" };
const TREND = { up: "Bullish", down: "Bearish", range: "Sideways" };

const ageTxt = (lang, age) => (age === 0 ? t(lang, "mstrut.age.now") : t(lang, "mstrut.age.n", { n: age }));
const fmtX = (lang, v) => (lang === "id" ? v.toFixed(1).replace(".", ",") : v.toFixed(1));

/**
 * Teks laporan lengkap (tanpa jaringan, bisa diuji).
 * @param {object} p { res, pair, tf (kunci internal), price, changePct, mk (adapter pasar) }
 */
function buildReport(lang, { res, pair, tf, price, changePct, mk }) {
  const fl = (v) => mk.fmtLevel(v);
  const pct = (level) => mk.fmtPct(pctFrom(price, level));
  const when = (ms) => fmtWhen(lang, ms, tf);
  const out = [t(lang, "mstrut.title"), t(lang, "mstrut.head", { pair, tf: TF_SHORT[tf] || tf, price: mk.fmtPrice(price), change: mk.fmtPct(changePct), when: when(res.lastT) })];

  // 1. Trend Structure
  out.push("", t(lang, "mstrut.s1"), t(lang, "mstrut.trend", { trend: TREND[res.trend] || TREND.range }));
  out.push(res.structureSeq.length ? t(lang, "mstrut.structure", { seq: res.structureSeq.join(" → ") }) : t(lang, "mstrut.structure.none"));

  // 2. Swing Points
  const lab = (s) => (s.label ? ` (${s.label})` : "");
  out.push("", t(lang, "mstrut.s2"));
  out.push(t(lang, "mstrut.swing.high", { price: fl(res.lastHigh.price), lab: lab(res.lastHigh), when: when(res.lastHigh.t) }));
  out.push(t(lang, "mstrut.swing.low", { price: fl(res.lastLow.price), lab: lab(res.lastLow), when: when(res.lastLow.t) }));

  // 3. Liquidity
  const liq = res.liquidity;
  out.push("", t(lang, "mstrut.s3"));
  out.push(liq.nearestBSL ? t(lang, "mstrut.liq.bsl", { level: fl(liq.nearestBSL.level), pct: pct(liq.nearestBSL.level), status: STATUS[liq.nearestBSL.status], when: when(liq.nearestBSL.t) }) : t(lang, "mstrut.liq.bsl.none"));
  out.push(liq.nearestSSL ? t(lang, "mstrut.liq.ssl", { level: fl(liq.nearestSSL.level), pct: pct(liq.nearestSSL.level), status: STATUS[liq.nearestSSL.status], when: when(liq.nearestSSL.t) }) : t(lang, "mstrut.liq.ssl.none"));
  for (const [it, key] of [[liq.eqh, "eqh"], [liq.eql, "eql"]]) {
    out.push(it ? t(lang, `mstrut.liq.${key}`, { level: fl(it.level), n: it.members, pct: pct(it.level), status: STATUS[it.status], when: when(it.t) }) : t(lang, `mstrut.liq.${key}.none`));
  }

  // 4. Structure Events
  const ev = res.events;
  out.push("", t(lang, "mstrut.s4"));
  const evLine = (e, key) => (e ? t(lang, `mstrut.ev.${key}`, { dir: DIR[e.dir], close: fl(e.close), level: fl(e.level), when: when(e.t), age: ageTxt(lang, e.age) }) : t(lang, `mstrut.ev.${key}.none`));
  out.push(evLine(ev.bos, "bos"), evLine(ev.choch, "choch"));
  if (ev.mss) {
    out.push(t(lang, "mstrut.ev.mss", { dir: DIR[ev.mss.dir], side: ev.mss.mss.sweep.side, x: fmtX(lang, ev.mss.mss.bodyAtr), when: when(ev.mss.t), age: ageTxt(lang, ev.mss.age) }));
  } else if (ev.choch) {
    const hasSweep = !!ev.choch.sweepBefore;
    const strong = !!ev.choch.displacement;
    if (!hasSweep && !strong) out.push(t(lang, "mstrut.ev.mss.no.both"));
    else if (!hasSweep) out.push(t(lang, "mstrut.ev.mss.no.sweep"));
    else out.push(t(lang, "mstrut.ev.mss.no.disp", { x: fmtX(lang, ev.choch.bodyAtr ?? 0), need: fmtX(lang, CFG.DISPLACEMENT_ATR) }));
  } else out.push(t(lang, "mstrut.ev.mss.none"));

  // 5. Liquidity Event
  out.push("", t(lang, "mstrut.s5"));
  if (res.sweep) {
    const s = res.sweep;
    const tag = s.eq ? ` (${s.side === "BSL" ? "EQH" : "EQL"})` : "";
    out.push(t(lang, s.side === "BSL" ? "mstrut.sweep.bsl" : "mstrut.sweep.ssl", { wick: fl(s.wick), level: fl(s.level) + tag, close: fl(s.close), when: when(s.t), age: ageTxt(lang, s.age) }));
  } else out.push(t(lang, "mstrut.sweep.none"));

  // Market Assessment
  out.push("", t(lang, "mstrut.assess", { bias: BIAS[res.bias.value], why: t(lang, `mstrut.why.${res.bias.why}`) }));

  // Candle berjalan (sementara)
  const lv = res.live;
  if (lv && !lv.empty) {
    out.push("", t(lang, "mstrut.live.title", { price: fl(lv.price) }));
    if (lv.pending) out.push(t(lang, lv.pending.dir === "bull" ? "mstrut.live.break.up" : "mstrut.live.break.down", { kind: lv.pending.kind, level: fl(lv.pending.level) }));
    for (const s of lv.sweeps) out.push(t(lang, s.side === "BSL" ? "mstrut.live.sweep.bsl" : "mstrut.live.sweep.ssl", { wick: fl(s.wick), level: fl(s.level) }));
  }

  out.push("", t(lang, "mstrut.foot", { win: res.cfg.PIVOT_WIN, minPct: String(res.cfg.MIN_SWING_PCT).replace(".", lang === "id" ? "," : ".") }));
  return out.join("\n");
}

// ---------- runner ----------
async function runMstrut(sock, msg, { jid, lang }, { coin, tf }) {
  const mk = resolveMarket(coin);
  const isFx = mk.id === "forex";
  if (isFx && !mk.allowedTfs([tf]).length) {
    await sock.sendMessage(jid, { text: t(lang, "hhll.fx.tfNotAllowed", { pair: mk.symbol }) }, { quoted: msg });
    return;
  }

  // Kripto: candle berjalan ikut diambil (hanya untuk status Unconfirmed). Forex: closed saja.
  const [candles, tick] = await Promise.all([isFx ? mk.fetchCandles(tf) : fetchCandles(coin, tf, { includeOpen: true }), mk.fetchTicker()]);
  const pair = isFx ? mk.symbol : `${coin}/USDT`;
  const res = analyzeStructure(candles);
  if (!res) {
    await sock.sendMessage(jid, { text: t(lang, "mstrut.none", { coin: pair, tf: TF_SHORT[tf] || tf, min: CFG.MIN_CANDLES }) }, { quoted: msg });
    return;
  }

  let text = buildReport(lang, { res, pair, tf, price: tick.price, changePct: tick.changePct, mk });
  if (isFx) {
    const notes = [t(lang, "hhll.fx.note")];
    const status = await mk.status();
    if (!status.open) notes.unshift(t(lang, status.reason === "stale" ? "hhll.fx.stale" : "hhll.fx.closed"));
    if (mk.proxy === "futures") notes.push(t(lang, "hhll.fx.gold"));
    if (candles.slice(-15).some((k) => k.gap === true)) notes.push(t(lang, "hhll.fx.gap"));
    text += "\n\n" + notes.join("\n");
  }

  // Kalau render chart gagal, laporan teks tetap terkirim.
  let png = null;
  try {
    const { renderMstrutChart } = require("./mstrutChart");
    png = renderMstrutChart({ candles, res, title: `${pair}  ${TF_SHORT[tf] || tf}  Market Structure`, tf: TF_LABEL[tf], digits: isFx ? mk.digits : null });
  } catch (err) {
    console.log("[kripto] !mstrut chart gagal, kirim teks saja:", err.message);
  }

  if (!png) await sock.sendMessage(jid, { text }, { quoted: msg });
  else if (text.length <= CAPTION_MAX) await sock.sendMessage(jid, { image: png, caption: text }, { quoted: msg });
  else {
    // Laporan lebih panjang dari batas caption WhatsApp: gambar lebih dulu, laporan lengkap menyusul sebagai teks.
    await sock.sendMessage(jid, { image: png, caption: `📐 *${pair} · ${TF_SHORT[tf] || tf}* · Market Structure` }, { quoted: msg });
    await sock.sendMessage(jid, { text });
  }
}

module.exports = { runMstrut, buildReport, parseMstrutArgs, fmtWhen, TF_ALIASES, TF_SHORT };
