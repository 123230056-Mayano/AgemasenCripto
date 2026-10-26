"use strict";

/**
 * features/kripto/dusdt.js
 * ------------------------------------------------------------------
 * !dusdt [15m|1H|4H|1D] -> USDT Dominance (USDT.D): nilai terkini, perubahan pada timeframe
 * yang dipilih, arah (NAIK / TURUN / SIDEWAYS), interpretasi, plus konfirmasi BTC.D & harga BTC.
 *
 * Sumber data (semua API publik yang terdokumentasi / dipakai resmi oleh proyek ini; TradingView
 * TIDAK di-scrape):
 *   - CoinGecko  GET /api/v3/global                    -> USDT.D & BTC.D terkini (market_cap_percentage),
 *                                                          total market cap, waktu pembaruan (updated_at)
 *   - CoinGecko  GET /api/v3/coins/tether/market_chart -> riwayat kapitalisasi pasar USDT
 *   - CoinMarketCap data-api (sama dengan dominance.js) -> riwayat total market cap & BTC.D
 *   - Binance    GET /api/v3/klines (BTCUSDT 15m)      -> harga BTC saat ini & pada awal periode
 *
 * Rumus: USDT.D (%) = kapitalisasi USDT / total kapitalisasi pasar kripto x 100.
 *
 * Perubahan dihitung rolling: nilai sekarang dibanding nilai tepat satu timeframe lalu (4H -> 4 jam lalu).
 * Riwayat USDT.D dihitung dari rasio kapitalisasi USDT (CoinGecko) / total (CoinMarketCap). Karena dua
 * penyedia punya definisi "total" yang sedikit beda, yang dipakai dari rasio itu hanya PERUBAHAN RELATIFNYA;
 * levelnya tetap angka resmi CoinGecko. Kalau CoinGecko /global gagal tapi riwayat ada, level dihitung
 * langsung dari rasio itu (dan sumbernya ditulis).
 *
 * Aturan keras: TIDAK PERNAH mengarang angka / timestamp. Bagian yang gagal diambil dilewati atau
 * ditulis "belum tersedia"; kalau level terkini pun tak bisa didapat, balasannya pesan gagal saja.
 * Setiap fetcher mengembalikan null saat gagal (tidak melempar), ber-timeout, di-cache, dan permintaan
 * yang sama yang berbarengan digabung jadi satu (dedupe) supaya antrean API bot tidak terbebani.
 *
 * Env opsional: COINGECKO_BASE, COINGECKO_API_KEY (demo key, dikirim sebagai x-cg-demo-api-key),
 *               CMC_DATA_BASE, BINANCE_BASE
 */

const axios = require("axios");
const { t } = require("../../i18n");

const CG = (process.env.COINGECKO_BASE || "https://api.coingecko.com").replace(/\/+$/, "");
const CMC = (process.env.CMC_DATA_BASE || "https://api.coinmarketcap.com").replace(/\/+$/, "");
const BINANCE = (process.env.BINANCE_BASE || "https://data-api.binance.vision").replace(/\/+$/, "");
const CG_HEADERS = process.env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY } : {};

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * sideways : |perubahan USDT.D| (poin persentase) di bawah ini dianggap SIDEWAYS
 * btcFlat  : |perubahan harga BTC| (%) di bawah ini dianggap datar
 * cgDays   : parameter days CoinGecko (1 hari -> data per 5 menit, 2-90 hari -> per jam)
 * cmcInterval / cmcMs : interval riwayat CoinMarketCap
 * Ambang adalah heuristik; sesuaikan di sini bila perlu.
 */
const TF = {
  "15M": { label: "15m", ms: 15 * MIN, sideways: 0.01, btcFlat: 0.15, cgDays: 1, cmcInterval: "15m", cmcMs: 15 * MIN },
  "1H": { label: "1H", ms: HOUR, sideways: 0.03, btcFlat: 0.3, cgDays: 2, cmcInterval: "15m", cmcMs: 15 * MIN },
  "4H": { label: "4H", ms: 4 * HOUR, sideways: 0.06, btcFlat: 0.6, cgDays: 2, cmcInterval: "1h", cmcMs: HOUR },
  "1D": { label: "1D", ms: 24 * HOUR, sideways: 0.12, btcFlat: 1.0, cgDays: 2, cmcInterval: "1h", cmcMs: HOUR },
};

const TTL = { global: 2 * MIN, tether: 5 * MIN, cmc: 5 * MIN, btc: 1 * MIN };
const FAIL_TTL = 30_000; // gagal di-cache singkat agar API yang sedang down tidak digempur
const STALE_MS = 30 * MIN; // data penyedia lebih tua dari ini -> beri peringatan
const BTCD_MIN_MOVE = 0.03; // pp; di bawah ini BTC.D tidak dikomentari

// ---------- cache + dedupe ----------
const store = new Map(); // key -> { p: Promise, exp }

function memo(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && Date.now() < hit.exp) return hit.p;
  const entry = { exp: Date.now() + ttlMs };
  entry.p = (async () => {
    try {
      return await fn();
    } catch (err) {
      console.log(`[dusdt] ${key} gagal:`, err.response?.status || err.code || err.message);
      return null;
    }
  })();
  entry.p.then((v) => {
    if (v == null) entry.exp = Date.now() + FAIL_TTL;
  });
  store.set(key, entry);
  return entry.p;
}

// ---------- fetchers (null bila gagal) ----------
const isNum = (v) => typeof v === "number" && isFinite(v);

function fetchGlobal() {
  return memo("global", TTL.global, async () => {
    const res = await axios.get(`${CG}/api/v3/global`, { timeout: 10_000, headers: CG_HEADERS });
    const d = res.data?.data;
    const usdt = Number(d?.market_cap_percentage?.usdt);
    if (!isNum(usdt) || usdt <= 0 || usdt >= 100) return null;
    const btc = Number(d?.market_cap_percentage?.btc);
    const upd = Number(d?.updated_at);
    return {
      usdt,
      btc: isNum(btc) && btc > 0 && btc < 100 ? btc : null,
      updatedAt: isNum(upd) && upd > 0 ? upd * 1000 : null,
    };
  });
}

function fetchTether(days) {
  return memo(`tether:${days}`, TTL.tether, async () => {
    const res = await axios.get(`${CG}/api/v3/coins/tether/market_chart`, {
      params: { vs_currency: "usd", days },
      timeout: 12_000,
      headers: CG_HEADERS,
    });
    const arr = res.data?.market_caps;
    if (!Array.isArray(arr)) return null;
    const out = arr
      .map(([t0, v]) => ({ t: Number(t0), v: Number(v) }))
      .filter((p) => isNum(p.t) && isNum(p.v) && p.v > 0)
      .sort((a, b) => a.t - b.t);
    return out.length >= 2 ? out : null;
  });
}

/** Riwayat total market cap + BTC.D. Parser longgar: bentuk respons data-api bisa berubah. */
function fetchCmc(tf) {
  const def = TF[tf];
  return memo(`cmc:${tf}`, TTL.cmc, async () => {
    const now = Date.now();
    const res = await axios.get(`${CMC}/data-api/v3/global-metrics/quotes/historical`, {
      params: {
        convertId: 2781, // USD
        timeStart: Math.floor((now - def.ms - 2 * HOUR) / 1000),
        timeEnd: Math.floor(now / 1000),
        interval: def.cmcInterval,
      },
      timeout: 12_000,
    });
    const quotes = res.data?.data?.quotes;
    if (!Array.isArray(quotes)) return null;
    const out = [];
    for (const q of quotes) {
      const t0 = Date.parse(q.timestamp || q.quote?.[0]?.timestamp);
      const total = Number(q.quote?.[0]?.totalMarketCap ?? q.totalMarketCap);
      const btcD = Number(q.btcDominance ?? q.quote?.[0]?.btcDominance);
      if (!isNum(t0) || !isNum(total) || total <= 0) continue;
      out.push({ t: t0, total, btcD: isNum(btcD) ? btcD : null });
    }
    out.sort((a, b) => a.t - b.t);
    return out.length >= 2 ? out : null;
  });
}

function fetchBtc() {
  return memo("btc", TTL.btc, async () => {
    const res = await axios.get(`${BINANCE}/api/v3/klines`, {
      params: { symbol: "BTCUSDT", interval: "15m", limit: 100 }, // ~25 jam
      timeout: 10_000,
    });
    if (!Array.isArray(res.data)) return null;
    const out = res.data
      .map((k) => ({ t: Number(k[0]), open: Number(k[1]), close: Number(k[4]) }))
      .filter((k) => isNum(k.t) && isNum(k.open) && isNum(k.close) && k.open > 0);
    return out.length >= 2 ? out : null;
  });
}

// ---------- perhitungan (fungsi murni, mudah diuji) ----------
/** Titik terdekat dengan waktu target, atau null bila selisihnya melebihi toleransi. */
function nearest(series, target, tol) {
  let best = null;
  let gap = Infinity;
  for (const p of series) {
    const g = Math.abs(p.t - target);
    if (g < gap) {
      gap = g;
      best = p;
    }
  }
  return best && gap <= tol ? best : null;
}

/**
 * Rasio USDT.D (%) pada titik riwayat CMC, memakai kapitalisasi USDT terdekat dari CoinGecko.
 * @returns {{rNow:number, rRef:number, latestT:number, btcDNow:number|null, btcDRef:number|null}|null}
 */
function ratioWindow(tether, cmc, def, nowMs = Date.now()) {
  if (!tether?.length || !cmc?.length) return null;
  const tetherTol = def.cgDays === 1 ? 10 * MIN : 45 * MIN;
  const ratioAt = (p) => {
    const tt = nearest(tether, p.t, tetherTol);
    return tt ? (tt.v / p.total) * 100 : null;
  };
  const latest = cmc[cmc.length - 1];
  if (nowMs - latest.t > 3 * def.cmcMs + 15 * MIN) return null; // riwayat terlalu basi
  const ref = nearest(cmc, latest.t - def.ms, def.cmcMs);
  if (!ref) return null;
  const rNow = ratioAt(latest);
  const rRef = ratioAt(ref);
  if (!isNum(rNow) || !isNum(rRef) || rNow <= 0 || rRef <= 0 || rNow >= 100 || rRef >= 100) return null;
  return { rNow, rRef, latestT: latest.t, btcDNow: latest.btcD, btcDRef: ref.btcD };
}

/** Perubahan harga BTC (%) selama satu timeframe, dari klines 15m; null bila data tidak cukup. */
function btcMove(klines, def, nowMs = Date.now()) {
  if (!klines?.length) return null;
  const last = klines[klines.length - 1];
  if (nowMs - last.t > 30 * MIN) return null; // klines basi
  const ref = nearest(klines, nowMs - def.ms, 15 * MIN);
  if (!ref) return null;
  return { price: last.close, changePct: (last.close / ref.open - 1) * 100 };
}

function direction(deltaPp, def) {
  if (!isNum(deltaPp)) return null;
  if (Math.abs(deltaPp) < def.sideways) return "side";
  return deltaPp > 0 ? "up" : "down";
}

/**
 * Gabungkan semua sumber jadi satu hasil. Mengembalikan null kalau level terkini tidak bisa didapat.
 * @returns {object|null}
 */
function buildResult(tf, g, tether, cmc, klines, nowMs = Date.now()) {
  const def = TF[tf];
  const win = ratioWindow(tether, cmc, def, nowMs);
  const sources = new Set();

  let level = null;
  let updatedAt = null;
  let levelFromSeries = false;
  if (g) {
    level = g.usdt;
    updatedAt = g.updatedAt;
    sources.add("CoinGecko");
  } else if (win) {
    level = win.rNow; // rumus: kapitalisasi USDT / total kapitalisasi pasar x 100
    updatedAt = win.latestT;
    levelFromSeries = true;
  }
  if (!isNum(level)) return null;

  let deltaPp = null;
  let relPct = null;
  let btcdDelta = null;
  if (win) {
    sources.add("CoinGecko").add("CoinMarketCap");
    const rel = win.rNow / win.rRef - 1;
    if (Math.abs(rel) <= 0.25) {
      // > 25% dalam satu timeframe tidak masuk akal -> anggap data rusak, jangan ditampilkan
      relPct = rel * 100;
      deltaPp = levelFromSeries ? win.rNow - win.rRef : level - level / (1 + rel);
    }
    if (isNum(win.btcDNow) && isNum(win.btcDRef)) btcdDelta = win.btcDNow - win.btcDRef;
  }

  const btc = btcMove(klines, def, nowMs);
  if (btc) sources.add("Binance");

  const dir = direction(deltaPp, def);
  return {
    tf,
    tfLabel: def.label,
    level,
    deltaPp,
    relPct,
    dir,
    threshold: def.sideways,
    btcD: g?.btc ?? (win && isNum(win.btcDNow) ? win.btcDNow : null),
    btcdDelta,
    btc: btc ? { price: btc.price, changePct: btc.changePct, state: Math.abs(btc.changePct) < def.btcFlat ? "flat" : btc.changePct > 0 ? "up" : "down" } : null,
    updatedAt: updatedAt || null,
    fetchedAt: nowMs,
    stale: !!updatedAt && nowMs - updatedAt > STALE_MS,
    sources: [...sources],
  };
}

async function getDusdt(tf) {
  const def = TF[tf];
  if (!def) return null;
  const [g, tether, cmc, klines] = await Promise.all([fetchGlobal(), fetchTether(def.cgDays), fetchCmc(tf), fetchBtc()]);
  return buildResult(tf, g, tether, cmc, klines);
}

// ---------- format pesan ----------
const fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
const fmtPctS = (v) => `${fmtSigned(v)}%`;
const fmtUsd0 = (v) => "$" + v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 });

function fmtTime(lang, ms) {
  const d = new Date(ms);
  const tz = "Asia/Jakarta";
  const date = d.toLocaleDateString(lang === "en" ? "en-GB" : "id-ID", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }); // HH:MM
  return `${date} ${time} WIB`;
}

function buildAnalysis(lang, r) {
  if (!r.dir) return t(lang, "dusdt.an.noChange", { tf: r.tfLabel });
  const parts = [
    t(lang, `dusdt.an.${r.dir}`, { tf: r.tfLabel, delta: Math.abs(r.deltaPp).toFixed(2), th: r.threshold }),
  ];
  if (r.btc) parts.push(t(lang, `dusdt.an.${r.dir}.btc${r.btc.state}`, { pct: fmtPctS(r.btc.changePct) }));
  if (isNum(r.btcdDelta) && Math.abs(r.btcdDelta) >= BTCD_MIN_MOVE) {
    parts.push(t(lang, r.btcdDelta > 0 ? "dusdt.an.btcdUp" : "dusdt.an.btcdDown", { x: Math.abs(r.btcdDelta).toFixed(2) }));
  }
  return parts.join(" ");
}

/** @returns {string} teks WhatsApp */
function formatDusdt(lang, r) {
  const lines = [t(lang, "dusdt.title"), t(lang, "dusdt.level", { v: r.level.toFixed(2) })];

  if (isNum(r.deltaPp)) {
    lines.push(t(lang, "dusdt.change", { tf: r.tfLabel, pp: fmtSigned(r.deltaPp), rel: fmtPctS(r.relPct) }));
  } else {
    lines.push(t(lang, "dusdt.change.na", { tf: r.tfLabel }));
  }
  const dirIcon = { up: "🔼", down: "🔽", side: "➡️" }[r.dir] || "❔";
  lines.push(t(lang, "dusdt.dir", { icon: dirIcon, dir: r.dir ? t(lang, `dusdt.dir.${r.dir}`) : t(lang, "dusdt.dir.na") }));
  lines.push(t(lang, "dusdt.tf", { tf: r.tfLabel }));
  lines.push(
    r.updatedAt
      ? t(lang, "dusdt.update", { time: fmtTime(lang, r.updatedAt) })
      : t(lang, "dusdt.update.fetched", { time: fmtTime(lang, r.fetchedAt) }),
  );
  if (r.stale) lines.push(t(lang, "dusdt.stale", { min: Math.round((r.fetchedAt - r.updatedAt) / MIN) }));

  const confirm = [];
  if (isNum(r.btcD)) {
    confirm.push(
      isNum(r.btcdDelta)
        ? t(lang, "dusdt.confirm.btcd", { v: r.btcD.toFixed(2), d: fmtSigned(r.btcdDelta) })
        : t(lang, "dusdt.confirm.btcdNoDelta", { v: r.btcD.toFixed(2) }),
    );
  }
  if (r.btc) confirm.push(t(lang, "dusdt.confirm.btc", { price: fmtUsd0(r.btc.price), pct: fmtPctS(r.btc.changePct), tf: r.tfLabel }));
  if (confirm.length) lines.push("", ...confirm);

  lines.push("", t(lang, "dusdt.analysis.title"), buildAnalysis(lang, r), "", t(lang, "dusdt.note"), t(lang, "dusdt.source", { src: r.sources.join(", ") }));
  return lines.join("\n");
}

// ---------- command ----------
const DUSDT_COMMANDS = {
  dusdt: { re: /^!dusdt(?:\s+([\s\S]*))?$/i },
};

/** "" -> timeframe default; "4h" / "1D" -> itu; selain itu null (-> penjelasan command). */
function parseDusdtArgs(name, raw, defaultTf = "4H") {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { tf: TF[defaultTf] ? defaultTf : "4H" };
  if (tokens.length > 1) return null;
  const tf = tokens[0].toUpperCase();
  return TF[tf] ? { tf } : null;
}

async function runDusdt(sock, msg, { jid, lang }, { tf }) {
  const result = await getDusdt(tf);
  const text = result ? formatDusdt(lang, result) : t(lang, "dusdt.unavailable");
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

const DUSDT_RUNNERS = { dusdt: runDusdt };

module.exports = {
  DUSDT_COMMANDS,
  DUSDT_RUNNERS,
  parseDusdtArgs,
  // diekspor untuk pengujian
  getDusdt,
  buildResult,
  formatDusdt,
  ratioWindow,
  btcMove,
  direction,
  TF,
};
