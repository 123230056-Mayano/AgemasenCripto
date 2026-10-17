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

module.exports = { INDICATOR_CONFIG, BIAS_CONFIG, SIGNAL_CONFIG };
