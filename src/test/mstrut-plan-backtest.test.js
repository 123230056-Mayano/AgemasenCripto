"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { simulateTrade, runPlanBacktest, summarizePlans, buildPlanStatsFile, maxDrawdown, mulberry32 } = require("../features/kripto/mstrutPlanBacktest");

const O = { fillBars: 5, holdBars: 5, tp1Share: 0.5, beAfterTp1: true, costBps: 0 };
const c = (h, l, cl) => ({ h, l, c: cl ?? (h + l) / 2 });
// SHORT: entry 100, SL 102 (risk 2), TP1 98 (+1R), TP2 94 (+3R)
const SHORT = { dir: "short", entry: 100, sl: 102, tp1: 98, tp2: 94 };
// LONG: entry 100, SL 98, TP1 102, TP2 106
const LONG = { dir: "long", entry: 100, sl: 98, tp1: 102, tp2: 106 };

test("limit tidak tersentuh = tidak terisi", () => {
  const r = simulateTrade(SHORT, [c(99, 97), c(99.5, 96)], O);
  assert.strictEqual(r.filled, false);
});

test("SHORT: terisi lalu kena SL = -1R", () => {
  const r = simulateTrade(SHORT, [c(100.5, 99), c(103, 100)], O);
  assert.strictEqual(r.exit, "sl");
  assert.strictEqual(r.grossR, -1);
});

test("candle terisi yang juga menyentuh SL dianggap SL (konservatif)", () => {
  const r = simulateTrade(SHORT, [c(103, 97)], O);
  assert.strictEqual(r.exit, "sl");
  assert.strictEqual(r.grossR, -1);
});

test("SHORT: TP1 lalu TP2 = 0.5*1 + 0.5*3 = 2R", () => {
  const r = simulateTrade(SHORT, [c(100.2, 99.5), c(99, 97.5), c(97, 93.5)], O);
  assert.strictEqual(r.exit, "tp2");
  assert.ok(Math.abs(r.grossR - 2) < 1e-9);
  assert.strictEqual(r.tp1Hit, true);
});

test("TP1 lalu balik ke entry = break-even pada sisa, total +0.5R", () => {
  const r = simulateTrade(SHORT, [c(100.2, 99.5), c(99, 97.5), c(100.1, 98.5)], O);
  assert.strictEqual(r.exit, "tp1_be");
  assert.ok(Math.abs(r.grossR - 0.5) < 1e-9);
});

test("tanpa break-even: TP1 lalu SL = 0.5 - 0.5 = 0R", () => {
  const r = simulateTrade(SHORT, [c(100.2, 99.5), c(99, 97.5), c(102.5, 99)], { ...O, beAfterTp1: false });
  assert.strictEqual(r.exit, "tp1_sl");
  assert.ok(Math.abs(r.grossR - 0) < 1e-9);
});

test("SL dan TP1 di candle yang sama -> SL dulu", () => {
  const r = simulateTrade(SHORT, [c(100.2, 99.5), c(102.5, 97.5)], O);
  assert.strictEqual(r.exit, "sl");
  assert.strictEqual(r.grossR, -1);
});

test("timeout: ditutup di close candle terakhir", () => {
  const fut = [c(100.2, 99.5), c(100.1, 99.2, 99), c(100.1, 99.2, 99), c(100.1, 99.2, 99), c(100.1, 99.2, 99), c(100.1, 99.2, 99)];
  const r = simulateTrade(SHORT, fut, { ...O, holdBars: 3 });
  assert.strictEqual(r.exit, "timeout");
  assert.ok(Math.abs(r.grossR - 0.5) < 1e-9); // (100-99)/2
});

test("LONG simetris: TP1 + TP2 = 2R", () => {
  const r = simulateTrade(LONG, [c(101, 99.8), c(102.5, 101), c(107, 104)], O);
  assert.strictEqual(r.exit, "tp2");
  assert.ok(Math.abs(r.grossR - 2) < 1e-9);
});

test("biaya dikurangkan dalam R: 30 bps dari 100 = 0.3 / risk 2 = 0.15R", () => {
  const r = simulateTrade(SHORT, [c(100.5, 99), c(103, 100)], { ...O, costBps: 30 });
  assert.ok(Math.abs(r.costR - 0.15) < 1e-9);
  assert.ok(Math.abs(r.netR - -1.15) < 1e-9);
});

test("input tidak valid -> null (SL di sisi salah, TP di sisi salah)", () => {
  assert.strictEqual(simulateTrade({ ...SHORT, sl: 99 }, [c(101, 99)], O), null);
  assert.strictEqual(simulateTrade({ ...SHORT, tp1: 101 }, [c(101, 99)], O), null);
});

test("mode market terisi di close sampel", () => {
  const r = simulateTrade({ ...LONG, mode: "market" }, [c(102.5, 100.5), c(107, 103)], O);
  assert.strictEqual(r.exit, "tp2");
});

test("maxDrawdown", () => {
  assert.strictEqual(maxDrawdown([1, -1, -1, 2, -3]), 3);
  assert.strictEqual(maxDrawdown([1, 1]), 0);
});

test("RNG seed menghasilkan urutan yang sama", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  assert.deepStrictEqual([a(), a(), a()], [b(), b(), b()]);
});

test("summarizePlans: expectancy, win rate, verdict insufficient bila N kecil", () => {
  const mk = (netR, extra = {}) => ({ kind: "plan", coin: "X", tf: "1H", t: Math.random(), dir: "long", filled: true, exit: netR > 0 ? "tp2" : "sl", tp1Hit: netR > 0, bars: 3, netR, grossR: netR, rr1: 1.5, rndNetR: -0.1, mktNetR: 0, ...extra });
  const s = summarizePlans([mk(2), mk(-1), mk(-1), { kind: "wait", reason: "lowRR", coin: "X", tf: "1H", t: 1 }]);
  assert.strictEqual(s.nTrades, 3);
  assert.strictEqual(s.nWait, 1);
  assert.ok(Math.abs(s.expectancyR - 0) < 1e-9);
  assert.ok(Math.abs(s.winRate - 100 / 3) < 1e-9);
  assert.strictEqual(s.verdict, "insufficient");
});

// Candle sintetis (random walk bergelombang) untuk uji ujung ke ujung: tanpa lookahead, hasil deterministik.
function synthCandles(n, seed = 1) {
  const r = mulberry32(seed);
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 30) * 0.25;
    const o = p;
    const cl = o * (1 + (r() - 0.5) * 0.02 + drift * 0.003);
    const h = Math.max(o, cl) * (1 + r() * 0.006);
    const l = Math.min(o, cl) * (1 - r() * 0.006);
    out.push({ t: 1_700_000_000_000 + i * 3_600_000, o, h, l, c: cl, v: 1 });
    p = cl;
  }
  return out;
}

test("runPlanBacktest: deterministik, tanpa lookahead, struktur sampel benar", () => {
  const cs = synthCandles(900);
  const a = runPlanBacktest(cs, { coin: "SYN", tf: "1H" });
  const b = runPlanBacktest(cs, { coin: "SYN", tf: "1H" });
  assert.deepStrictEqual(a, b);
  assert.ok(a.length > 20);
  // Memotong masa depan TIDAK boleh mengubah sampel sebelumnya: ambil sampel yang masa depannya masih utuh di versi pendek.
  const short = runPlanBacktest(cs.slice(0, 700), { coin: "SYN", tf: "1H" });
  const lastT = short[short.length - 1].t;
  const lastIdx = (lastT - cs[0].t) / 3_600_000;
  const safe = a.filter((s) => s.t <= lastT && (s.t - cs[0].t) / 3_600_000 <= lastIdx - 1);
  const shortSafe = short.filter((s) => s.t < lastT);
  // sampel yang sama pada timestamp yang sama harus identik (kecuali efek nonOverlap yang ikut bergeser: bandingkan hanya yang ada di keduanya)
  const mapA = new Map(safe.map((s) => [s.t, s]));
  let compared = 0;
  for (const s of shortSafe) {
    const x = mapA.get(s.t);
    if (x) {
      assert.strictEqual(x.kind, s.kind);
      if (s.kind === "plan") assert.strictEqual(x.dir, s.dir);
      compared++;
    }
  }
  assert.ok(compared > 5);
  for (const s of a) {
    assert.ok(s.kind === "wait" || s.kind === "plan");
    if (s.kind === "plan" && !s.filled) assert.strictEqual(s.netR, 0);
  }
});

test("buildPlanStatsFile memuat kelompok oos/train dan caveats", () => {
  const cs = synthCandles(1200, 3);
  const samples = runPlanBacktest(cs, { coin: "SYN", tf: "1H" });
  const f = buildPlanStatsFile(samples, { coins: ["SYN"], tfs: ["1H"] }, {});
  assert.ok(f.caveats.length >= 3);
  assert.ok(f.oos["1H|any"]);
  assert.ok(f.nTrain > 0 && f.nOos > 0);
});
