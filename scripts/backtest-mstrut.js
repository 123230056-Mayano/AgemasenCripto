"use strict";
/**
 * Backtest probabilitas !mstrut: apakah "LONG 60%" memang naik lebih dulu sekitar 60% kali?
 *
 *   node scripts/backtest-mstrut.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000] [--out data/mstrut-stats.json]
 *   node scripts/backtest-mstrut.js --file candles.json --name BTC --tf 1H        (tanpa jaringan)
 *
 * Statistik digabung (pooled) antar koin per timeframe. Kesimpulan hanya dari bagian waktu terakhir (oos), N >= 30.
 * Hasil hanya sejarah, tanpa fee/slip/gap: lihat batas di src/features/kripto/mstrutBacktest.js.
 * Dilaporkan apa adanya, termasuk kalau ternyata tidak ada keunggulan.
 * File --out dibaca !mstrut (data/mstrut-stats.json) untuk menampilkan akurasi historis; tanpa file itu blok akurasi tidak tampil.
 */
const fs = require("fs");
const path = require("path");
const { runMstrutBacktest, buildStatsFile } = require("../src/features/kripto/mstrutBacktest");

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], bars: 3000, file: null, name: "FILE", out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--json") o.json = true;
    else if (!a.startsWith("--")) o.coins.push(a.toUpperCase());
  }
  if (!o.coins.length && !o.file) o.coins = ["BTC", "ETH", "SOL"];
  return o;
}

const f1 = (v) => (v == null ? "  -  " : v.toFixed(1).padStart(5));
const VERDICT_TXT = {
  edge: "ADA keunggulan: hit-rate di atas 50% (CI 95%) dan mengalahkan pembanding tren pasar",
  no_edge: "TIDAK terbukti punya keunggulan (tidak beda nyata dari tebakan acak / pembanding tren)",
  insufficient: "data belum cukup, tidak ada kesimpulan",
};

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const samples = [];
  const jobs = [];
  if (o.file) {
    const candles = JSON.parse(fs.readFileSync(o.file, "utf8"));
    for (const tf of o.tfs) jobs.push({ coin: o.name, tf, candles });
  } else {
    const { fetchCandlesHistory } = require("../src/features/kripto/market");
    for (const coin of o.coins) {
      for (const tf of o.tfs) jobs.push({ coin, tf, candles: await fetchCandlesHistory(coin, tf, { bars: o.bars }) });
    }
  }
  for (const j of jobs) {
    const s = runMstrutBacktest(j.candles, { coin: j.coin, tf: j.tf });
    samples.push(...s);
    console.error(`${j.coin} ${j.tf}: ${j.candles.length} candle, ${s.length} sampel`);
  }
  const stats = buildStatsFile(samples, { coins: [...new Set(jobs.map((j) => j.coin))], tfs: o.tfs });
  if (o.json) return console.log(JSON.stringify(stats, null, 2));

  console.log(`\nWalk-forward: cutoff ${stats.cutoff ? new Date(stats.cutoff).toISOString() : "-"} | train ${stats.nTrain} | oos ${stats.nOos} | horizon ${stats.horizon} candle | pagar ±${stats.barrierAtr} ATR`);
  console.log("\nKelompok (oos)".padEnd(18), "N".padStart(5), "klaim%".padStart(7), "benar%".padStart(7), "CI95".padStart(13), "naik%".padStart(6), "tak selesai".padStart(12));
  for (const [k, g] of Object.entries(stats.oos).sort()) {
    const ci = g.ciLo == null ? "-" : `${g.ciLo.toFixed(0)}-${g.ciHi.toFixed(0)}`;
    console.log(k.padEnd(17), String(g.nRes).padStart(5), f1(g.claim).padStart(7), f1(g.hitRate).padStart(7), ci.padStart(13), f1(g.baseUp).padStart(6), String(g.nNone + g.nBoth).padStart(12));
  }
  console.log("\nKesimpulan per timeframe (oos):");
  for (const tf of o.tfs) {
    const g = stats.oos[`${tf}|any`];
    if (!g) {
      console.log(`  ${tf}: tidak ada sampel`);
      continue;
    }
    const gap = g.hitRate != null && g.claim != null ? ` | klaim rata-rata ${g.claim.toFixed(0)}% vs benar ${g.hitRate.toFixed(0)}% (selisih ${(g.hitRate - g.claim).toFixed(0)} poin)` : "";
    console.log(`  ${tf}: ${VERDICT_TXT[g.verdict]} (N ${g.nRes})${gap}`);
  }
  console.log("\nBatas: " + stats.caveats.join("; ") + ".");
  if (o.out) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(o.out, JSON.stringify(stats, null, 2));
    console.log("Ditulis:", o.out);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
