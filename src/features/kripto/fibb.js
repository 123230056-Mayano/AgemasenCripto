"use strict";

/**
 * features/kripto/fibb.js
 * ------------------------------------------------------------------
 * !fibb <koin> [tf]  -> Fibonacci retracement/extension otomatis (swing sama dengan !fib) + Bollinger Bands (20, 2),
 * dengan pembacaan KONFLUENS: level fib yang berimpit dengan pita Bollinger, dan status BUY area / SELL area bila harga
 * ada di zona retracement dan menyentuh pita lawan arah swing (aturan lengkap di fibbCore.js).
 * Chart = candle + garis level fib + pita Bollinger. Data langsung dari Binance (market.js).
 * Alarm otomatis: !alertfibb (fibbAlertCommand.js).
 */

const { t } = require("../../i18n");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");
const { renderFibChart, buildRows, LOOKBACK } = require("./fib");
const { CFG, evalFibb, confText } = require("./fibbCore");

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

/** Gambar chart Fibo + Bollinger dari hasil evalFibb. @returns {Buffer} PNG */
function renderFibbChart(lang, { candles, coin, tf, analysis }) {
  const up = analysis.fib.trend === "up";
  return renderFibChart({
    candles,
    coin,
    tf: TF_LABEL[tf] || tf,
    fib: analysis.fib,
    bb: analysis.bb,
    title: `${coin}/USDT  ${TF_LABEL[tf] || tf}  Fibonacci + Bollinger`,
    subtitle: `Close candle only · BB(${CFG.BB_PERIOD}, ${CFG.BB_K}) · swing = highest high / lowest low of last ${LOOKBACK} candles · ${up ? "Uptrend (low → high)" : "Downtrend (high → low)"}`,
  });
}

/** Chart untuk alarm: dari candle closed + hasil evalFibb. */
const renderFibbPng = (lang, { closed, coin, tf, analysis }) => renderFibbChart(lang, { candles: closed, coin, tf, analysis });

function bandwidthNote(lang, bwPct) {
  if (bwPct == null) return "";
  if (bwPct <= CFG.BW_SQUEEZE_PCT) return t(lang, "fibb.bw.squeeze");
  if (bwPct >= CFG.BW_EXPAND_PCT) return t(lang, "fibb.bw.expand");
  return t(lang, "fibb.bw.normal");
}

function buildBandRows(lang, bands, price) {
  const row = (label, v) => `▫️ ${label}  ${fmtLevel(v)} (${fmtPct(pctFrom(price, v))})`;
  const lines = [row(t(lang, "fibb.band.upper"), bands.upper), row(t(lang, "fibb.band.mid"), bands.mid), row(t(lang, "fibb.band.lower"), bands.lower)];
  const pctB = bands.pctB == null ? "-" : bands.pctB.toFixed(2);
  lines.push(t(lang, "fibb.bandInfo", { pctB, bw: bandwidthNote(lang, bands.bwPct) }));
  return lines.join("\n");
}

function buildStatus(lang, a) {
  const { status } = a;
  if (status === "none") return t(lang, "fibb.status.none");
  const zone = { a: (a.zone[0] * 100).toFixed(1), b: (a.zone[1] * 100).toFixed(1) };
  if (status === "buy" || status === "sell") {
    const txt = t(lang, `fibb.status.${status}`, { ...zone, depth: (a.depth * 100).toFixed(1) });
    return txt + "\n" + (a.conf ? t(lang, "fibbalert.confYes", { line: confText(lang, a.conf) }) : t(lang, "fibbalert.confNo"));
  }
  if (a.depth < 0) return t(lang, "kripto.fib.beyond");
  if (a.depth > 1) return t(lang, "kripto.fib.broken");
  return t(lang, status === "zone" ? "fibb.status.zone" : "fibb.status.outside", { ...zone, depth: (a.depth * 100).toFixed(1), side: t(lang, a.fib.trend === "up" ? "fibb.side.lower" : "fibb.side.upper") });
}

async function runFibb(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const a = evalFibb(candles);
  if (!a || !a.fib || !a.bands) {
    await sock.sendMessage(jid, { text: t(lang, "kripto.fib.none", { coin, tf: TF_LABEL[tf] }) }, { quoted: msg });
    return;
  }

  const up = a.fib.trend === "up";
  const swingPct = (Math.abs(a.fib.end - a.fib.start) / a.fib.start) * 100;
  const trend = t(lang, up ? "kripto.fib.trendUp" : "kripto.fib.trendDown", { from: fmtLevel(a.fib.start), to: fmtLevel(a.fib.end), pct: swingPct.toFixed(1) });
  const confs = a.confs.slice(0, 4).map((c) => `🎯 ${confText(lang, c)}`);

  const caption = t(lang, "kripto.fibb.body", {
    coin,
    tf: TF_LABEL[tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    trend,
    bbTitle: `${CFG.BB_PERIOD}, ${CFG.BB_K}`,
    bbRows: buildBandRows(lang, a.bands, tick.price),
    rows: buildRows(lang, a.fib, tick.price),
    conf: confs.length ? confs.join("\n") : t(lang, "fibb.confNone"),
    status: buildStatus(lang, a),
  });

  // Chart gagal dibuat -> tetap kirim teks supaya fitur tidak mati total.
  let png = null;
  try {
    png = renderFibbChart(lang, { candles, coin, tf, analysis: a });
  } catch (err) {
    console.log("[kripto] !fibb chart gagal, kirim teks saja:", err.message);
  }

  if (!png) {
    await sock.sendMessage(jid, { text: caption }, { quoted: msg });
  } else if (caption.length <= CAPTION_MAX) {
    await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text: caption });
  }
}

module.exports = { runFibb, renderFibbChart, renderFibbPng };
