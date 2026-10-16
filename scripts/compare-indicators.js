"use strict";
/**
 * Bandingkan RSI/MACD/ATR bot vs web analyst pada candle Binance NYATA (kriteria selesai item 01:
 * cocok untuk minimal 5 koin di 4 TF). Jalankan dari server bot (butuh akses Binance):
 *
 *   node scripts/compare-indicators.js /path/ke/KriptoPredict-main/lib/indicators.js [BTC ETH SOL BNB XRP]
 *
 * Kedua sisi dihitung dari candle closed yang SAMA (fetchCandles bot), jadi selisih = selisih rumus.
 * Exit code 1 bila ada nilai yang beda > 1e-9 (relatif).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchCandles } = require("../src/features/kripto/market");
const { rsi, macd, atr } = require("../src/features/kripto/indicators");

const TFS = ["15M", "1H", "4H", "1D"];
const near = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

(async () => {
  const [src, ...coinsArg] = process.argv.slice(2);
  if (!src) throw new Error("Argumen pertama: path ke KriptoPredict-main/lib/indicators.js");
  const coins = coinsArg.length ? coinsArg : ["BTC", "ETH", "SOL", "BNB", "XRP"];
  const tmp = path.join(os.tmpdir(), `web-indicators-${Date.now()}.mjs`);
  fs.copyFileSync(src, tmp);
  const web = await import(tmp);

  let bad = 0;
  let total = 0;
  for (const coin of coins) {
    for (const tf of TFS) {
      const candles = await fetchCandles(coin, tf);
      const closes = candles.map((c) => c.c);
      const n = closes.length;
      const mb = macd(closes);
      const mw = web.macd(closes);
      const rows = [
        ["rsi", rsi(closes)[n - 1], web.rsi(closes)],
        ["macd", mb.macd[n - 1], mw?.macd ?? null],
        ["signal", mb.signal[n - 1], mw?.signal ?? null],
        ["hist", mb.hist[n - 1], mw?.histogram ?? null],
        ["atr", atr(candles)[n - 1], web.atr(candles)],
      ];
      for (const [name, a, b] of rows) {
        total++;
        if (!near(a, b)) {
          bad++;
          console.log(`BEDA ${coin} ${tf} ${name}: bot=${a} web=${b}`);
        }
      }
      console.log(`${coin} ${tf}: ${n} candle, ${rows.map((r) => `${r[0]}=${r[1] == null ? "n/a" : r[1].toFixed(4)}`).join(" ")}`);
    }
  }
  fs.unlinkSync(tmp);
  console.log(bad ? `\n${bad}/${total} nilai BEDA.` : `\nOK: ${total} nilai cocok (${coins.length} koin x ${TFS.length} TF).`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
