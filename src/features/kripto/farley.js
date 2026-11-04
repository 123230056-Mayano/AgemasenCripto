"use strict";

/**
 * features/kripto/farley.js
 * ------------------------------------------------------------------
 * !farley <koin|pair> [tf] : analisis pendekatan Alan S. Farley (ribbon SMA 5-8-13 + Bollinger 13,2 + Stochastic + MACD TF besar)
 * -> status BUY / SELL / TUNGGU / RANGE + entry, SL, TP1, TP2 + kondisi dan alasan. Hanya candle closed.
 * Logika murni di farleyCore.js, teks di farleyText.js, gambar di farleyChart.js (candle + ribbon + Bollinger + Stochastic + zona SL/TP). Alarm otomatis: !alertfarley (farleyAlert*.js).
 *
 * FOREX: pair dikenali otomatis lewat adapter pasar (marketAdapter.js -> forex/forexMarket.js): !farley eurusd 4h, !farley eur/usd,
 * !farley xauusd (alias !fxfarley). Perhitungan inti SAMA dengan kripto; yang berbeda hanya data (Yahoo, tanpa volume), level S/R
 * (toleransi 0,2%), format harga (digits pair), SL/TP dalam pip, TF 15m ditolak untuk USDIDR, dan pasar tutup (akhir pekan / data
 * macet) menurunkan BUY / SELL menjadi TUNGGU. Kripto tidak berubah.
 */

const { t } = require("../../i18n");
const { TF_LABEL, computeLevels, fmtUsd } = require("./market");
const { TF_MS } = require("./divAlertCore");
const { resolveMarket } = require("./marketAdapter");
const { computeFarley, ctxTfOf, closedContext, applyMarketClosed } = require("./farleyCore");
const { buildFarleyBlock, buildFarleyFooter, chartLabels } = require("./farleyText");
const { renderFarleyChart } = require("./farleyChart");

const CAPTION_MAX = 1000; // batas aman caption gambar WhatsApp (1024)

/**
 * Hitung skenario Farley dari candle mentah (membuang candle yang belum closed). Dipakai !farley dan engine alarm.
 * @param {object[]} candles candle TF utama
 * @param {object[]|null} ctxRaw candle TF konteks (null = tidak tersedia)
 * @param {string} tf
 * @param {object|null} [market] adapter pasar forex (level S/R dengan toleransi forex); null = kripto seperti sebelumnya
 * @returns {{sc:object, closed:object[], ctxTf:string|null}}
 */
function analyze(candles, ctxRaw, tf, market = null) {
  const closed = (candles || []).filter((c) => c.closed !== false);
  const ctxTf = ctxTfOf(tf);
  const X = closed[closed.length - 1];
  let ctxCandles = null;
  let ctxSelf = false;
  if (X) {
    if (ctxTf) ctxCandles = closedContext(ctxRaw, X.t + TF_MS[tf], TF_MS[ctxTf]);
    else {
      ctxCandles = closed; // 1D: tidak ada TF lebih besar, konteks dari TF sendiri (diberi label)
      ctxSelf = true;
    }
  }
  const price = X ? X.c : null;
  const levelsOf = market && market.computeLevels ? (c, p) => market.computeLevels(c, p) : computeLevels;
  const levels = price != null && closed.length >= 20 ? levelsOf(closed, price) : { resistance: [], support: [] };
  const sc = computeFarley(closed, { ctxCandles, ctxTf: ctxTf || tf, ctxSelf, levels });
  return { sc, closed, ctxTf };
}

/**
 * Chart Farley (PNG) dari candle closed + skenario. Dipakai !farley dan alarm !alertfarley.
 * @param {string} lang
 * @param {{closed:object[], coin:string, tf:string, sc:object, market?:object|null}} p market = adapter forex (null = kripto)
 * @returns {Buffer}
 */
function renderFarleyPng(lang, { closed, coin, tf, sc, market = null }) {
  return renderFarleyChart({ candles: closed, coin, tf: TF_LABEL[tf] || tf, sc, labels: chartLabels(lang, sc), market });
}

async function runFarley(sock, msg, { jid, lang }, { coin, tf }) {
  // Adapter pasar: pair forex dikenali lebih dulu (eurusd, eur/usd, xauusd), selain itu kripto persis seperti sebelumnya.
  const mk = resolveMarket(coin);
  const isFx = mk.id === "forex";

  // TF yang tidak boleh dipakai pair ini (USDIDR: mulai 1H). Ditolak tanpa mengambil data.
  if (isFx && !mk.allowedTfs([tf]).length) {
    await sock.sendMessage(jid, { text: t(lang, "farley.fx.tfNotAllowed", { pair: mk.symbol }) }, { quoted: msg });
    return;
  }

  const ctxTf = ctxTfOf(tf);
  const [candles, tick, ctxRaw] = await Promise.all([
    mk.fetchCandles(tf),
    mk.fetchTicker(),
    ctxTf && mk.allowedTfs([ctxTf]).length ? mk.fetchCandles(ctxTf).catch(() => null) : null,
  ]);
  const market = isFx ? mk : null;
  const analyzed = analyze(candles, ctxRaw, tf, market);
  const { closed } = analyzed;
  // Forex: pasar tutup / data macet -> BUY / SELL diturunkan jadi TUNGGU (rencana entry tidak bisa dieksekusi).
  const status = isFx ? await mk.status() : null;
  const sc = isFx ? applyMarketClosed(analyzed.sc, status) : analyzed.sc;
  const price = isFx ? mk.fmtPrice(tick.price) : fmtUsd(tick.price);
  const block = buildFarleyBlock(lang, { coin: mk.symbol, tf, tfLabel: TF_LABEL[tf], price, sc, market });
  const gap = isFx && closed.slice(-15).some((k) => k.gap === true);
  const text = `${block}\n\n${buildFarleyFooter(lang, { ctxTf, market, status, gap })}`;

  // Chart: render gagal (font/canvas bermasalah) atau data kurang -> tetap kirim teks supaya analisis tidak hilang.
  let png = null;
  if (sc.status !== "nodata") {
    try {
      png = renderFarleyPng(lang, { closed, coin: mk.symbol, tf, sc, market });
    } catch (err) {
      console.log("[kripto] !farley chart gagal, kirim teks saja:", err.message);
    }
  }
  if (!png) await sock.sendMessage(jid, { text }, { quoted: msg });
  else if (text.length <= CAPTION_MAX) await sock.sendMessage(jid, { image: png, caption: text }, { quoted: msg });
  else {
    await sock.sendMessage(jid, { image: png }, { quoted: msg });
    await sock.sendMessage(jid, { text });
  }
}

module.exports = { runFarley, analyze, renderFarleyPng };
