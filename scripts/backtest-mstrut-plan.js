"use strict";
/**
 * Backtest SKENARIO !mstrut (Entry Zone, SL, TP1 / TP2): kalau skenario diikuti apa adanya, untung atau rugi?
 *
 *   node scripts/backtest-mstrut-plan.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000] [--out data/mstrut-plan-stats.json]
 *   node scripts/backtest-mstrut-plan.js --file candles.json --name BTC --tf 1H        (tanpa jaringan)
 *
 * Opsi simulasi:
 *   --fee-bps 10 --slip-bps 5     biaya per sisi (bps); --no-cost = tanpa biaya (hanya untuk perbandingan)
 *   --horizon-hours 24            jendela entry terisi (default 24 jam, sama dengan skenario di bot)
 *   --hold-bars N                 batas tahan setelah terisi (default = jendela entry)
 *   --tp1-share 0.5               porsi posisi yang ditutup di TP1; --no-be = SL tidak digeser ke entry setelah TP1
 *   --step 3                      sampel tiap N candle; --overlap = boleh banyak skenario aktif sekaligus
 *   --csv data/mstrut-plan-trades.csv   semua trade (untuk dicek / dibuat grafik di Excel)
 *   --json                        cetak statistik JSON ke layar
 *
 * Statistik digabung (pooled) antar koin per timeframe. Kesimpulan hanya dari bagian waktu terakhir (oos), N >= 30.
 * Dilaporkan apa adanya, termasuk kalau ternyata tidak ada keunggulan. Output ke file TERPISAH
 * (data/mstrut-plan-stats.json), tidak menimpa data/mstrut-stats.json yang dibaca !mstrut.
 */
const fs = require("fs");
const path = require("path");
const { runPlanBacktest, buildPlanStatsFile } = require("../src/features/kripto/mstrutPlanBacktest");

function parseArgs(argv) {
  const o = {
    coins: [], tfs: ["1H", "4H"], bars: 3000, file: null, name: "FILE", out: null, csv: null, json: false,
    sim: { feeBps: 10, slipBps: 5, nonOverlap: true, beAfterTp1: true },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--csv") o.csv = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--fee-bps") o.sim.feeBps = Number(argv[++i]);
    else if (a === "--slip-bps") o.sim.slipBps = Number(argv[++i]);
    else if (a === "--no-cost") { o.sim.feeBps = 0; o.sim.slipBps = 0; }
    else if (a === "--horizon-hours") o.sim.horizonHours = Number(argv[++i]);
    else if (a === "--hold-bars") o.sim.holdBars = Number(argv[++i]);
    else if (a === "--tp1-share") o.sim.tp1Share = Number(argv[++i]);
    else if (a === "--no-be") o.sim.beAfterTp1 = false;
    else if (a === "--step") o.sim.step = Number(argv[++i]);
    else if (a === "--overlap") o.sim.nonOverlap = false;
    else if (!a.startsWith("--")) o.coins.push(a.toUpperCase());
  }
  if (!o.coins.length && !o.file) o.coins = ["BTC", "ETH", "SOL"];
  return o;
}

const f1 = (v) => (v == null || !isFinite(v) ? "  -  " : v.toFixed(1).padStart(5));
const f2 = (v) => (v == null || !isFinite(v) ? "  -  " : v.toFixed(2).padStart(6));
const VERDICT_TXT = {
  edge: "ADA keunggulan: expectancy positif (CI 95% > 0) dan mengalahkan pembanding acak",
  no_edge: "TIDAK terbukti menguntungkan (expectancy tidak beda nyata dari 0 / tidak mengalahkan pembanding acak)",
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
    const s = runPlanBacktest(j.candles, { coin: j.coin, tf: j.tf, ...o.sim });
    samples.push(...s);
    const np = s.filter((x) => x.kind === "plan").length;
    console.error(`${j.coin} ${j.tf}: ${j.candles.length} candle, ${s.length} sampel, ${np} skenario`);
  }
  const params = { ...o.sim, bars: o.bars };
  const stats = buildPlanStatsFile(samples, { coins: [...new Set(jobs.map((j) => j.coin))], tfs: o.tfs }, params);
  if (o.csv) {
    fs.mkdirSync(path.dirname(o.csv), { recursive: true });
    const head = "coin,tf,time,dir,grade,state,rr1,risk_pct,filled,exit,tp1_hit,bars,gross_r,net_r,random_net_r,market_net_r";
    const rows = samples.filter((s) => s.kind === "plan").map((s) => [s.coin, s.tf, new Date(s.t).toISOString(), s.dir, s.grade, s.state, s.rr1.toFixed(2), s.riskPct.toFixed(2), s.filled, s.exit, s.tp1Hit, s.bars, s.grossR.toFixed(3), s.netR.toFixed(3), s.rndNetR == null ? "" : s.rndNetR.toFixed(3), s.mktNetR == null ? "" : s.mktNetR.toFixed(3)].join(","));
    fs.writeFileSync(o.csv, [head, ...rows].join("\n"));
    console.error("CSV trade:", o.csv);
  }
  if (o.json) return console.log(JSON.stringify(stats, null, 2));

  const cost = 2 * (o.sim.feeBps + o.sim.slipBps);
  console.log(`\nBacktest skenario !mstrut | cutoff ${stats.cutoff ? new Date(stats.cutoff).toISOString() : "-"} | sampel train ${stats.nTrain} | oos ${stats.nOos}`);
  console.log(`Asumsi: entry limit di tengah zona | TP1 ${Math.round((o.sim.tp1Share ?? 0.5) * 100)}% lalu ${o.sim.beAfterTp1 ? "SL geser ke entry" : "SL tetap"} | biaya ${cost} bps pulang-pergi | ${o.sim.nonOverlap ? "satu skenario aktif per koin+TF" : "boleh tumpang tindih"}`);
  console.log("\nKelompok (oos)".padEnd(18), "WAIT%".padStart(6), "skenario".padStart(9), "terisi%".padStart(8), "trade".padStart(6), "win%".padStart(6), "avgR".padStart(6), "total R".padStart(8), "PF".padStart(5), "maxDD".padStart(6), "acak".padStart(6), "market".padStart(7));
  for (const [k, g] of Object.entries(stats.oos).sort()) {
    console.log(
      k.padEnd(17), (/\|(long|short)$/.test(k) ? "  -  " : f1(g.waitRate)).padStart(6), String(g.nPlans).padStart(9), f1(g.fillRate).padStart(8), String(g.nTrades).padStart(6), f1(g.winRate).padStart(6),
      f2(g.expectancyR).padStart(6), f2(g.totalR).padStart(8), (g.profitFactor === Infinity ? "inf" : f1(g.profitFactor)).padStart(5), f1(g.maxDrawdownR).padStart(6),
      f2(g.baseline.randomR).padStart(6), f2(g.baseline.marketR).padStart(7),
    );
  }
  console.log("\n(avgR = expectancy per trade dalam R setelah biaya; acak / market = avgR pembanding dengan jarak SL/TP yang sama)");
  console.log("\nKesimpulan per timeframe (oos):");
  for (const tf of o.tfs) {
    const g = stats.oos[`${tf}|any`];
    if (!g || !g.nTrades) {
      console.log(`  ${tf}: tidak ada trade`);
      continue;
    }
    const ci = g.expCiLo == null ? "-" : `${g.expCiLo.toFixed(2)} s/d ${g.expCiHi.toFixed(2)}`;
    console.log(`  ${tf}: ${VERDICT_TXT[g.verdict]} (N ${g.nTrades}) | avgR ${g.expectancyR.toFixed(2)} (CI95 ${ci}) | win ${g.winRate.toFixed(0)}% | maxDD ${g.maxDrawdownR.toFixed(1)}R`);
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
