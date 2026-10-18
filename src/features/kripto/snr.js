"use strict";

/**
 * features/kripto/snr.js
 * ------------------------------------------------------------------
 * !snr <koin> [tf]  -> Support & Resistance lengkap:
 *   - sampai 3 resistance (R1..R3) & 3 support (S1..S3) terdekat dari harga sekarang
 *   - tiap level punya "kekuatan" = berapa kali harga memantul / ditolak di zona itu
 *   - jarak % dari harga sekarang
 *   - gambar chart (candlestick + garis S/R) sekalian
 *
 * Beda dengan !level (cuma R1/R2/S1/S2 versi ringkas, teks saja): !snr menggabungkan
 * pivot yang berdekatan jadi satu ZONA, menghitung jumlah sentuhan, dan mengirim chart.
 * Data langsung dari Binance (market.js), tidak butuh ANALYST_URL.
 */

const { t } = require("../../i18n");
const { renderChart } = require("../analisis/analisisChart");
const { TF_LABEL, fetchCandles, fetchTicker, fmtUsd, fmtLevel, fmtPct, pctFrom } = require("./market");

const LOOKBACK = 200; // jumlah candle terakhir yang dipindai
const PIVOT_WIN = 3; // pivot = high/low tertinggi/terendah dalam +-3 candle
const ZONE_PCT = 0.01; // pivot yang selisihnya <= 1% digabung jadi satu zona
const PER_SIDE = 3; // jumlah level per sisi (R1..R3, S1..S3)

/**
 * Cari semua pivot (swing high & swing low) lalu gabungkan yang berdekatan jadi zona.
 * Swing high DAN swing low sama-sama dihitung sebagai "sentuhan", jadi level yang
 * sebelumnya support lalu berubah jadi resistance (atau sebaliknya) otomatis dapat
 * skor lebih tinggi.
 *
 * @returns {{price:number, touches:number}[]} urut dari harga rendah -> tinggi
 */
function findZones(candles, { lookback = LOOKBACK, win = PIVOT_WIN, zonePct = ZONE_PCT } = {}) {
  const slice = candles.slice(-lookback);
  const pivots = [];
  for (let i = win; i < slice.length - win; i++) {
    const around = slice.slice(i - win, i + win + 1);
    if (slice[i].h === Math.max(...around.map((c) => c.h))) pivots.push(slice[i].h);
    if (slice[i].l === Math.min(...around.map((c) => c.l))) pivots.push(slice[i].l);
  }
  pivots.sort((a, b) => a - b);

  const zones = [];
  let group = [];
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  for (const v of pivots) {
    if (group.length && Math.abs(v - avg(group)) / avg(group) > zonePct) {
      zones.push({ price: avg(group), touches: group.length });
      group = [];
    }
    group.push(v);
  }
  if (group.length) zones.push({ price: avg(group), touches: group.length });
  return zones;
}

/**
 * Pisahkan zona jadi resistance (di atas harga) & support (di bawah harga),
 * masing-masing urut terdekat -> terjauh.
 */
function computeSnr(candles, price, { count = PER_SIDE } = {}) {
  const zones = findZones(candles);
  const resistance = zones.filter((z) => z.price > price).slice(0, count);
  const support = zones.filter((z) => z.price < price).slice(-count).reverse();
  return { resistance, support };
}

/**
 * Skala kekuatan 5 bulatan (jumlah pantulan = berapa pivot yang menumpuk di zona itu):
 *   1x   -> ●○○○○ lemah
 *   2x   -> ●●○○○ sedang
 *   3-4x -> ●●●○○ sedang
 *   5-8x -> ●●●●○ kuat
 *   9x+  -> ●●●●● sangat kuat
 * Skala 5 tingkat supaya level 6x dan 12x tidak tampil sama.
 */
function strengthLevel(touches) {
  if (touches >= 9) return 5;
  if (touches >= 5) return 4;
  if (touches >= 3) return 3;
  if (touches === 2) return 2;
  return 1;
}

function strengthKey(touches) {
  const lv = strengthLevel(touches);
  if (lv === 5) return "vstrong";
  if (lv === 4) return "strong";
  if (lv >= 2) return "medium";
  return "weak";
}

/**
 * Baris level, mis. "🔴 R1  $152.30 (+1.80%)  ●●○○○ sedang (2x)"
 * Bulat isi = kekuatan, bulat kosong = bagian yang belum terisi (bukan sinyal negatif).
 */
function levelLine(lang, label, icon, zone, price) {
  if (!zone) return `${icon} ${label}  -`;
  const lv = strengthLevel(zone.touches);
  const dots = "●".repeat(lv) + "○".repeat(5 - lv);
  const name = t(lang, `kripto.snr.str.${strengthKey(zone.touches)}`);
  return `${icon} ${label}  ${fmtLevel(zone.price)} (${fmtPct(pctFrom(price, zone.price))})  ${dots} ${name} (${zone.touches}x)`;
}

async function runSnr(sock, msg, { jid, lang }, { coin, tf }) {
  const [candles, tick] = await Promise.all([fetchCandles(coin, tf), fetchTicker(coin)]);
  const { resistance, support } = computeSnr(candles, tick.price);

  // Resistance ditampilkan dari yang terjauh ke terdekat (R3 -> R1) lalu harga, lalu support
  // dari terdekat ke terjauh (S1 -> S3), supaya urutannya sama dengan posisi di chart.
  const resRows = [...Array(PER_SIDE).keys()].reverse().map((i) => levelLine(lang, `R${i + 1}`, "🔴", resistance[i], tick.price));
  const supRows = [...Array(PER_SIDE).keys()].map((i) => levelLine(lang, `S${i + 1}`, "🟢", support[i], tick.price));
  const rows = [...resRows, `▶️ ${t(lang, "kripto.snr.now")} ${fmtUsd(tick.price)}`, ...supRows].join("\n");

  // Posisi harga relatif terhadap zona terdekat.
  let note;
  const r1 = resistance[0];
  const s1 = support[0];
  if (r1 && s1) {
    note = t(lang, "kripto.snr.between", { s1: fmtLevel(s1.price), r1: fmtLevel(r1.price) });
  } else if (!r1 && s1) {
    note = t(lang, "kripto.snr.noRes");
  } else if (r1 && !s1) {
    note = t(lang, "kripto.snr.noSup");
  } else {
    note = t(lang, "kripto.snr.none");
  }

  const caption = t(lang, "kripto.snr.body", {
    coin,
    tf: TF_LABEL[tf],
    price: fmtUsd(tick.price),
    change: fmtPct(tick.changePct),
    rows,
    note,
  });

  // Chart (candle + EMA + garis S/R). Kalau render gagal (mis. font/canvas bermasalah)
  // tetap kirim versi teks supaya fitur tidak mati total.
  let png = null;
  try {
    png = renderChart({
      candles,
      coin,
      tf: TF_LABEL[tf],
      resistance: resistance.map((z) => z.price),
      support: support.map((z) => z.price),
      dominance: null,
    });
  } catch (err) {
    console.log("[kripto] !snr chart gagal, kirim teks saja:", err.message);
  }

  if (png) await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  else await sock.sendMessage(jid, { text: caption }, { quoted: msg });
}

module.exports = { runSnr, computeSnr, findZones, strengthKey, strengthLevel };
