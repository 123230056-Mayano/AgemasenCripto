"use strict";
/**
 * Item 06, Langkah 1: uji akses endpoint publik Funding Rate + Open Interest.
 * JALANKAN DI SERVER BOT (bukan laptop), karena yang diuji adalah IP/wilayah server itu:
 *
 *   node scripts/test-futures-access.js            # uji BTCUSDT
 *   node scripts/test-futures-access.js SOLUSDT    # uji simbol lain
 *
 * Menguji Binance Futures (utama) + Bybit & OKX (kandidat alternatif) supaya keputusan
 * "Binance saja atau exchange lain?" bisa diambil langsung dari hasilnya.
 * Hanya endpoint publik (tanpa API key). Hasil dicetak + disimpan ke futures-access-report.json
 * untuk dilampirkan ke laporan client (kriteria selesai: hasil uji terdokumentasi).
 *
 * Exit code: 0 = Binance Futures lolos semua; 1 = ada yang gagal (lihat kolom VERDICT).
 */
const fs = require("fs");
const axios = require("axios");

const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const BASE = SYMBOL.replace(/USDT$/, "");
const TIMEOUT = 10_000;

const TESTS = [
  // ---- Binance USDT-M Futures (sumber utama) ----
  { src: "Binance", name: "funding+mark (premiumIndex)", url: "https://fapi.binance.com/fapi/v1/premiumIndex", params: { symbol: SYMBOL } },
  { src: "Binance", name: "open interest sekarang", url: "https://fapi.binance.com/fapi/v1/openInterest", params: { symbol: SYMBOL } },
  { src: "Binance", name: "OI histori 1h (untuk delta 1H/4H/24H)", url: "https://fapi.binance.com/futures/data/openInterestHist", params: { symbol: SYMBOL, period: "1h", limit: 30 } },
  { src: "Binance", name: "funding histori", url: "https://fapi.binance.com/fapi/v1/fundingRate", params: { symbol: SYMBOL, limit: 3 } },
  { src: "Binance", name: "daftar kontrak perpetual (exchangeInfo)", url: "https://fapi.binance.com/fapi/v1/exchangeInfo", params: {}, light: true },
  // ---- Alternatif ----
  { src: "Bybit", name: "tickers linear (funding+OI)", url: "https://api.bybit.com/v5/market/tickers", params: { category: "linear", symbol: SYMBOL } },
  { src: "Bybit", name: "OI histori 1h", url: "https://api.bybit.com/v5/market/open-interest", params: { category: "linear", symbol: SYMBOL, intervalTime: "1h", limit: 30 } },
  { src: "OKX", name: "funding rate", url: "https://www.okx.com/api/v5/public/funding-rate", params: { instId: `${BASE}-USDT-SWAP` } },
  { src: "OKX", name: "open interest", url: "https://www.okx.com/api/v5/public/open-interest", params: { instType: "SWAP", instId: `${BASE}-USDT-SWAP` } },
];

function verdict(status, errCode) {
  if (status >= 200 && status < 300) return "OK";
  if (status === 451) return "DIBLOKIR WILAYAH (451)";
  if (status === 403) return "DITOLAK/WAF (403)";
  if (status === 418 || status === 429) return `RATE LIMIT/BAN IP (${status})`;
  if (status) return `HTTP ${status}`;
  if (["ECONNABORTED", "ETIMEDOUT"].includes(errCode)) return "TIMEOUT";
  if (errCode === "ERR_TLS_CERT_ALTNAME_INVALID") return "DICEGAT JARINGAN/ISP (sertifikat bukan milik exchange) - hasil TIDAK valid, uji dari jaringan lain";
  if (errCode === "ENOTFOUND") return "DNS GAGAL (diblokir DNS/ISP atau tidak ada internet)";
  return `GAGAL (${errCode || "?"})`;
}

async function run(t) {
  const t0 = Date.now();
  try {
    const res = await axios.get(t.url, { params: t.params, timeout: TIMEOUT, validateStatus: () => true });
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 300;
    let sample = "";
    if (ok) {
      const d = res.data;
      sample = t.light ? `${(d.symbols || []).filter((s) => s.contractType === "PERPETUAL").length} perpetual` : JSON.stringify(Array.isArray(d) ? d[0] : d).slice(0, 110);
    } else {
      sample = typeof res.data === "string" ? res.data.slice(0, 110) : JSON.stringify(res.data).slice(0, 110);
    }
    return { ...t, status: res.status, ms, verdict: verdict(res.status), sample };
  } catch (err) {
    return { ...t, status: 0, ms: Date.now() - t0, verdict: verdict(0, err.code), sample: err.message };
  }
}

(async () => {
  const startedAt = new Date().toISOString();
  let ip = "?";
  try {
    ip = (await axios.get("https://api.ipify.org?format=json", { timeout: 5000 })).data.ip;
  } catch {
    /* abaikan */
  }
  console.log(`Uji akses futures | simbol ${SYMBOL} | IP publik server: ${ip} | ${startedAt}\n`);

  const results = [];
  for (const t of TESTS) {
    const r = await run(t);
    results.push(r);
    console.log(`[${r.src.padEnd(7)}] ${r.name.padEnd(40)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.verdict}`);
    if (r.verdict !== "OK") console.log(`           ${r.sample}`);
    await new Promise((r2) => setTimeout(r2, 300)); // sopan, jangan memicu rate limit
  }

  const summary = {};
  for (const r of results) {
    summary[r.src] ||= { ok: 0, total: 0 };
    summary[r.src].total++;
    if (r.verdict === "OK") summary[r.src].ok++;
  }
  console.log("\nRINGKASAN");
  for (const [src, s] of Object.entries(summary)) console.log(`  ${src}: ${s.ok}/${s.total} endpoint OK`);

  const binOk = summary.Binance.ok === summary.Binance.total;
  console.log(
    binOk
      ? "\nKESIMPULAN: Binance Futures bisa diakses -> lanjut Langkah 2 dengan Binance."
      : "\nKESIMPULAN: Binance Futures TIDAK (penuh) bisa diakses dari server ini -> laporkan ke client sebelum lanjut (alternatif: Bybit/OKX atau proxy)."
  );

  fs.writeFileSync("futures-access-report.json", JSON.stringify({ startedAt, ip, symbol: SYMBOL, summary, results }, null, 2));
  console.log("Laporan disimpan: futures-access-report.json");
  process.exit(binOk ? 0 : 1);
})();