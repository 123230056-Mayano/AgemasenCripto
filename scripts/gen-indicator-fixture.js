"use strict";
/**
 * Hasilkan fixture parity bot <-> web analyst.
 * Pakai:  node scripts/gen-indicator-fixture.js /path/ke/KriptoPredict-main/lib/indicators.js
 * Deret candle sintetis deterministik (seeded), jadi fixture bisa dibuat ulang kapan saja.
 * Nilai "expected" diambil dari fungsi web asli (rsi/macd/atr/ema), bukan dihitung ulang di bot.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function makeCandles(n, seed, start) {
  const rnd = lcg(seed);
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * (1 + (rnd() - 0.48) * 0.04);
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    out.push({ t: i * 3600_000, o, h, l, c, v: 1000 + rnd() * 500 });
    price = c;
  }
  return out;
}

(async () => {
  const src = process.argv[2];
  if (!src) throw new Error("Argumen: path ke KriptoPredict-main/lib/indicators.js");
  const tmp = path.join(os.tmpdir(), `web-indicators-${Date.now()}.mjs`);
  fs.copyFileSync(src, tmp);
  const web = await import(tmp);

  const cases = [
    { name: "btc-like-300", n: 300, seed: 1, start: 60000 },
    { name: "alt-like-320", n: 320, seed: 7, start: 0.42 },
    { name: "newlisting-120", n: 120, seed: 42, start: 3.1 },
    { name: "short-40", n: 40, seed: 99, start: 15 },
  ].map((c) => {
    const candles = makeCandles(c.n, c.seed, c.start);
    const closes = candles.map((x) => x.c);
    const m = web.macd(closes);
    return {
      name: c.name,
      candles,
      expected: {
        rsi: web.rsi(closes),
        macd: m && { macd: m.macd, signal: m.signal, histogram: m.histogram },
        atr: web.atr(candles),
        ema20: web.ema(closes, 20).at(-1),
        ema50: web.ema(closes, 50).at(-1),
        ema200: web.ema(closes, 200).at(-1),
      },
    };
  });
  const dest = path.join(__dirname, "..", "src", "test", "fixtures", "indicator-parity.json");
  fs.writeFileSync(dest, JSON.stringify({ generatedFrom: "KriptoPredict lib/indicators.js", cases }));
  fs.unlinkSync(tmp);
  console.log("OK ->", dest);
})();
