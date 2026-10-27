"use strict";
/**
 * Backtest pengenal pola vs baseline + walk-forward (catatan Bagian 10, Fase 4).
 *
 *   node scripts/backtest-pola.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000] [--families candle,swing,line,zone] [--out data/pola-stats.json]
 *   node scripts/backtest-pola.js --file candles.json --name BTC --tf 1H     (tanpa jaringan)
 *
 * Statistik digabung (pooled) antar koin per timeframe. Keputusan bobot hanya dari bagian waktu terakhir (oos), N >= 30
 * untuk pola DAN baseline. Hasil hanya sejarah, tanpa fee/slip/gap: lihat batas di src/features/kripto/patternBacktest.js.
 */
const fs = require("fs");
const path = require("path");
const { runPatternBacktest, runZoneBacktest, buildStatsFile } = require("../src/features/kripto/patternBacktest");

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], bars: 3000, families: ["candle", "swing"], file: null, name: "FILE", out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--families") o.families = String(argv[++i]).split(",");
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

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const pat = [];
  const base = [];
  const jobs = [];
  if (o.file) {
    const candles = JSON.parse(fs.readFileSync(o.file, "utf8"));
    for (const tf of o.tfs) jobs.push({ coin: o.name, tf, candles });
  } else {
    const { fetchCandlesHistory } = require("../src/features/kripto/market");
    for (const coin of o.coins) for (const tf of o.tfs) jobs.push({ coin, tf, candles: await fetchCandlesHistory(coin, tf, { bars: o.bars }) });
  }
  for (const j of jobs) {
    const r = runPatternBacktest(j.candles, { coin: j.coin, tf: j.tf, families: o.families.filter((f) => f !== "zone") });
    if (o.families.includes("zone")) {
      const z = runZoneBacktest(j.candles, { coin: j.coin, tf: j.tf });
      r.patterns.push(...z.patterns);
      r.baseline.push(...z.baseline);
    }
    pat.push(...r.patterns);
    base.push(...r.baseline);
    console.error(`${j.coin} ${j.tf}: ${j.candles.length} candle, ${r.patterns.length} sampel pola, ${r.baseline.length} baseline`);
  }
  // combos = pola(kind) x TF yang dinilai; ambang TIDAK disapu di skrip ini (nilai awal usulan), jadi tidak ada pengali ambang.
  const kinds = new Set(pat.map((s) => s.kind));
  // zone memakai baseline sendiri (baselineZone); jumlah kombinasi tetap = jumlah kind x TF yang muncul.
  const stats = buildStatsFile(pat, base, { combos: kinds.size * o.tfs.length, extra: { coins: [...new Set(jobs.map((j) => j.coin))], tfs: o.tfs, families: o.families } });
  if (o.json) return console.log(JSON.stringify(stats, null, 2));
  console.log(`\nWalk-forward: cutoff ${stats.cutoff ? new Date(stats.cutoff).toISOString() : "-"} | train ${stats.nTrain} | oos ${stats.nOos} | baseline oos ${stats.nBaseOos} | kombinasi dicoba ${stats.combos}`);
  console.log("kelompok".padEnd(30), "n".padStart(5), "jalan%".padStart(7), "gagal%".padStart(7), "  bobot / alasan");
  for (const [k, g] of Object.entries(stats.oos).sort()) {
    if (!k.endsWith("|any")) continue;
    const dirs = ["bullish", "bearish"].map((d) => k.replace("|any", "|" + d));
    for (const kk of [k, ...dirs]) {
      const gg = stats.oos[kk];
      if (!gg) continue;
      const v = stats.verdicts[kk];
      const w = gg.n < stats.minN ? "disembunyikan (N < " + stats.minN + ")" : v && v.weight != null ? `${v.weight} - ${v.reason}` : v ? v.reason : "-";
      console.log(kk.padEnd(30), String(gg.n).padStart(5), f1(gg.cont).padStart(7), f1(gg.fail).padStart(7), " ", w);
    }
  }
  for (const [k, g] of Object.entries(stats.baselineOos).sort()) console.log(k.padEnd(30), String(g.n).padStart(5), f1(g.cont).padStart(7), f1(g.fail).padStart(7), "  baseline");
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
