"use strict";
/**
 * Backtest kekuatan tren (Fitur 3): apakah tren KUAT benar lebih sering lanjut dibanding LEMAH?
 *
 *   node scripts/backtest-kekuatan-tren.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000] [--out data/kekuatan-tren-stats.json]
 *   node scripts/backtest-kekuatan-tren.js --file candles.json --name BTC --tf 1H [--htf-file candles-4h.json]   (tanpa jaringan)
 *
 * Statistik digabung (pooled) antar koin per timeframe. Kesimpulan hanya dari bagian waktu terakhir (oos), N >= 30 di
 * kedua kelompok. Hasil hanya sejarah, tanpa fee/slip/gap: lihat batas di src/features/kripto/trendStrengthBacktest.js.
 * Dilaporkan apa adanya, termasuk kalau KUAT ternyata tidak lebih baik.
 */
const fs = require("fs");
const path = require("path");
const { runStrengthBacktest, buildStatsFile } = require("../src/features/kripto/trendStrengthBacktest");
const { htfOf } = require("../src/features/kripto/hhllContext");

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], bars: 3000, file: null, htfFile: null, name: "FILE", out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--htf-file") o.htfFile = argv[++i];
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
  better: "KUAT terbukti lebih sering lanjut",
  not_better: "KUAT TIDAK terbukti lebih baik dari LEMAH",
  insufficient: "data belum cukup, tidak ada kesimpulan",
};

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const samples = [];
  const jobs = [];
  if (o.file) {
    const candles = JSON.parse(fs.readFileSync(o.file, "utf8"));
    const htf = o.htfFile ? JSON.parse(fs.readFileSync(o.htfFile, "utf8")) : null;
    for (const tf of o.tfs) jobs.push({ coin: o.name, tf, candles, htf });
  } else {
    const { fetchCandlesHistory } = require("../src/features/kripto/market");
    for (const coin of o.coins) {
      for (const tf of o.tfs) {
        const htfTf = htfOf(tf);
        const [candles, htf] = await Promise.all([fetchCandlesHistory(coin, tf, { bars: o.bars }), htfTf ? fetchCandlesHistory(coin, htfTf, { bars: o.bars }).catch(() => null) : null]);
        jobs.push({ coin, tf, candles, htf });
      }
    }
  }
  for (const j of jobs) {
    const s = runStrengthBacktest(j.candles, j.htf, { coin: j.coin, tf: j.tf });
    samples.push(...s);
    console.error(`${j.coin} ${j.tf}: ${j.candles.length} candle, ${s.length} sampel${j.htf || !htfOf(j.tf) ? "" : " (TF besar tidak ada: komponen TF besar tidak dinilai)"}`);
  }
  const stats = buildStatsFile(samples, { coins: [...new Set(jobs.map((j) => j.coin))], tfs: o.tfs });
  if (o.json) return console.log(JSON.stringify(stats, null, 2));
  console.log(`\nWalk-forward: cutoff ${stats.cutoff ? new Date(stats.cutoff).toISOString() : "-"} | train ${stats.nTrain} | oos ${stats.nOos} | horizon ${stats.horizon} candle`);
  console.log("kelompok".padEnd(16), "n".padStart(5), "lanjut%".padStart(8), "gagal%".padStart(7), "tak satupun%".padStart(13));
  for (const [k, g] of Object.entries(stats.oos).sort()) console.log(k.padEnd(16), String(g.n).padStart(5), f1(g.cont).padStart(8), f1(g.fail).padStart(7), f1(g.neither).padStart(13));
  console.log("\nKesimpulan (oos):");
  for (const [tf, v] of Object.entries(stats.verdicts)) {
    const extra = v.diff != null ? ` (selisih ${v.diff.toFixed(1)} poin, z ${v.z.toFixed(2)}, N kuat ${v.nStrong} / lemah ${v.nWeak})` : ` (N kuat ${v.nStrong} / lemah ${v.nWeak}, minimal ${stats.minN})`;
    console.log(`  ${tf}: ${VERDICT_TXT[v.verdict]}${extra}`);
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
