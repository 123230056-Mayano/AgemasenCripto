"use strict";

/**
 * config/indicatorConfig.js
 * ------------------------------------------------------------------
 * Satu-satunya tempat parameter indikator dasar (item 01 Fondasi Indikator).
 * Dipakai features/kripto/indicators.js (dan divergence.js untuk RSI/ATR).
 * Nilai default = nilai standar yang sama dengan web analyst (lib/indicators.js),
 * jadi angka bot dan web tetap identik. Ubah di sini, jangan di tiap fitur.
 */

const INDICATOR_CONFIG = Object.freeze({
  EMA_PERIODS: Object.freeze([20, 50, 200]),
  RSI_PERIOD: 14,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  // Jumlah candle closed minimum agar indikator terisi penuh.
  EMA_FULL_MIN: 200, // EMA 200 + klasifikasi tren penuh
  EMA_LIMITED_MIN: 50, // di bawah EMA_FULL_MIN: tren cadangan EMA 20/50
  // Item 02 EMA Crossover. Cross dianggap "baru" bila terjadi <= CROSS_LOOKBACK candle closed lalu.
  CROSS_LOOKBACK: 10,
  // Pasangan [cepat, lambat] yang ditampilkan di !mtf (urutan = urutan kolom).
  CROSS_PAIRS: Object.freeze([Object.freeze([20, 50]), Object.freeze([50, 200])]),
});

/**
 * Item 07 !bias: seluruh aturan skor di SATU tempat supaya bisa dijelaskan dan disetel.
 * Dipakai features/kripto/bias.js (dan nanti 08 !sinyal / 09 probabilitas lewat computeBias).
 * Ubah nilai di sini, lalu naikkan VERSION (tampil di header pesan !bias).
 *
 * Skor tiap komponen -1..+1. Skor total = rata-rata berbobot komponen yang ADA datanya
 * (komponen tanpa data dilewati, bobot dinormalisasi ulang, bukan dihitung 0).
 */
const BIAS_CONFIG = Object.freeze({
  VERSION: 2,
  // Bobot komponen per TF (total 1.00).
  WEIGHTS: Object.freeze({
    trend: 0.3,
    cross: 0.15,
    rsi: 0.1,
    macd: 0.15,
    mood: 0.1,
    btc: 0.1,
    oiFunding: 0.1,
  }),
  // Ambang bias (eksklusif): skor > BULL = bullish, skor < BEAR = bearish, selain itu netral.
  BULL: 0.25,
  BEAR: -0.25,
  // Crossover: relevan <= CROSS_LOOKBACK candle; besar skor menurun linear terhadap umur.
  CROSS_LOOKBACK: 20,
  CROSS_PAIR_WEIGHTS: Object.freeze({ "50/200": 0.65, "20/50": 0.35 }), // 20/50 lebih berisik
  // RSI: "momentum" (RSI > 50 = bullish) atau "contrarian" (jenuh beli = bearish).
  RSI_MODE: "momentum",
  RSI_EXTREME_HI: 75,
  RSI_EXTREME_LO: 25,
  RSI_EXTREME_DAMP: 0.4, // skor RSI di zona ekstrem dikurangi 40% (mode momentum)
  // Keyakinan = porsi bobot yang searah hasil. |skor| <= AGREE_NEUTRAL dianggap searah hasil netral.
  AGREE_NEUTRAL: 0.25,
  CONF_HIGH: 0.75,
  CONF_MID: 0.5,
  // Tampilan alasan.
  REASON_MIN: 0.02, // komponen dengan |bobot*skor| di bawah ini tidak ditampilkan
  REASON_MAX: 5,
  // Bias keseluruhan lintas TF (v2): TF lebih tinggi lebih berbobot. Total 1.00.
  // TF yang gagal diambil dilewati dan bobotnya dinormalisasi ulang.
  TF_WEIGHTS: Object.freeze({ "15M": 0.1, "1H": 0.2, "4H": 0.3, "1D": 0.4 }),
});

/**
 * Item 08 !sinyal: aturan skenario entry / SL / TP / RR di SATU tempat.
 * Arah skenario mengikuti bias per TF dari computeBias (item 07): bullish -> LONG, bearish -> SHORT,
 * netral -> SIDEWAYS (range). Semua angka dihitung dari candle closed + ATR + level S/R, tanpa AI.
 * Naikkan VERSION kalau aturan diubah (tampil di header pesan !sinyal).
 *
 * Dua pilihan di bawah menunggu jawaban client (PDF 08, "Pertanyaan ke client"):
 *   ENTRY_STYLE: "trend"    = ikut tren, entry di harga sekarang                     (default sementara)
 *                "retest"   = tunggu pullback ke support/EMA20 (long) / resistance/EMA20 (short)
 *                "breakout" = tunggu tembus resistance (long) / support (short)
 *   SL_MODE:     "atr" = SL = entry -/+ ATR_SL_MULT x ATR                               (default sementara)
 *                "sr"  = SL tepat di luar support (long) / resistance (short) terdekat; bila level tidak
 *                        ada / jaraknya di luar SL_MIN_ATR..SL_MAX_ATR, otomatis pakai ATR dan ditandai.
 */
const SIGNAL_CONFIG = Object.freeze({
  VERSION: 1,
  ENTRY_STYLE: "trend",
  SL_MODE: "atr",
  ATR_SL_MULT: 1.5, // jarak SL mode ATR (kelipatan ATR 14)
  SR_SL_BUFFER_ATR: 0.25, // jarak ekstra di luar level S/R untuk SL mode "sr"
  SL_MIN_ATR: 0.5, // SL mode "sr" lebih dekat dari ini = terlalu mepet noise -> pakai ATR
  SL_MAX_ATR: 4, // SL mode "sr" lebih jauh dari ini = risiko terlalu besar -> pakai ATR
  // Take profit sebagai kelipatan risiko (R). RR yang ditampilkan SELALU dihitung ulang dari entry/SL/TP.
  TP_RR: Object.freeze([1.5, 2.5]),
  // Gaya "breakout": entry = level + buffer; gaya "retest"/"breakout": level lebih jauh dari LEVEL_MAX_ATR
  // dianggap tidak relevan -> kembali ke entry harga sekarang (ditandai).
  BREAKOUT_BUFFER_ATR: 0.1,
  LEVEL_MAX_ATR: 3,
  // Skenario sideways: range = high tertinggi / low terendah dari RANGE_LOOKBACK candle closed terakhir.
  RANGE_LOOKBACK: 40,
  RANGE_MIN_ATR: 2, // lebar range di bawah ini (kelipatan ATR) ditandai "range sempit"
});

/**
 * Item 09 Probabilitas Bull/Bear/Sideways: aturan konversi skor bias -> tiga angka (jumlah 100%).
 * Input HANYA skor bias (-1..+1) dan keyakinan (0..1) dari computeBias / computeOverallBias (item 07),
 * jadi tidak ada angka dari AI dan tidak ada jalur hitung kedua. Ubah nilai di sini, lalu naikkan VERSION.
 *
 * Langkah (semua murni, lihat features/kripto/probability.js):
 *   1. Ketegasan   t = min(1, |skor| / FULL_SCORE)               (0 = campur aduk, 1 = sangat tegas)
 *   2. Sideways    sw = SW_RANGE x (1 - t) + SW_CONF x (1 - keyakinan), dibatasi SW_MIN..SW_MAX
 *   3. Sisa (1 - sw) dibagi ke bull/bear mengikuti arah skor:
 *        lean = clamp(skor x SPLIT_GAIN, -1, 1) x SPLIT_MAX ; bull = (1 - sw) x (1 + lean) / 2 ; bear = sisanya
 *   4. Dibulatkan ke persen bulat dengan metode sisa terbesar, jadi jumlah SELALU tepat 100.
 *
 * Ringkas: skor mendekati 0 atau indikator saling bertentangan -> sideways naik; skor tegas dan searah
 * -> sisi bull/bear mendominasi. Hasil adalah ESTIMASI dari skor indikator, bukan jaminan.
 */
const PROB_CONFIG = Object.freeze({
  VERSION: 1,
  FULL_SCORE: 0.6, // |skor| >= ini dianggap sinyal sangat tegas
  SW_RANGE: 0.55, // porsi sideways saat skor 0
  SW_CONF: 0.15, // tambahan sideways bila keyakinan rendah (komponen saling bertentangan)
  SW_MIN: 0.1, // sideways tidak pernah di bawah ini
  SW_MAX: 0.6, // sideways tidak pernah di atas ini
  SPLIT_GAIN: 2, // skor x ini = kemiringan bull/bear (skor 0.5 sudah miring penuh)
  SPLIT_MAX: 0.85, // kemiringan maksimum, supaya sisi lawan tidak pernah tepat 0%
});

/**
 * Item 10 Real-time dan Alarm Lanjutan (!alertind): alarm bias berubah + crossover baru.
 * (Alarm divergence baru tetap lewat !alertdiv; konfigurasinya di divAlertCore.js.)
 *
 * "Real-time" BELUM diputuskan client (PDF 10, opsi 1/2/3). Default sementara = opsi 1 + opsi 2 yang bisa
 * dipilih per alarm:
 *   mode "closed" (default) : dievaluasi tiap candle closed (indikator dari candle closed saja, stabil)
 *   mode "live"             : opsi 1 refresh berkala (LIVE_INTERVAL_MS) memakai candle yang BELUM closed;
 *                             setiap pesan ditandai jelas, dan perubahan harus bertahan LIVE_CONFIRM kali
 *                             evaluasi berturut-turut supaya tidak bolak-balik.
 * Opsi 3 (WebSocket) sengaja belum dibuat: butuh desain khusus dan keputusan client.
 * Semua angka bisa diubah lewat env tanpa ubah kode; naikkan VERSION kalau aturan diubah.
 */
const _posInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
const _num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const ADV_ALERT_CONFIG = Object.freeze({
  VERSION: 1,
  CHECK_MS: Math.max(5_000, _posInt(process.env.ADV_CHECK_MS, 15_000)), // pemeriksaan ringan (jadwal candle closed + putaran live)
  // --- mode live (opsi 1: refresh berkala) ---
  LIVE_INTERVAL_MS: Math.max(60_000, _posInt(process.env.ADV_LIVE_INTERVAL_MS, 5 * 60_000)), // jeda hitung ulang per koin+TF
  LIVE_MAX_PAIRS: _posInt(process.env.ADV_LIVE_MAX_PAIRS, 60), // batas koin+TF yang dihitung per putaran (sisanya bergilir)
  LIVE_CONFIRM: _posInt(process.env.ADV_LIVE_CONFIRM, 2), // perubahan bias harus terlihat N evaluasi berturut-turut
  // --- aturan sinyal ---
  BIAS_HYST: _num(process.env.ADV_BIAS_HYST, 0.05), // histeresis: keluar dari bullish/bearish baru saat skor lewat ambang - HYST
  CROSS_MAX_BARS_AGO_CLOSED: 1, // mode closed: cross sampai 1 candle lalu masih dianggap baru (toleransi retry/restart)
  CROSS_MAX_BARS_AGO_LIVE: 0, // mode live: hanya cross di candle berjalan
  // --- anti-spam ---
  COOLDOWN_LIVE_MS: _posInt(process.env.ADV_COOLDOWN_LIVE_MS, 30 * 60_000), // jeda minimum antar alarm per penerima+koin+TF (live)
  COOLDOWN_CLOSED_MS: Number.isFinite(Number(process.env.ADV_COOLDOWN_CLOSED_MS)) && process.env.ADV_COOLDOWN_CLOSED_MS !== undefined && process.env.ADV_COOLDOWN_CLOSED_MS !== "" ? Number(process.env.ADV_COOLDOWN_CLOSED_MS) : 0,
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.ADV_MAX_MSG_PER_CHAT_HOUR, 20),
  LINES_PER_MSG: _posInt(process.env.ADV_LINES_PER_MSG, 20), // lebih dari ini dipecah ke pesan berikutnya (tidak ada yang dibuang)
  SEND_GAP_MS: _posInt(process.env.ADV_SEND_GAP_MS, 1_000),
  // --- langganan ---
  MAX_PER_USER: _posInt(process.env.ADV_ALERT_MAX_PER_USER, 10),
  MAX_PER_CHAT: _posInt(process.env.ADV_ALERT_MAX_PER_CHAT, 20),
  CONCURRENCY: _posInt(process.env.ADV_CONCURRENCY, 8),
  RETRY_MS: 60_000,
  MAX_ATTEMPTS: 3,
});

module.exports = { INDICATOR_CONFIG, BIAS_CONFIG, SIGNAL_CONFIG, PROB_CONFIG, ADV_ALERT_CONFIG };
