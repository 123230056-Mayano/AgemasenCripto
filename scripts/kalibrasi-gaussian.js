"use strict";
/**
 * Uji kalibrasi estimasi sebaran (Fitur 4): apakah rentang 68% / 95% benar-benar berisi sekitar 68% / 95% kejadian?
 *
 *   node scripts/kalibrasi-gaussian.js [BTC ETH SOL ...] [--tf 1H,4H] [--h 6] [--bars 3000] [--window 800] [--out data/gaussian-kalibrasi.json]
 *   node scripts/kalibrasi-gaussian.js --file candles.json --name BTC --tf 4H --h 6        (tanpa jaringan)
 *
 * Walk-forward: tiap titik uji hanya memakai candle sebelum / pada titik itu; hasil dibandingkan dengan harga h candle
 * kemudian. Langkah = h supaya titik uji tidak tumpang tindih. Dilaporkan apa adanya, termasuk kalau Gaussian meleset
 * (kripto berekor tebal): kolom "emp" = rentang empiris (kuantil riil) sebagai pembanding.
 * Hanya sejarah; tanpa fee/slip. Bukan jaminan hasil ke depan.
 */
const fs = require("fs");
const path = require("path");
const { calibrate } = require("../src/features/kripto/gaussian");
const { GAUSSIAN_CONFIG: CFG } = require("../src/config/indicatorConfig");

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], h: CFG.HORIZON, bars: 3000, window: CFG.WINDOW, file: null, name: "FILE", out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--h") o.h = Number(argv[++i]);
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--window") o.window = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (!a.startsWith("--")) o.coins.push(a.toUpperCase());
  }
  if (!o.coins.length && !o.file) o.coins = ["BTC", "ETH", "SOL"];
  return o;
}

const f1 = (v) => (v == null ? "   -  " : v.toFixed(1).padStart(5) + "%");

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const jobs = [];
  if (o.file) {
    const candles = JSON.parse(fs.readFileSync(o.file, "utf8"));
    for (const tf of o.tfs) jobs.push({ coin: o.name, tf, candles });
  } else {
    const { fetchCandlesHistory } = require("../src/features/kripto/market");
    for (const coin of o.coins) for (const tf of o.tfs) jobs.push({ coin, tf, candles: await fetchCandlesHistory(coin, tf, { bars: o.bars }) });
  }

  const rows = [];
  console.log(`Kalibrasi Gaussian | h=${o.h} candle | jendela=${o.window} | uji tanpa tumpang tindih (langkah = h)\n`);
  console.log("koin  TF   N uji | target 68/95 | Gauss 68   Gauss 95 | emp 68     emp 95  | arah benar | ekor tebal | terkalibrasi?");
  for (const j of jobs) {
    const c = calibrate(j.candles, { h: o.h, window: o.window });
    if (!c.ok) {
      console.log(`${j.coin.padEnd(5)} ${j.tf.padEnd(3)} data belum cukup`);
      continue;
    }
    rows.push({ coin: j.coin, tf: j.tf, ...c });
    console.log(
      `${j.coin.padEnd(5)} ${j.tf.padEnd(3)} ${String(c.n).padStart(5)} | ${c.target1.toFixed(1)}/${c.target2.toFixed(1)} | ${f1(c.gauss1)}  ${f1(c.gauss2)} | ${f1(c.emp1)}  ${f1(c.emp2)} | ${f1(c.dirUp)} | ${f1(c.fatShare)} | ${c.calibrated ? "YA" : "TIDAK"}`,
    );
  }

  if (rows.length) {
    const tot = rows.reduce((s, r) => s + r.n, 0);
    const w = (k) => rows.reduce((s, r) => s + r[k] * r.n, 0) / tot;
    console.log(`\nGabungan (berbobot N=${tot}): Gauss 68=${w("gauss1").toFixed(1)}% 95=${w("gauss2").toFixed(1)}% | empiris 68=${w("emp1").toFixed(1)}% 95=${w("emp2").toFixed(1)}% | arah benar=${w("dirUp").toFixed(1)}%`);
  }
  console.log("\nCatatan: arah benar ~50% berarti kecenderungan naik/turun tidak lebih baik dari lempar koin; tampilkan dengan hati-hati.");
  console.log("Batas: hanya sejarah, tanpa fee/slip; kripto berekor tebal (Gaussian cenderung meleset di +-1 sigma); bukan jaminan ke depan.");

  if (o.out) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(o.out, JSON.stringify({ version: CFG.VERSION, generatedAt: new Date().toISOString(), h: o.h, window: o.window, rows }, null, 2));
    console.log("Tersimpan:", o.out);
  }
})().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});
