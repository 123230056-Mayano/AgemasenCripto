"use strict";

/**
 * features/kripto/dusdt.js
 * ------------------------------------------------------------------
 * !dusdt [15m|1H|4H|1D] -> USDT Dominance (USDT.D) ditampilkan seperti sebuah koin: nilai terkini,
 * perubahan pada timeframe yang dipilih, arah (NAIK / TURUN / SIDEWAYS), lalu struktur HHLL
 * (Higher High / Lower Low) dan Fibonacci yang dihitung dari candle USDT.D itu sendiri
 * (logika sama dengan !hhll -> hhllCore.js dan !fib -> fib.js; levelnya dalam persen dominasi).
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
const { computeStructure, CFG: HHLL_CFG } = require("./hhllCore");
const { computeFib, retraceDepth } = require("./fib");
const { fmtWhen, renderHhllChart } = require("./hhll");
const { renderChart } = require("../analisis/analisisChart");
const { computeLevels } = require("./market");

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

/**
 * Riwayat untuk membangun candle USDT.D (dipakai HHLL & Fib).
 * bucketMs : lebar satu candle (sejajar UTC seperti Binance) | cmcInterval : interval data total market cap
 * spanMs   : panjang riwayat yang diminta                    | cgDays : parameter days kapitalisasi USDT CoinGecko
 * (1 hari -> per 5 menit, 2-90 hari -> per jam)
 */
const DAY = 24 * HOUR;
const SERIES = {
  "15M": { bucketMs: 15 * MIN, cmcInterval: "15m", cmcMs: 15 * MIN, spanMs: DAY, cgDays: 1 },
  "1H": { bucketMs: HOUR, cmcInterval: "15m", cmcMs: 15 * MIN, spanMs: 5 * DAY, cgDays: 7 },
  "4H": { bucketMs: 4 * HOUR, cmcInterval: "1h", cmcMs: HOUR, spanMs: 30 * DAY, cgDays: 30 },
  "1D": { bucketMs: DAY, cmcInterval: "1h", cmcMs: HOUR, spanMs: 90 * DAY, cgDays: 90 },
};
// Dominasi bergerak kecil (sekitar 5-6%), jadi gerak minimal antar swing HHLL dibuat lebih kecil dari koin biasa.
const DUSDT_MIN_SWING_PCT = 0.3;
const HHLL_SHOW = 4; // jumlah swing terakhir yang ditulis
const FIB_EXT_SHOW = 2; // extension yang ditulis (1.272 & 1.618)

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

/** Parser longgar: bentuk respons data-api bisa berubah. */
function parseCmcQuotes(res) {
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
}

function cmcRequest(interval, fromMs, toMs) {
  return axios.get(`${CMC}/data-api/v3/global-metrics/quotes/historical`, {
    params: {
      convertId: 2781, // USD
      timeStart: Math.floor(fromMs / 1000),
      timeEnd: Math.floor(toMs / 1000),
      interval,
    },
    timeout: 12_000,
  });
}

/** Riwayat total market cap + BTC.D untuk satu timeframe (jendela pendek, dipakai level & perubahan). */
function fetchCmc(tf) {
  const def = TF[tf];
  return memo(`cmc:${tf}`, TTL.cmc, async () => {
    const now = Date.now();
    return parseCmcQuotes(await cmcRequest(def.cmcInterval, now - def.ms - 2 * HOUR, now));
  });
}

/** Riwayat total market cap yang panjang, untuk membangun candle HHLL / Fib. */
function fetchCmcSeries(tf) {
  const def = SERIES[tf];
  return memo(`cmcs:${tf}`, TTL.cmc, async () => {
    const now = Date.now();
    return parseCmcQuotes(await cmcRequest(def.cmcInterval, now - def.spanMs - def.bucketMs, now));
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
 * Candle USDT.D (o/h/l/c dalam persen dominasi) dari riwayat: tiap titik total market cap CMC dipasangkan
 * dengan kapitalisasi USDT terdekat, lalu dikelompokkan per bucket timeframe. Hanya candle yang sudah closed;
 * candle pertama yang datanya tidak penuh dibuang. Seluruh deret diskalakan supaya titik terakhirnya
 * sama dengan level resmi (`level`), sama seperti aturan di header file ini (hanya perubahan relatif yang dipakai).
 * @returns {{t:number,o:number,h:number,l:number,c:number}[]|null}
 */
function buildCandles(tether, cmc, tf, level, nowMs = Date.now()) {
  const def = SERIES[tf];
  if (!def || !tether?.length || !cmc?.length || !isNum(level)) return null;
  const tol = def.cgDays === 1 ? 10 * MIN : 45 * MIN;
  const pts = [];
  for (const p of cmc) {
    const tt = nearest(tether, p.t, tol);
    if (!tt) continue;
    const r = (tt.v / p.total) * 100;
    if (isNum(r) && r > 0 && r < 100) pts.push({ t: p.t, r });
  }
  if (pts.length < 2) return null;
  if (nowMs - pts[pts.length - 1].t > 3 * def.cmcMs + 15 * MIN) return null; // riwayat terlalu basi
  const k = level / pts[pts.length - 1].r;

  const buckets = new Map();
  for (const p of pts) {
    const start = Math.floor(p.t / def.bucketMs) * def.bucketMs;
    const b = buckets.get(start);
    const v = p.r * k;
    if (!b) buckets.set(start, { t: start, o: v, h: v, l: v, c: v, first: p.t });
    else {
      b.h = Math.max(b.h, v);
      b.l = Math.min(b.l, v);
      b.c = v;
    }
  }
  const all = [...buckets.values()].sort((a, b) => a.t - b.t);
  const out = all.filter((b, i) => b.t + def.bucketMs <= nowMs && !(i === 0 && b.first - b.t > 2 * def.cmcMs));
  return out.length ? out.map(({ t: t0, o, h, l, c }) => ({ t: t0, o, h, l, c })) : null;
}

/** HHLL + Fib dari candle USDT.D. Tiap bagian null kalau datanya belum cukup. */
function buildStructure(candles) {
  if (!candles || candles.length < HHLL_CFG.MIN_CANDLES) return { hhll: null, fib: null };
  const st = computeStructure(candles, { minPct: DUSDT_MIN_SWING_PCT });
  return {
    hhll: st.lastHigh && st.lastLow && st.trend ? st : null,
    fib: computeFib(candles),
  };
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
  const sdef = SERIES[tf];
  const [g, tether, cmc, klines, tetherLong, cmcLong] = await Promise.all([
    fetchGlobal(),
    fetchTether(def.cgDays),
    fetchCmc(tf),
    fetchBtc(),
    fetchTether(sdef.cgDays),
    fetchCmcSeries(tf),
  ]);
  const result = buildResult(tf, g, tether, cmc, klines);
  if (!result) return null;
  const candles = buildCandles(tetherLong, cmcLong, tf, result.level);
  return { ...result, ...buildStructure(candles), candles, candleCount: candles ? candles.length : 0 };
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

/** Versi lengkap lama (analisis pasar + konfirmasi BTC.D / BTC). Tidak dipakai command; dipertahankan untuk referensi/uji. */
function formatDusdtFull(lang, r) {
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

// ---------- tampilan bergaya koin: nilai + HHLL + Fib ----------
const fmtDom = (v) => `${v.toFixed(3)}%`; // level dominasi (3 desimal supaya level Fib yang berdekatan tetap terbedakan)
const fmtPp = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} pp`; // jarak dari level sekarang, dalam poin persentase

function buildHhllSection(lang, r) {
  const st = r.hhll;
  if (!st) return t(lang, "dusdt.hhll.none", { tf: r.tfLabel });
  const swings = st.swings
    .slice(-HHLL_SHOW)
    .map((s) => {
      const label = s.label || (s.type === "H" ? "high" : "low");
      const icon = { HH: "🔺", HL: "🟢", LH: "🔻", LL: "🔴", EH: "➖", EL: "➖" }[s.label] || "▫️";
      return t(lang, "hhll.swing.line", { icon, label, price: fmtDom(s.price), when: fmtWhen(lang, s.t, r.tfLabel) });
    })
    .join("\n");
  const trendKey = st.trend === "up" ? "hhll.trend.up" : st.trend === "down" ? "hhll.trend.down" : "hhll.trend.range";
  return [
    t(lang, "dusdt.hhll.title", { tf: r.tfLabel }),
    t(lang, trendKey, { h: st.lastHighLabel || "-", l: st.lastLowLabel || "-" }),
    "",
    t(lang, "hhll.swings.title"),
    swings,
    "",
    t(lang, "hhll.levels.high", { price: fmtDom(st.lastHigh.price), pct: fmtPp(st.lastHigh.price - r.level) }),
    t(lang, "hhll.levels.low", { price: fmtDom(st.lastLow.price), pct: fmtPp(st.lastLow.price - r.level) }),
    t(lang, `dusdt.hhll.note.${st.trend}`, { high: fmtDom(st.lastHigh.price), low: fmtDom(st.lastLow.price) }),
  ].join("\n");
}

const ratioLabel = (x) => (Number.isInteger(x) && x > 1 ? x.toFixed(1) : String(x));

function buildFibSection(lang, r) {
  const fib = r.fib;
  if (!fib) return t(lang, "dusdt.fib.none", { tf: r.tfLabel });
  const up = fib.trend === "up";
  const swingPct = (Math.abs(fib.end - fib.start) / fib.start) * 100;
  const trend = t(lang, up ? "kripto.fib.trendUp" : "kripto.fib.trendDown", {
    from: fmtDom(fib.start),
    to: fmtDom(fib.end),
    pct: swingPct.toFixed(1),
  });

  const items = [
    ...fib.retracement.map((l) => ({ ...l, ext: false })),
    ...fib.extension.slice(0, FIB_EXT_SHOW).map((l) => ({ ...l, ext: true })),
  ].sort((a, b) => b.price - a.price); // tinggi -> rendah, sama dengan !fib
  const rows = items.map((it) => {
    const icon = it.ext ? "🎯" : it.ratio === 0.5 || it.ratio === 0.618 ? "⭐" : it.ratio === 0 || it.ratio === 1 ? "📍" : "▫️";
    let suffix = "";
    if (!it.ext && it.ratio === 0) suffix = ` · ${t(lang, up ? "kripto.fib.swingHigh" : "kripto.fib.swingLow")}`;
    if (!it.ext && it.ratio === 1) suffix = ` · ${t(lang, up ? "kripto.fib.swingLow" : "kripto.fib.swingHigh")}`;
    return { price: it.price, text: `${icon} ${ratioLabel(it.ratio)}  ${fmtDom(it.price)} (${fmtPp(it.price - r.level)})${suffix}` };
  });
  const nowRow = `▶️ ${t(lang, "kripto.fib.now")} ${fmtDom(r.level)}`;
  let at = rows.findIndex((x) => x.price < r.level);
  if (at === -1) at = rows.length;
  const lines = rows.map((x) => x.text);
  lines.splice(at, 0, nowRow);

  // posisi level sekarang terhadap swing
  const depth = retraceDepth(fib, r.level);
  let note;
  if (depth < 0) note = t(lang, "kripto.fib.beyond");
  else if (depth > 1) note = t(lang, "kripto.fib.broken");
  else {
    let k = 0;
    for (let i = 0; i < fib.retracement.length - 1; i++) if (depth >= fib.retracement[i].ratio) k = i;
    const a = fib.retracement[k];
    const b = fib.retracement[Math.min(k + 1, fib.retracement.length - 1)];
    note = t(lang, "kripto.fib.depth", {
      pct: (depth * 100).toFixed(1),
      a: `${ratioLabel(a.ratio)} (${fmtDom(a.price)})`,
      b: `${ratioLabel(b.ratio)} (${fmtDom(b.price)})`,
    });
  }
  return [t(lang, "dusdt.fib.title", { tf: r.tfLabel }), trend, "", ...lines, "", note].join("\n");
}

/** @returns {string} teks WhatsApp: USDT.D seperti satu koin, lalu HHLL dan Fib-nya. */
function formatDusdt(lang, r) {
  const head = [t(lang, "dusdt.coin.title", { tf: r.tfLabel }), t(lang, "dusdt.level", { v: r.level.toFixed(2) })];
  if (isNum(r.deltaPp)) head.push(t(lang, "dusdt.change", { tf: r.tfLabel, pp: fmtSigned(r.deltaPp), rel: fmtPctS(r.relPct) }));
  else head.push(t(lang, "dusdt.change.na", { tf: r.tfLabel }));
  const dirIcon = { up: "🔼", down: "🔽", side: "➡️" }[r.dir] || "❔";
  head.push(t(lang, "dusdt.dir", { icon: dirIcon, dir: r.dir ? t(lang, `dusdt.dir.${r.dir}`) : t(lang, "dusdt.dir.na") }));

  const lines = [...head, ""];
  if (r.candleCount === 0) {
    lines.push(t(lang, "dusdt.struct.na"));
  } else {
    lines.push(buildHhllSection(lang, r), "", buildFibSection(lang, r));
  }
  lines.push(
    "",
    r.updatedAt ? t(lang, "dusdt.update", { time: fmtTime(lang, r.updatedAt) }) : t(lang, "dusdt.update.fetched", { time: fmtTime(lang, r.fetchedAt) }),
  );
  if (r.stale) lines.push(t(lang, "dusdt.stale", { min: Math.round((r.fetchedAt - r.updatedAt) / MIN) }));
  lines.push(t(lang, "dusdt.source", { src: r.sources.join(", ") }), "", t(lang, "dusdt.note.short"));
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

/**
 * Dua gambar untuk !dusdt (masing-masing opsional; gagal render -> dilewati, teks tetap terkirim):
 *   1. grafik HHLL (sama dengan !hhll)  2. grafik lengkap (sama dengan !chart: EMA, S/R, Fib, MACD, RSI)
 * @returns {{hhll: Buffer|null, chart: Buffer|null}}
 */
function renderDusdtCharts(r) {
  const out = { hhll: null, chart: null };
  const candles = r.candles;
  if (!candles || candles.length < 10) return out;
  const title = `USDT.D  ${r.tfLabel}`;
  if (r.hhll) {
    try {
      out.hhll = renderHhllChart({
        candles,
        coin: "USDT.D",
        tf: r.tfLabel,
        st: r.hhll,
        title: `${title}  Higher High / Lower Low`,
        minPct: DUSDT_MIN_SWING_PCT,
      });
    } catch (err) {
      console.log("[dusdt] chart HHLL gagal:", err.message);
    }
  }
  try {
    const { resistance, support } = computeLevels(candles, r.level);
    out.chart = renderChart({ candles, coin: "USDT.D", tf: r.tfLabel, resistance, support, fib: r.fib, title });
  } catch (err) {
    console.log("[dusdt] chart gagal:", err.message);
  }
  return out;
}

async function runDusdt(sock, msg, { jid, lang }, { tf }) {
  const result = await getDusdt(tf);
  if (!result) {
    await sock.sendMessage(jid, { text: t(lang, "dusdt.unavailable") }, { quoted: msg });
    return;
  }
  const { hhll, chart } = renderDusdtCharts(result);
  let quoted = msg;
  // Gambar 1: HHLL (seperti !hhll), gambar 2: chart (seperti !chart). Teks lengkap menyusul sebagai pesan terpisah.
  if (hhll) {
    await sock.sendMessage(jid, { image: hhll, caption: t(lang, "dusdt.img.hhll", { tf: result.tfLabel }) }, { quoted });
    quoted = undefined;
  }
  if (chart) {
    await sock.sendMessage(jid, { image: chart, caption: t(lang, "dusdt.img.chart", { tf: result.tfLabel }) }, quoted ? { quoted } : undefined);
    quoted = undefined;
  }
  await sock.sendMessage(jid, { text: formatDusdt(lang, result) }, quoted ? { quoted } : undefined);
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
  formatDusdtFull,
  buildCandles,
  buildStructure,
  renderDusdtCharts,
  ratioWindow,
  btcMove,
  direction,
  TF,
};
