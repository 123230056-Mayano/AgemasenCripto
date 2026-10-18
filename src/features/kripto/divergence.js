"use strict";

/**
 * features/kripto/divergence.js
 * ------------------------------------------------------------------
 * Deteksi divergence harga vs RSI / histogram MACD (dipakai !scandivergent,
 * !scan div_bull|div_bear, dan nanti !alertdiv).
 *
 * FUNGSI MURNI: tanpa fetch, tanpa cache, tanpa kirim pesan. Input sama -> output sama
 * (waktu "sekarang" hanya dipakai untuk membuang candle berjalan dan bisa disuntik lewat opts.now).
 *
 * Empat jenis:
 *   reguler bullish     : harga lower low  , indikator higher low   (potensi pembalikan naik)
 *   reguler bearish     : harga higher high, indikator lower high   (potensi pembalikan turun)
 *   tersembunyi bullish : harga higher low , indikator lower low    (potensi lanjutan naik)
 *   tersembunyi bearish : harga lower high , indikator higher high  (potensi lanjutan turun)
 *
 * Aturan penting:
 *   - Hanya candle CLOSED. Candle di ujung deret yang belum tutup dibuang dulu (closed === false,
 *     atau ct >= now, ct = waktu tutup dalam ms).
 *   - Pivot butuh PIVOT_RIGHT candle konfirmasi di kanan, jadi sinyal selalu terlambat PIVOT_RIGHT
 *     candle dari puncak/lembah sebenarnya. Disengaja agar hasil tidak berubah-ubah.
 *   - Definisi pivot (PIVOT_CONFIRM, lihat findPivots): default "close" = nilai pivot tetap wick (l/h),
 *     tetapi sisi kanan hanya diperiksa lewat CLOSE: wick boleh menembus pivot, close tidak boleh.
 *     "wick" = perilaku lama (v1), sisi kanan juga diperiksa lewat wick.
 *   - Pivot indikator (IND_PIVOT, lihat indicatorExtreme): default "own" = lembah/puncak RSI (atau histogram
 *     MACD) SENDIRI di sekitar candle pivot harga (+/- IND_RADIUS candle), bukan nilai di candle pivot harga.
 *     "price" = perilaku lama (v1, v2): nilai indikator di candle pivot HARGA yang sama.
 *   - Kebaruan: pivot kedua harus terkonfirmasi <= LOOKBACK candle terakhir (inklusif, jadi
 *     barsAgo 0..LOOKBACK; sesuai contoh PDF yang menampilkan "3 candle").
 *   - Pasangan pivot (revisi bagian 3): pivot TERBARU dibandingkan dengan SEMUA pivot sejenis sebelumnya yang
 *     jaraknya MIN_BARS..MAX_BARS. Per (indikator, sisi low/high) diambil SATU pasangan yang paling jelas =
 *     selisih nilai indikator terbesar (seri: pivot lawan yang paling dekat). Satu pivot kecil baru tidak lagi
 *     menggeser pasangan dan membuat divergence yang tadinya valid hilang.
 *   - Sinyal DINI (revisi bagian 4, opsional, default mati): pivot kedua yang BELUM penuh terkonfirmasi (baru
 *     EARLY_MIN_RIGHT..PIVOT_RIGHT-1 candle di kanan) tetapi sisi kirinya sah, belum ada close yang menembus pivot,
 *     dan indikator sudah membentuk higher low (bull) / lower high (bear). Hasilnya diberi status "early" dan
 *     muncul 1..PIVOT_RIGHT-1 candle lebih awal dari versi terkonfirmasi. Hanya jenis di EARLY_KINDS (default
 *     reguler). detectDivergence() TIDAK PERNAH mengembalikan sinyal dini; pakai detectDivergenceAll() (mengembalikan
 *     { confirmed, early }). Sinyal dini bisa gugur (close menembus pivot sebelum terkonfirmasi): itu sebabnya pesannya
 *     wajib berlabel "dini, belum terkonfirmasi".
 *   - Tiap hasil punya `bias`: "reversal" (regular) | "continuation" (hidden), supaya "Bearish hidden" tidak
 *     terbaca sebagai pembalikan turun. `conflict` = true pada SEMUA hasil bila bull dan bear muncul bersamaan.
 *
 * Changelog parameter:
 *   v1 (2026-10-16) nilai awal usulan PDF. Setel setelah dibandingkan dengan chart.
 *   v2 (2026-10-18) Revisi bagian 1: PIVOT_WIN dipecah jadi PIVOT_LEFT 3 / PIVOT_RIGHT 4; tambah PIVOT_CONFIRM
 *       "close" (default) | "wick" (v1). confirmIdx = pivot kedua + PIVOT_RIGHT, jadi sinyal terkonfirmasi 1 candle
 *       lebih lambat dari v1. Untuk meniru v1 persis: { PIVOT_CONFIRM: "wick", PIVOT_RIGHT: 3 }.
 *   v3 (2026-10-18) Revisi bagian 2: nilai RSI / hist MACD diambil dari lembah/puncak indikator SENDIRI
 *       (indicatorExtreme, jendela pivot harga +/- IND_RADIUS 3), bukan dari candle pivot harga. pivot.ind = nilai
 *       ekstrem itu, pivot.indIdx = indeks candle-nya (dipakai divChart untuk menaruh panah). Opsi IND_PIVOT: "own"
 *       (default) | "price" (v1/v2, indIdx = idx). Pasangan yang jendelanya saling menimpa sampai indIdx2 <= indIdx1
 *       dibuang. Untuk meniru v2 persis: { IND_PIVOT: "price" }.
 *   v4 (2026-10-18) Revisi bagian 3: pivot terbaru dibandingkan dengan beberapa pivot sebelumnya dalam MAX_BARS
 *       (bukan hanya satu pivot sebelumnya), diambil pasangan dengan selisih indikator terbesar. Tambah field
 *       `bias` (reversal | continuation) dan `conflict` (bull + bear sekaligus). Untuk meniru v3 (hanya dua pivot
 *       terakhir): { PAIR_MODE: "last" }.
 *   v5 (2026-10-18) Revisi bagian 4: sinyal dini (status "early", lihat di atas). Tambah EARLY_MIN_RIGHT 1 dan
 *       EARLY_KINDS ["regular"], findEarlyPivots(), detectDivergenceAll(). Semua hasil punya `status`
 *       ("confirmed" | "early"). Hasil detectDivergence() identik dengan v4 (hanya ditambah field status).
 */

const { rsi, macd, atr } = require("./indicators");
const { INDICATOR_CONFIG } = require("../../config/indicatorConfig");

const DIV_VERSION = 5;
const DIV = {
  PIVOT_LEFT: 3, // candle di kiri pivot yang harus lebih tinggi/rendah (berdasarkan wick, strict)
  PIVOT_RIGHT: 4, // candle konfirmasi di kanan pivot
  PIVOT_CONFIRM: "close", // "close": sisi kanan diperiksa lewat close (wick boleh menembus) | "wick": perilaku v1
  IND_PIVOT: "own", // "own": lembah/puncak indikator sendiri dekat pivot harga | "price": nilai di candle pivot harga (v1/v2)
  IND_RADIUS: 3, // jendela pencarian ekstrem indikator = candle pivot harga +/- N
  PAIR_MODE: "best", // "best": pivot terbaru vs semua pivot sebelumnya dalam MAX_BARS, ambil selisih indikator terbesar | "last": hanya dua pivot terakhir (v1-v3)
  EARLY: true, // detectDivergenceAll menghitung sinyal dini (detectDivergence selalu memaksa false)
  EARLY_MIN_RIGHT: 1, // sinyal dini: minimal N candle sudah terbentuk di kanan pivot (N..PIVOT_RIGHT-1 candle lebih awal)
  EARLY_KINDS: ["regular"], // jenis yang boleh dini (reguler = pembalikan; tersembunyi tidak dibuat dini)
  MIN_BARS: 5, // jarak minimum antar dua pivot
  MAX_BARS: 60, // jarak maksimum antar dua pivot
  LOOKBACK: 3, // pivot terbaru harus terkonfirmasi dalam N candle terakhir
  MIN_IND_DIFF_RSI: 2, // selisih RSI minimum antar pivot (poin)
  MIN_IND_DIFF_MACD_PCT: 0.05, // selisih hist MACD minimum = 5% dari rentang hist terbaru
  MACD_RANGE_BARS: 100, // "terbaru" untuk rentang histogram = 100 candle closed terakhir
  MIN_PRICE_ATR: 0.1, // selisih harga minimum, dalam kelipatan ATR(14) di pivot kedua
  RSI_PERIOD: INDICATOR_CONFIG.RSI_PERIOD,
  ATR_PERIOD: INDICATOR_CONFIG.ATR_PERIOD,
};
const DEFAULT_INDICATORS = ["rsi", "macd"];
// regular = potensi pembalikan, hidden = potensi lanjutan tren (arah `dir` tetap arah pergerakan yang dimaksud).
const BIAS = { regular: "reversal", hidden: "continuation" };
const MIN_CANDLES = 40; // MACD butuh warmup 26 + 9 - 1 = 34 candle; di bawah ini dilewati (bukan error)

/** Buang candle berjalan di ujung deret. Candle tanpa ct/closed dianggap sudah closed. */
function dropUnclosed(candles, now = Date.now()) {
  let end = candles.length;
  while (end > 0) {
    const c = candles[end - 1];
    if (c.closed === false || (c.ct != null && c.ct >= now)) end--;
    else break;
  }
  return end === candles.length ? candles : candles.slice(0, end);
}

/**
 * Index pivot. Nilai pivot selalu wick (low untuk "low", high untuk "high").
 *
 * Sisi KIRI (PIVOT_LEFT candle): wick pivot harus strict lebih rendah/tinggi dari wick tiap candle di kiri.
 *
 * Sisi KANAN (PIVOT_RIGHT candle), tergantung PIVOT_CONFIRM:
 *   - "close": tidak ada CLOSE di kanan yang lebih rendah dari pivot low (lebih tinggi dari pivot high).
 *     Wick di kanan boleh menembus pivot. Close tepat di level pivot masih dianggap sah (>= / <=).
 *   - "wick" (v1): tidak ada WICK di kanan yang lebih rendah/tinggi dari pivot (boleh sama).
 *
 * Dataran dengan harga persis sama (koin berharga kecil, tick size kasar): yang dihitung pivot hanya yang
 * paling awal, karena sisi kiri strict.
 *
 * Mode close: kandidat yang jatuh di dalam jendela kanan (PIVOT_RIGHT candle) pivot yang sudah diterima
 * diabaikan. Itu hanya wick yang menembus pivot tanpa close yang menembus, yang justru dibolehkan, jadi
 * pivot lama (mis. low 1130) tetap pivotnya dan tidak digantikan wick yang lebih dalam. Tanpa aturan ini
 * satu lembah bisa menghasilkan dua pivot berdekatan dan pasangan terakhir gugur di filter MIN_BARS.
 *
 * Hanya yang sudah terkonfirmasi (i + PIVOT_RIGHT <= candle terakhir).
 *
 * @param {Array} candles
 * @param {"low"|"high"} type
 * @param {{PIVOT_LEFT?:number, PIVOT_RIGHT?:number, PIVOT_CONFIRM?:"close"|"wick"}} [cfg] default DIV
 */
function findPivots(candles, type, cfg = DIV) {
  const left = cfg.PIVOT_LEFT ?? DIV.PIVOT_LEFT;
  const right = cfg.PIVOT_RIGHT ?? DIV.PIVOT_RIGHT;
  const mode = cfg.PIVOT_CONFIRM ?? DIV.PIVOT_CONFIRM;
  if (mode !== "close" && mode !== "wick") throw new Error(`PIVOT_CONFIRM tidak dikenal: ${mode}`);
  const isLow = type === "low";
  const wickKey = isLow ? "l" : "h";
  const rightKey = mode === "close" ? "c" : wickKey;
  const out = [];
  for (let i = left; i <= candles.length - 1 - right; i++) {
    const v = candles[i][wickKey];
    let ok = true;
    for (let j = 1; j <= left && ok; j++) {
      const l = candles[i - j][wickKey];
      if (isLow ? !(v < l) : !(v > l)) ok = false;
    }
    for (let j = 1; j <= right && ok; j++) {
      const r = candles[i + j][rightKey];
      if (isLow ? !(r >= v) : !(r <= v)) ok = false;
    }
    if (!ok) continue;
    if (mode === "close" && out.length && i - out[out.length - 1] <= right) continue;
    out.push(i);
  }
  return out;
}

/**
 * Kandidat pivot DINI: pivot yang sisi kirinya sah tetapi sisi kanannya belum penuh (baru r = EARLY_MIN_RIGHT ..
 * PIVOT_RIGHT-1 candle terbentuk di kanan). Aturan sisi kanan sama dengan findPivots (close / wick sesuai
 * PIVOT_CONFIRM) dan hanya diperiksa pada candle yang sudah ada, jadi satu close yang menembus pivot langsung
 * menggugurkan kandidat. Mode close: kandidat dalam jendela kanan pivot terkonfirmasi terakhir (atau kandidat dini
 * sebelumnya) diabaikan, aturan yang sama dengan findPivots.
 *
 * @param {Array} candles deret closed
 * @param {"low"|"high"} type
 * @param {object} [cfg] default DIV
 * @param {number[]} [confirmed] hasil findPivots(candles, type, cfg) kalau sudah dihitung (hindari hitung ulang)
 * @returns {Array<{idx:number, rightSeen:number}>} urut lama -> baru; rightSeen = candle di kanan pivot yang sudah ada
 */
function findEarlyPivots(candles, type, cfg = DIV, confirmed = null) {
  const left = cfg.PIVOT_LEFT ?? DIV.PIVOT_LEFT;
  const right = cfg.PIVOT_RIGHT ?? DIV.PIVOT_RIGHT;
  const mode = cfg.PIVOT_CONFIRM ?? DIV.PIVOT_CONFIRM;
  const minRight = Math.max(1, cfg.EARLY_MIN_RIGHT ?? DIV.EARLY_MIN_RIGHT);
  if (mode !== "close" && mode !== "wick") throw new Error(`PIVOT_CONFIRM tidak dikenal: ${mode}`);
  const isLow = type === "low";
  const wickKey = isLow ? "l" : "h";
  const rightKey = mode === "close" ? "c" : wickKey;
  const last = candles.length - 1;
  const conf = confirmed || findPivots(candles, type, cfg);
  let prevAccepted = conf.length ? conf[conf.length - 1] : -Infinity;
  const out = [];
  for (let i = Math.max(left, last - (right - 1)); i <= last - minRight; i++) {
    const v = candles[i][wickKey];
    let ok = true;
    for (let j = 1; j <= left && ok; j++) {
      const l = candles[i - j][wickKey];
      if (isLow ? !(v < l) : !(v > l)) ok = false;
    }
    for (let j = 1; j <= last - i && ok; j++) {
      const r = candles[i + j][rightKey];
      if (isLow ? !(r >= v) : !(r <= v)) ok = false;
    }
    if (!ok) continue;
    if (mode === "close" && i - prevAccepted <= right) continue;
    out.push({ idx: i, rightSeen: last - i });
    prevAccepted = i;
  }
  return out;
}

/**
 * Lembah (type "low") atau puncak (type "high") indikator SENDIRI di sekitar candle pivot harga.
 * Jendela = [priceIdx - radius, priceIdx + radius], dipotong ke batas deret. Nilai null (warmup) dilewati.
 * Seri imbang: yang paling dekat dengan priceIdx menang; masih imbang, yang lebih awal.
 *
 * Catatan: radius <= PIVOT_RIGHT menjamin jendela kanan tidak melewati candle closed terakhir
 * untuk pivot yang lolos findPivots (i + PIVOT_RIGHT <= last).
 *
 * @param {Array<number|null>} series  RSI atau hist MACD, sejajar dengan candles
 * @param {number} priceIdx            indeks candle pivot harga
 * @param {"low"|"high"} type
 * @param {number} [radius=3]
 * @returns {{idx:number, value:number}|null} null bila jendela tidak punya nilai
 */
function indicatorExtreme(series, priceIdx, type, radius = 3) {
  if (!Array.isArray(series) || !Number.isInteger(priceIdx)) return null;
  const isLow = type === "low";
  const from = Math.max(0, priceIdx - radius);
  const to = Math.min(series.length - 1, priceIdx + radius);
  let best = null;
  for (let i = from; i <= to; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (best == null) {
      best = { idx: i, value: v };
      continue;
    }
    const better = isLow ? v < best.value : v > best.value;
    const tie = v === best.value && Math.abs(i - priceIdx) < Math.abs(best.idx - priceIdx);
    if (better || tie) best = { idx: i, value: v };
  }
  return best;
}

function histRange(hist, n, bars) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, n - bars); i < n; i++) {
    if (hist[i] == null) continue;
    if (hist[i] < lo) lo = hist[i];
    if (hist[i] > hi) hi = hist[i];
  }
  return hi > lo ? hi - lo : 0;
}

/**
 * Tandai konflik: kalau dalam satu daftar (satu koin + satu TF) ada divergence bull DAN bear sekaligus,
 * semua itemnya diberi conflict = true (tampilan wajib menyebut kedua arah dengan label tegas, jangan hanya
 * salah satu). Mengubah item di tempat dan mengembalikan daftar yang sama.
 * @param {Array<{dir:'bull'|'bear', conflict?:boolean}>} divs
 */
function markConflict(divs) {
  const both = divs.some((d) => d.dir === "bull") && divs.some((d) => d.dir === "bear");
  for (const d of divs) d.conflict = both;
  return divs;
}

/**
 * Pasangan paling jelas untuk satu (indikator, sisi) dengan pivot kedua i2. Dipakai untuk sinyal terkonfirmasi
 * maupun dini (beda hanya di i2, daftar `prior`, dan jenis yang diizinkan).
 * @returns {{diff:number, kind:string, i1:number, price1:number, v1:number, j1:number, v2:number, j2:number}|null}
 */
function bestPair({ cs, series, minDiff, ind, type, i2, prior, a, P, kinds }) {
  const key = type === "low" ? "l" : "h";
  const price2 = cs[i2][key];
  let best = null;
  for (const i1 of prior) {
    const gap = i2 - i1;
    if (gap < P.MIN_BARS || gap > P.MAX_BARS) continue;
    const price1 = cs[i1][key];
    if (Math.abs(price2 - price1) < P.MIN_PRICE_ATR * a) continue; // langkah 6: filter harga

    // langkah 5: nilai pivot indikator
    let v1;
    let v2;
    let j1 = i1;
    let j2 = i2;
    if (P.IND_PIVOT === "price") {
      v1 = series[ind][i1];
      v2 = series[ind][i2];
    } else {
      const e1 = indicatorExtreme(series[ind], i1, type, P.IND_RADIUS);
      const e2 = indicatorExtreme(series[ind], i2, type, P.IND_RADIUS);
      if (!e1 || !e2) continue;
      ({ idx: j1, value: v1 } = e1);
      ({ idx: j2, value: v2 } = e2);
      if (j2 <= j1) continue; // jendela saling menimpa -> urutan lembah indikator terbalik/identik
    }
    if (v1 == null || v2 == null) continue;
    if (Math.abs(v2 - v1) < minDiff[ind] || v2 === v1) continue; // langkah 6: filter indikator

    const priceUp = price2 > price1;
    const indUp = v2 > v1;
    let kind = null;
    if (type === "low") {
      if (!priceUp && indUp) kind = "regular"; // lower low + higher low
      else if (priceUp && !indUp) kind = "hidden"; // higher low + lower low
    } else {
      if (priceUp && !indUp) kind = "regular"; // higher high + lower high
      else if (!priceUp && indUp) kind = "hidden"; // lower high + higher high
    }
    if (!kind || (kinds && !kinds.includes(kind))) continue; // langkah 7

    // pasangan paling jelas = selisih indikator terbesar; seri -> pivot lawan terdekat (urutan iterasi, > strict)
    const diff = Math.abs(v2 - v1);
    if (best && diff <= best.diff) continue;
    best = { diff, kind, i1, price1, v1, j1, v2, j2 };
  }
  return best;
}

/**
 * Deteksi lengkap: sinyal terkonfirmasi DAN (hanya kalau diminta) sinyal dini, dari satu kali hitung indikator.
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,ct?:number,closed?:boolean}>} candles urut lama -> baru
 * @param {{indicators?:string[], now?:number}&Partial<typeof DIV>} [opts]
 * @returns {{confirmed:Array, early:Array}} early selalu [] kalau data kurang
 */
function detectDivergenceAll(candles, opts = {}) {
  const { indicators = DEFAULT_INDICATORS, now = Date.now(), ...over } = opts;
  const P = { ...DIV, ...over };
  const empty = { confirmed: [], early: [] };
  if (!Array.isArray(candles)) return empty;

  const cs = dropUnclosed(candles, now); // langkah 1
  const n = cs.length;
  if (n < MIN_CANDLES) return empty;

  // langkah 2: indikator atas deret closed saja
  const closes = cs.map((c) => c.c);
  const series = {};
  const minDiff = {};
  if (indicators.includes("rsi")) {
    series.rsi = rsi(closes, P.RSI_PERIOD);
    minDiff.rsi = P.MIN_IND_DIFF_RSI;
  }
  if (indicators.includes("macd")) {
    const hist = macd(closes).hist;
    series.macd = hist;
    minDiff.macd = P.MIN_IND_DIFF_MACD_PCT * histRange(hist, n, P.MACD_RANGE_BARS);
  }
  const atrS = atr(cs, P.ATR_PERIOD);
  const last = n - 1;
  const confirmed = [];
  const early = [];

  // langkah 3: pivot terkonfirmasi (i + PIVOT_RIGHT <= last dijamin findPivots)
  for (const type of ["low", "high"]) {
    const piv = findPivots(cs, type, P);
    const key = type === "low" ? "l" : "h";

    // ----- terkonfirmasi -----
    if (piv.length >= 2) {
      const i2 = piv[piv.length - 1]; // pivot terbaru
      const confirmIdx = i2 + P.PIVOT_RIGHT;
      const barsAgo = last - confirmIdx; // langkah 8: kebaruan
      const a = atrS[i2];
      if (barsAgo <= P.LOOKBACK && a != null && a > 0) {
        // langkah 4: kandidat pivot pembanding. "best": semua pivot sebelumnya dalam MAX_BARS (terdekat dulu);
        // "last": hanya satu pivot sebelumnya (perilaku v1-v3).
        let prior = piv.slice(0, -1).reverse();
        if (P.PAIR_MODE === "last") prior = prior.slice(0, 1);
        for (const ind of Object.keys(series)) {
          const best = bestPair({ cs, series, minDiff, ind, type, i2, prior, a, P });
          if (!best) continue;
          confirmed.push({
            indicator: ind,
            kind: best.kind,
            dir: type === "low" ? "bull" : "bear",
            bias: BIAS[best.kind],
            conflict: false, // diisi markConflict di bawah
            status: "confirmed",
            pivot1: { idx: best.i1, time: cs[best.i1].t, price: best.price1, ind: best.v1, indIdx: best.j1 },
            pivot2: { idx: i2, time: cs[i2].t, price: cs[i2][key], ind: best.v2, indIdx: best.j2 },
            confirmedAtTime: cs[confirmIdx].t,
            barsAgo,
          });
        }
      }
    }

    // ----- dini: pivot kedua belum penuh terkonfirmasi, dibandingkan dengan pivot TERKONFIRMASI sebelumnya -----
    if (!P.EARLY) continue;
    const cands = findEarlyPivots(cs, type, P, piv);
    for (const { idx: i2, rightSeen } of cands) {
      const a = atrS[i2];
      if (a == null || !(a > 0)) continue;
      let prior = [...piv].reverse();
      if (P.PAIR_MODE === "last") prior = prior.slice(0, 1);
      for (const ind of Object.keys(series)) {
        const best = bestPair({ cs, series, minDiff, ind, type, i2, prior, a, P, kinds: P.EARLY_KINDS });
        if (!best) continue;
        early.push({
          indicator: ind,
          kind: best.kind,
          dir: type === "low" ? "bull" : "bear",
          bias: BIAS[best.kind],
          conflict: false,
          status: "early",
          pivot1: { idx: best.i1, time: cs[best.i1].t, price: best.price1, ind: best.v1, indIdx: best.j1 },
          pivot2: { idx: i2, time: cs[i2].t, price: cs[i2][key], ind: best.v2, indIdx: best.j2 },
          confirmedAtTime: null, // belum terkonfirmasi
          rightSeen, // candle yang sudah terbentuk di kanan pivot
          barsEarly: P.PIVOT_RIGHT - rightSeen, // berapa candle lebih awal dari versi terkonfirmasi
          barsAgo: -(P.PIVOT_RIGHT - rightSeen), // negatif: konfirmasi masih di depan
        });
      }
    }
  }
  markConflict(confirmed);
  // Konflik sinyal dini: ada sinyal arah berlawanan (terkonfirmasi atau dini) di koin + TF yang sama.
  for (const e of early) e.conflict = [...confirmed, ...early].some((d) => d.dir !== e.dir);

  const cmp = (x, y) => x.barsAgo - y.barsAgo || (x.indicator < y.indicator ? -1 : x.indicator > y.indicator ? 1 : 0);
  return { confirmed: confirmed.sort(cmp), early: early.sort(cmp) };
}

/**
 * Sinyal terkonfirmasi saja (perilaku v4; satu-satunya yang dipakai scan dan alarm biasa).
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,ct?:number,closed?:boolean}>} candles urut lama -> baru
 * @param {{indicators?:string[], now?:number}&Partial<typeof DIV>} [opts]
 * @returns {Array<{indicator:'rsi'|'macd', kind:'regular'|'hidden', dir:'bull'|'bear', status:'confirmed',
 *   pivot1:{idx:number,time:number,price:number,ind:number,indIdx:number}, pivot2:{idx:number,time:number,price:number,ind:number,indIdx:number},
 *   bias:'reversal'|'continuation', conflict:boolean, confirmedAtTime:number, barsAgo:number}>} terbaru dulu
 */
function detectDivergence(candles, opts = {}) {
  return detectDivergenceAll(candles, { ...opts, EARLY: false }).confirmed;
}

module.exports = { DIV, DIV_VERSION, DEFAULT_INDICATORS, MIN_CANDLES, BIAS, detectDivergence, detectDivergenceAll, dropUnclosed, findPivots, findEarlyPivots, indicatorExtreme, markConflict };