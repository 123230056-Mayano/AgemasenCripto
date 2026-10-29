"use strict";
/**
 * Bandingkan tweezer SEBELUM vs SESUDAH gerbang momentum RSI/MACD (rencana revisi !pola, A8).
 *
 *   node scripts/backtest-tweezer-momentum.js [BTC ETH SOL ...] [--tf 1H,4H] [--bars 3000]
 *   node scripts/backtest-tweezer-momentum.js --file candles.json --name BTC --tf 1H     (tanpa jaringan)
 *
 * Tiga kelompok per jenis tweezer (tweezerBottom / tweezerTop), hasil sejarah yang SAMA persis dengan backtest-pola.js
 * (jalan = gerak >= BT_CONTINUE_ATR x ATR sebelum close melewati level batal; gagal = sebaliknya; MAE = gerak berlawanan terbesar, satuan ATR):
 *   sebelum  : semua tweezer (perilaku versi 3, gerbang tidak ada)
 *   sesudah  : tweezer yang lolos gerbang (momentum tidak melawan di kedua indikator)
 *   disaring : tweezer yang kena gerbang (MACD dan RSI sama-sama melawan)
 * Gerbang berjalan di mode "weaken" supaya pola tetap tercatat dan bisa dibandingkan satu per satu.
 *
 * ATURAN REPO: angka hanya tampil bila N >= PATTERN_STATS_MIN_N (30). Pembanding "ukur" memakai bagian waktu TERAKHIR (out-of-sample,
 * 1 - BT_TRAIN_FRAC); keputusan ambang tidak boleh disetel ulang dari angka oos itu. Tanpa fee/slip; sampel berdekatan tumpang tindih.
 * Jika filter tidak memperbaiki hasil: ubah ambang (PATTERN_MOM_*) pada bagian train, atau cabut gerbang (PATTERN_TWEEZER_MOMENTUM_GATE=0).
 */
const fs = require("fs");
const { runPatternBacktest, summarize, cutoffTime } = require("../src/features/kripto/patternBacktest");
const { PATTERN_CONFIG: CFG } = require("../src/config/indicatorConfig");

function parseArgs(argv) {
  const o = { coins: [], tfs: ["1H", "4H"], bars: 3000, file: null, name: "FILE" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tf") o.tfs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--bars") o.bars = Number(argv[++i]);
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--name") o.name = argv[++i];
    else if (!a.startsWith("--")) o.coins.push(a.toUpperCase());
  }
  if (!o.coins.length && !o.file) o.coins = ["BTC", "ETH", "SOL"];
  return o;
}

const isNum = (v) => typeof v === "number" && isFinite(v);
const median = (a) => {
  const x = a.filter(isNum).sort((p, q) => p - q);
  return x.length ? (x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null;
};
const f1 = (v) => (v == null ? "-" : v.toFixed(1));
const f2 = (v) => (v == null ? "-" : v.toFixed(2));

/** Satu baris ringkas; N < minN -> angka disembunyikan (aturan repo). */
function row(label, samples, minN) {
  const g = summarize(samples);
  const n = g ? g.n : 0;
  if (n < minN) return { label, n, shown: false, text: `${label.padEnd(10)} N=${String(n).padStart(4)}  (N < ${minN}, angka tidak ditampilkan)` };
  const mae = median(samples.map((s) => s.mae));
  return { label, n, shown: true, cont: g.cont, fail: g.fail, mae, text: `${label.padEnd(10)} N=${String(n).padStart(4)}  jalan ${f1(g.cont).padStart(5)}%  gagal ${f1(g.fail).padStart(5)}%  MAE median ${f2(mae)} ATR` };
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const minN = CFG.STATS_MIN_N;
  const jobs = [];
  if (o.file) {
    const candles = JSON.parse(fs.readFileSync(o.file, "utf8"));
    for (const tf of o.tfs) jobs.push({ coin: o.name, tf, candles });
  } else {
    const { fetchCandlesHistory } = require("../src/features/kripto/market");
    for (const coin of o.coins) for (const tf of o.tfs) jobs.push({ coin, tf, candles: await fetchCandlesHistory(coin, tf, { bars: o.bars }) });
  }

  const all = [];
  for (const j of jobs) {
    const r = runPatternBacktest(j.candles, { coin: j.coin, tf: j.tf, families: ["candle"], candleOpts: { momentum: { evidence: true, gate: true, mode: "weaken" } } });
    const tw = r.patterns.filter((s) => s.kind === "tweezerBottom" || s.kind === "tweezerTop");
    all.push(...tw);
    console.error(`${j.coin} ${j.tf}: ${j.candles.length} candle, ${tw.length} sampel tweezer (${tw.filter((s) => s.momAgainst).length} kena gerbang)`);
  }
  const cut = cutoffTime(all);
  console.log(`\nTweezer sebelum vs sesudah gerbang momentum | koin: ${[...new Set(jobs.map((j) => j.coin))].join(",")} | TF: ${o.tfs.join(",")} | cutoff train/oos: ${cut ? new Date(cut).toISOString() : "-"}`);
  console.log(`Ambang: RSI ${CFG.MOM_RSI_OVERSOLD}/${CFG.MOM_RSI_OVERBOUGHT}, lookback ${CFG.MOM_LOOKBACK} candle (nilai awal usulan). Horizon ${CFG.BT_HORIZON} candle, jalan = ${CFG.BT_CONTINUE_ATR} ATR.`);

  for (const tf of o.tfs) {
    for (const kind of ["tweezerBottom", "tweezerTop"]) {
      const sub = all.filter((s) => s.tf === tf && s.kind === kind);
      for (const [part, pick] of [["train", (s) => cut != null && s.t < cut], ["oos", (s) => cut != null && s.t >= cut]]) {
        const S = sub.filter(pick);
        const before = row("sebelum", S, minN);
        const after = row("sesudah", S.filter((s) => !s.momAgainst), minN);
        const cut_ = row("disaring", S.filter((s) => s.momAgainst), minN);
        console.log(`\n[${tf}] ${kind} - ${part}`);
        for (const r of [before, after, cut_]) console.log("  " + r.text);
        if (part === "oos") {
          if (before.shown && after.shown) {
            const better = after.cont > before.cont && after.fail <= before.fail;
            console.log(`  -> ${better ? "filter MEMBANTU pada oos (jalan naik, gagal tidak naik)" : "filter TIDAK terbukti membantu pada oos: ubah ambang (disetel di train) atau cabut gerbang"}`);
          } else console.log("  -> belum bisa dinilai (N kurang): tambah koin/bars sebelum memutuskan");
        }
      }
    }
  }
  console.log("\nBatas: tanpa fee/slip/spread; sampel berdekatan tumpang tindih; 2 jenis x TF dibandingkan sekaligus (peluang temuan kebetulan naik); jangan menyetel ulang ambang dari angka oos.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
