"use strict";
/**
 * Backtest ambang Sudden Move Guard pada candle Binance historis (catatan desain tahap 2, tahap C).
 *
 *   node scripts/backtest-sudden.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000] [--horizon 24] [--sweep]
 *   node scripts/backtest-sudden.js --file candles-btc-1h.json            (candle dari file, tanpa jaringan)
 *
 * Opsi:
 *   --tf       daftar timeframe (default 1H,4H)
 *   --bars     jumlah candle closed per pasangan (default 3000)
 *   --horizon  candle ke depan untuk menunggu TP1/SL (default 24)
 *   --sweep    uji ambang satu per satu dengan pembagian waktu (stel 60% awal, ukur 40% akhir)
 *   --file     JSON array candle {t,o,h,l,c,v} urut lama -> baru (nama koin/TF diambil dari --name)
 *   --json     keluarkan hasil mentah sebagai JSON
 *
 * Butuh akses ke Binance (BINANCE_BASE). Hasil hanya sejarah; simulasi tanpa slip/spread/fee/gap, jadi cenderung
 * terlalu optimistis. Lihat batas lengkap di src/features/kripto/suddenBacktest.js.
 */
const fs = require("fs");
const { fetchCandlesHistory } = require("../src/features/kripto/market");
const { runBacktest, groupByStatus, splitSamples, sweepThreshold } = require("../src/features/kripto/suddenBacktest");

const SWEEPS = {
  WICK_MIN_PCT: [0.5, 0.6, 0.7],
  EXPANSION_ATR: [1.5, 2, 2.5],
  VOLUME_MULT: [1.5, 2, 3],
  VOL_SL_MULT: [1, 1.25, 1.5],
};

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], bars: 3000, horizon: 24, sweep: false, json: false, file: null, name: "FILE" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--horizon") o.horizon = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--sweep") o.sweep = true;
    else if (a === "--json") o.json = true;
    else if (!a.startsWith("--")) o.coins.push(a.toUpperCase());
  }
  if (!o.coins.length && !o.file) o.coins = ["BTC", "ETH", "SOL"];
  return o;
}

const f1 = (v) => (v == null ? "  -  " : v.toFixed(1).padStart(5));
const f2 = (v) => (v == null ? "  -  " : (v >= 0 ? "+" : "") + v.toFixed(2));
function row(label, s) {
  return `${label.padEnd(20)} n=${String(s.n).padStart(5)}  TP1 ${f1(s.tp1Pct)}%  SL ${f1(s.slPct)}%  timeout ${f1(s.timeoutPct)}%  rata-rata ${f2(s.avgR)} R`;
}

function report(title, samples, horizon) {
  console.log(`\n=== ${title} (horizon ${horizon} candle) ===`);
  const g = groupByStatus(samples);
  for (const k of ["VALID", "TUNGGU", "HINDARI", "SEMUA_TANPA_FILTER"]) console.log(row(k, g[k]));
  return g;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const jobs = [];
  if (o.file) jobs.push({ name: o.name, tf: "-", load: async () => JSON.parse(fs.readFileSync(o.file, "utf8")) });
  for (const coin of o.coins) for (const tf of o.tfs) jobs.push({ name: coin, tf, load: () => fetchCandlesHistory(coin, tf, { bars: o.bars }) });

  const all = [];
  const raw = {};
  for (const job of jobs) {
    let candles;
    try {
      candles = await job.load();
    } catch (err) {
      console.log(`LEWATI ${job.name} ${job.tf}: ${err.message}`);
      continue;
    }
    const samples = runBacktest(candles, { horizon: o.horizon });
    all.push(...samples.map((s) => ({ ...s, i: s.i + all.length * 1e6 }))); // i dibuat unik antar pasangan (hanya untuk penggabungan)
    const label = `${job.name} ${job.tf}: ${candles.length} candle, ${samples.length} sampel`;
    const split = Math.floor(candles.length * 0.6);
    const { train, test } = splitSamples(samples, split);
    report(`${label} | SEMUA`, samples, o.horizon);
    report(`${job.name} ${job.tf} | PERIODE UKUR (40% akhir)`, test, o.horizon);
    raw[`${job.name}|${job.tf}`] = { groups: groupByStatus(samples), train: groupByStatus(train), test: groupByStatus(test) };
    if (o.sweep) {
      for (const [key, values] of Object.entries(SWEEPS)) {
        console.log(`\n-- sweep ${key} ${job.name} ${job.tf}: nilai | stel VALID n/avgR vs bukan-VALID | ukur VALID n/avgR vs bukan-VALID`);
        for (const r of sweepThreshold(candles, key, values, { horizon: o.horizon })) {
          const c = (p) => `${String(p.valid.n).padStart(4)}/${f2(p.valid.avgR)}  vs ${String(p.rest.n).padStart(4)}/${f2(p.rest.avgR)}`;
          console.log(`   ${String(r.value).padEnd(5)} | ${c(r.train)} | ${c(r.test)}`);
        }
      }
    }
  }
  if (o.json) console.log(JSON.stringify(raw, null, 2));
  console.log("\nCatatan: simulasi memakai high/low candle, tanpa slip/spread/fee/gap, dan menilai LONG & SHORT di tiap candle. Hasil cenderung terlalu optimistis dan tidak menjamin hasil ke depan.");
  console.log("Bila VALID tidak lebih baik dari TUNGGU/HINDARI secara berarti di PERIODE UKUR, ubah ambang atau buang filternya.");
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
