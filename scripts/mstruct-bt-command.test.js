"use strict";
const test = require("node:test");
const assert = require("node:assert");
const cmd = require("../features/kripto/mstrutPlanBtCommand");
const { buildMstrutPlanBtPdf } = require("../features/kripto/mstrutPlanBtPdf");
const { UnsupportedCoinError } = require("../features/kripto/market");

// candle sintetis (random walk bergelombang, seed tetap)
function synth(n, seed = 7, tfMs = 3600e3, start = 40000) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [];
  let p = start;
  const t0 = Date.now() - n * tfMs;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + Math.sin(i / 40) * 0.0025 + (rnd() - 0.5) * 0.012);
    out.push({ t: t0 + i * tfMs, o: p, h: Math.max(p, c) * (1 + rnd() * 0.004), l: Math.min(p, c) * (1 - rnd() * 0.004), c, v: 1, qv: 1, ct: t0 + (i + 1) * tfMs - 1 });
    p = c;
  }
  return out;
}
const fakeFetch = async (coin, tf, { bars }) => {
  if (coin === "NOPE") throw new UnsupportedCoinError(coin);
  return synth(bars, coin.length * 11 + tf.length);
};

test("parser: default, koin, tf, bars, flag", () => {
  const d = cmd.parseMstructBtArgs("mstruct", "");
  assert.deepStrictEqual(d.coins, ["BTC", "ETH", "SOL"]);
  assert.deepStrictEqual(d.tfs, ["1H", "4H"]);
  assert.strictEqual(d.bars, 3000);
  const a = cmd.parseMstructBtArgs("mstruct", "btcusdt eth/usdt H4 m15 bars 2000 nocost overlap nobe");
  assert.deepStrictEqual(a.coins, ["BTC", "ETH"]);
  assert.deepStrictEqual(a.tfs, ["15M", "4H"]);
  assert.strictEqual(a.bars, 2000);
  assert.deepStrictEqual(a.sim, { feeBps: 0, slipBps: 0, nonOverlap: false, beAfterTp1: false });
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "sol bars=1000").bars, 1000);
});

test("parser: menolak input di luar batas", () => {
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "a b c d e f"), null); // > 5 koin
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "btc bars 100"), null); // terlalu kecil
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "btc bars 9000"), null); // terlalu besar
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "btc bars"), null); // angka hilang
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "a b c d e 15m 1h 4h 1d bars 3000"), null); // total terlalu berat
  assert.strictEqual(cmd.parseMstructBtArgs("mstruct", "btc $$"), null);
});

test("regex command: !mstruct = backtest, !mstrut tetap analisis", () => {
  const re = cmd.MSTRUCTBT_COMMANDS.mstruct.re;
  assert.ok(re.test("!mstruct btc"));
  assert.ok(re.test("!MSTRUCT"));
  assert.ok(re.test("!mstrutbt eth 4h"));
  assert.ok(!re.test("!mstrut btc"));
  assert.ok(!re.test("!alertmstruct btc"));
});

test("collectBacktest: koin tak dikenal dilewati; semua tak dikenal -> error", async () => {
  const a = cmd.parseMstructBtArgs("mstruct", "btc nope 1h bars 1500");
  const r = await cmd.collectBacktest(a, { fetchHistory: fakeFetch });
  assert.deepStrictEqual(r.skipped, ["NOPE"]);
  assert.deepStrictEqual(r.stats.coins, ["BTC"]);
  assert.ok(r.samples.length > 0);
  await assert.rejects(cmd.collectBacktest(cmd.parseMstructBtArgs("mstruct", "nope 1h"), { fetchHistory: fakeFetch }), UnsupportedCoinError);
});

test("PDF: id & en menghasilkan PDF valid, multi-TF", async () => {
  const a = cmd.parseMstructBtArgs("mstruct", "btc eth 1h 4h bars 3000");
  const r = await cmd.collectBacktest(a, { fetchHistory: fakeFetch });
  for (const lang of ["id", "en"]) {
    const pdf = await buildMstrutPlanBtPdf({ stats: r.stats, samples: r.samples, lang, coins: r.coins, tfs: a.tfs, bars: a.bars, params: r.params, skipped: [] });
    assert.strictEqual(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 3000);
  }
});

test("runMstructBacktest: kirim 1 dokumen PDF + caption pendek, cache dipakai ulang", async () => {
  cmd._cache.clear();
  let fetches = 0;
  cmd._deps.fetchHistory = async (...x) => { fetches++; return fakeFetch(...x); };
  const sent = [];
  const sock = { sendMessage: async (jid, content, opts) => sent.push({ jid, content, opts }) };
  const a = cmd.parseMstructBtArgs("mstruct", "btc 1h bars 2000");
  await cmd.runMstructBacktest(sock, { key: {} }, { jid: "x@s.whatsapp.net", lang: "id" }, a);
  const doc = sent.find((m) => m.content.document);
  assert.ok(doc, "dokumen terkirim");
  assert.strictEqual(doc.content.mimetype, "application/pdf");
  assert.match(doc.content.fileName, /^MSTRUCT-Backtest-BTC-1H-\d+\.pdf$/);
  assert.ok(doc.content.caption.length <= 1000);
  assert.strictEqual(sent.filter((m) => m.content.text).length, 1); // hanya pesan "working"
  const n1 = fetches;
  await cmd.runMstructBacktest(sock, { key: {} }, { jid: "x@s.whatsapp.net", lang: "en" }, a);
  assert.strictEqual(fetches, n1, "hasil dari cache, tidak fetch ulang");
});
