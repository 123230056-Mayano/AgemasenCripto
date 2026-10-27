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
  VERSION: 2, // v2: Sudden Move Guard (status entri + SL adaptif)
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

/**
 * Sudden Move Guard (features/kripto/suddenMove.js): gerbang entri (VALID / TUNGGU / HINDARI), penempatan SL saat
 * volatilitas tinggi, dan tingkat peringatan posisi (INFO / WASPADA / CUT).
 * SEMUA angka di bawah adalah NILAI AWAL USULAN (catatan desain 22 Okt 2026), BUKAN hasil backtest. Ubah lewat env,
 * uji dengan data historis per koin dan timeframe sebelum dipercaya. Naikkan VERSION kalau aturan diubah.
 */
const SUDDEN_CONFIG = Object.freeze({
  VERSION: 1,
  // --- pendeteksi ---
  WICK_MIN_PCT: _num(process.env.SUDDEN_WICK_MIN_PCT, 0.6), // wick sisi level >= 60% range candle
  BODY_MAX_PCT: _num(process.env.SUDDEN_BODY_MAX_PCT, 0.3), // body <= 30% range candle
  ZONE_ATR: _num(process.env.SUDDEN_ZONE_ATR, 0.25), // ekstrem wick dianggap "di zona" bila dalam jarak ini (x ATR) dari level
  SWEEP_LOOKBACK: _posInt(process.env.SUDDEN_SWEEP_LOOKBACK, 3), // sweep dicari di N candle closed terakhir
  EXPANSION_ATR: _num(process.env.SUDDEN_EXPANSION_ATR, 2.0), // range candle >= N x ATR(14) sebelum candle itu
  VOLUME_LOOKBACK: _posInt(process.env.SUDDEN_VOLUME_LOOKBACK, 20), // rata-rata volume N candle closed sebelumnya
  VOLUME_MULT: _num(process.env.SUDDEN_VOLUME_MULT, 2.0), // volume >= N x rata-rata = lonjakan
  RAPID_ATR: _num(process.env.SUDDEN_RAPID_ATR, 1.0), // gerak cepat: perubahan harga >= N x ATR TF itu ...
  RAPID_MINUTES: _posInt(process.env.SUDDEN_RAPID_MINUTES, 5), // ... dalam N menit
  // --- gerbang entri ---
  CHASE_ATR: _num(process.env.SUDDEN_CHASE_ATR, 1.0), // harga sudah lari > N x ATR melewati entry rencana = skenario lewat (HINDARI)
  MIN_RR: _num(process.env.SUDDEN_MIN_RR, 1.5), // RR ke TP1 minimal setelah SL disesuaikan
  // --- stop loss ---
  SL_BUFFER_ATR: _num(process.env.SUDDEN_SL_BUFFER_ATR, 0.25), // buffer di luar ekstrem wick/sweep (sama dengan SIGNAL_CONFIG.SR_SL_BUFFER_ATR)
  VOL_SL_MULT: _num(process.env.SUDDEN_VOL_SL_MULT, 1.25), // SL dilebarkan N x saat volatilitas tinggi
  BREAKEVEN_AT_R: _num(process.env.SUDDEN_BREAKEVEN_AT_R, 1), // geser SL ke break-even setelah profit sebesar N R
  // --- peringatan posisi ---
  WARN_ADVERSE_ATR: _num(process.env.SUDDEN_WARN_ADVERSE_ATR, 0.75), // WASPADA: harga melawan >= N x ATR dari entry
  CUT_RAPID_ATR: _num(process.env.SUDDEN_CUT_RAPID_ATR, 1.5), // CUT: gerak cepat melawan >= N x ATR (bersama lonjakan volume)
  TIME_STOP_CANDLES: _posInt(process.env.SUDDEN_TIME_STOP_CANDLES, 6), // evaluasi ulang bila N candle TF tanpa kemajuan
  TIME_STOP_PROGRESS_ATR: _num(process.env.SUDDEN_TIME_STOP_PROGRESS_ATR, 0.25), // "kemajuan" = bergerak >= N x ATR searah skenario (angka usulan tambahan)
});

/**
 * Posisi pengguna dan peringatan WASPADA / CUT (!posisi; positionEngine.js memakai suddenMove.assessPosition).
 * Posisi didaftarkan MANUAL oleh pengguna. Bot hanya mengirim pesan; tidak menutup posisi dan tidak menghapus
 * posisi otomatis saat CUT. Polling harga tiap CHECK_MS: spike yang selesai dalam hitungan detik bisa terlewat.
 */
const POSITION_CONFIG = Object.freeze({
  VERSION: 1,
  CHECK_MS: Math.max(10_000, _posInt(process.env.POS_CHECK_MS, 30_000)), // jeda ambil harga (satu permintaan batch untuk semua koin)
  INTERVAL_MS: Math.max(30_000, _posInt(process.env.POS_INTERVAL_MS, 60_000)), // jeda minimal ambil ulang candle per koin+TF
  MAX_PAIRS: _posInt(process.env.POS_MAX_PAIRS, 60), // batas koin+TF dihitung per putaran
  CONCURRENCY: _posInt(process.env.POS_CONCURRENCY, 8),
  SAMPLE_MAX: _posInt(process.env.POS_SAMPLE_MAX, 60), // maksimum sampel harga per koin di buffer (gerak cepat)
  MAX_PER_USER: _posInt(process.env.POS_MAX_PER_USER, 5),
  MAX_PER_CHAT: _posInt(process.env.POS_MAX_PER_CHAT, 10),
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.POS_MAX_MSG_PER_CHAT_HOUR, 20),
  SEND_GAP_MS: _posInt(process.env.POS_SEND_GAP_MS, 1_000),
  // Peringatan berbasis HARGA ke TP/SL: "mendekati" = sisa jarak ke level <= NEAR_FRAC x jarak entry->level
  // (0.2 = 20%; entry 81.000, TP 81.798 -> peringatan mulai ~81.640). "Tercapai" = harga / high-low candle menyentuh level.
  NEAR_FRAC: Math.min(0.9, Math.max(0.02, _num(process.env.POS_NEAR_FRAC, 0.2))),
});

/**
 * Alarm titik balik Support/Resistance (!alertsnr): reject (ditolak/memantul) dan tembus (breakout/breakdown),
 * dua tahap: DINI (candle berjalan, belum closed, bisa batal) dan KONFIRMASI (candle closed).
 *
 * Level = zona S/R dari !snr (snr.js: computeSnr), dihitung dari candle CLOSED sebelum candle yang dinilai,
 * dengan harga acuan = close candle sebelumnya. Jadi level tidak berpindah sisi di tengah candle.
 * Zona diberi pita +-BUFFER_PCT (persen) di sekitar harga level:
 *   tembus  : harga (dini) / close (konfirmasi) di luar pita, di seberang level
 *   reject  : high/low masuk pita, tetapi harga/close kembali keluar pita di sisi asalnya
 * Semua angka bisa diubah lewat env; naikkan VERSION kalau aturan diubah.
 */
const SNR_ALERT_CONFIG = Object.freeze({
  VERSION: 2, // v2: jenis wick + sweep (opt-in), satu pesan per level per candle
  CHECK_MS: Math.max(5_000, _posInt(process.env.SNR_CHECK_MS, 15_000)),
  INTERVAL_MS: Math.max(30_000, _posInt(process.env.SNR_INTERVAL_MS, 60_000)), // jeda ambil ulang per koin+TF
  MAX_PAIRS: _posInt(process.env.SNR_MAX_PAIRS, 60), // batas koin+TF per putaran (sisanya bergilir)
  FINAL_DELAY_MS: _posInt(process.env.SNR_FINAL_DELAY_MS, 10_000), // tunggu setelah candle tutup agar data Binance final
  BUFFER_PCT: _num(process.env.SNR_BUFFER_PCT, 0.1), // lebar pita (persen) di atas/bawah level
  STRONG_MIN_TOUCHES: _posInt(process.env.SNR_STRONG_MIN_TOUCHES, 5), // opsi `kuat`: level dengan sentuhan >= ini (R1..R3/S1..S3)
  MIN_CANDLES: 30, // data closed minimal supaya level layak dihitung
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.SNR_MAX_MSG_PER_CHAT_HOUR, 20),
  LINES_PER_MSG: _posInt(process.env.SNR_LINES_PER_MSG, 20),
  SEND_GAP_MS: _posInt(process.env.SNR_SEND_GAP_MS, 1_000),
  MAX_PER_USER: _posInt(process.env.SNR_ALERT_MAX_PER_USER, 10),
  MAX_PER_CHAT: _posInt(process.env.SNR_ALERT_MAX_PER_CHAT, 20),
  CONCURRENCY: _posInt(process.env.SNR_CONCURRENCY, 8),
});

/**
 * Alarm skenario sinyal (!alertsignal): kirim skenario seperti !signal (entry / SL / TP1 / TP2 / RR + status entri)
 * saat skenario LONG / SHORT BARU muncul di candle closed. Dinilai dari candle closed terakhir dan candle
 * sebelumnya (tanpa status tersimpan): "baru" = candle sebelumnya belum punya skenario arah yang sama.
 * Default hanya status entri VALID; opsi `tunggu` ikut mengabari status TUNGGU. HINDARI tidak pernah dikirim.
 * Isi skenario memakai aturan yang sama dengan !signal (SIGNAL_CONFIG), tetapi skor bias alarm tanpa mood pasar
 * dan BTC (sama seperti !alertind), jadi bisa sedikit beda dari !signal.
 */
const SIGNAL_ALERT_CONFIG = Object.freeze({
  VERSION: 1,
  CHECK_MS: Math.max(5_000, _posInt(process.env.SIGNAL_ALERT_CHECK_MS, 15_000)),
  INTERVAL_MS: Math.max(30_000, _posInt(process.env.SIGNAL_ALERT_INTERVAL_MS, 60_000)), // jeda ambil ulang per koin+TF
  MAX_PAIRS: _posInt(process.env.SIGNAL_ALERT_MAX_PAIRS, 60), // batas koin+TF per putaran (sisanya bergilir)
  FINAL_DELAY_MS: _posInt(process.env.SIGNAL_ALERT_FINAL_DELAY_MS, 10_000), // tunggu setelah candle tutup agar data Binance final
  COOLDOWN_CANDLES: Math.max(0, Math.floor(_num(process.env.SIGNAL_ALERT_COOLDOWN_CANDLES, 3))), // arah yang sama tidak dikirim lagi dalam N candle terakhir (cegah alarm berulang saat bias menempel di ambang); 0 = mati
  MIN_CANDLES: 52, // candle closed minimal: bias butuh 51, ditambah 1 untuk membandingkan dengan candle sebelumnya
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.SIGNAL_ALERT_MAX_MSG_PER_CHAT_HOUR, 20),
  BLOCKS_PER_MSG: _posInt(process.env.SIGNAL_ALERT_BLOCKS_PER_MSG, 3), // jumlah skenario per pesan (sisanya pesan berikutnya)
  SEND_GAP_MS: _posInt(process.env.SIGNAL_ALERT_SEND_GAP_MS, 1_000),
  MAX_PER_USER: _posInt(process.env.SIGNAL_ALERT_MAX_PER_USER, 10),
  MAX_PER_CHAT: _posInt(process.env.SIGNAL_ALERT_MAX_PER_CHAT, 20),
  CONCURRENCY: _posInt(process.env.SIGNAL_ALERT_CONCURRENCY, 8),
});

// Penilai konteks HHLL (hhllContext.js): menilai kejadian yang SUDAH dideteksi hhllCore/hhllAlertCore, tanpa mengubah detektor swing.
// Semua angka = TITIK AWAL USULAN (rencana HHLL fase 1), bukan hasil backtest. Naikkan VERSION kalau aturan diubah, dan
// setel per timeframe lewat ...BY_TF kalau backtest (scripts/backtest-hhll.js) menunjukkan satu angka global tidak cocok.
const HHLL_CONTEXT_CONFIG = Object.freeze({
  VERSION: 1,
  HTF: Object.freeze({ "15M": "1H", "1H": "4H", "4H": "1D", "1D": null }), // timeframe konteks untuk tiap TF
  VOL_LOOKBACK: 20, // pembanding volume: rata-rata sekian candle sebelum candle X
  VOL_MULT: _num(process.env.HHLL_VOL_MULT, 1.5), // volume X >= ini x rata-rata = ok
  CLOSE_BEYOND_ATR: _num(process.env.HHLL_CLOSE_BEYOND_ATR, 0.2), // close harus melewati level >= ini x ATR
  CLOSE_POS: _num(process.env.HHLL_CLOSE_POS, 0.3), // close di 30% atas (naik) / bawah (turun) range candle
  LEG_ATR: _num(process.env.HHLL_LEG_ATR, 2), // leg swing terakhir >= k x ATR
  LEG_ATR_BY_TF: Object.freeze({}), // contoh: { "15M": 3, "1D": 1.5 }
  PULLBACK_MIN: _num(process.env.HHLL_PULLBACK_MIN, 0.382), // kedalaman pullback HL/LH terhadap leg sebelumnya
  PULLBACK_MAX: _num(process.env.HHLL_PULLBACK_MAX, 0.786),
  FAIL_BARS: _posInt(process.env.HHLL_FAIL_BARS, 3), // tembusan gagal = close kembali ke dalam level dalam sekian candle
  STATUS_LOOKBACK: _posInt(process.env.HHLL_STATUS_LOOKBACK, 12), // !hhll: tembusan sampai sekian candle terakhir masih dinilai berjalan
  STATS_MIN_N: _posInt(process.env.HHLL_STATS_MIN_N, 30), // statistik historis disembunyikan kalau sampel < ini
});

// !trenstate (trenState.js, trenStateCommand.js): lanjut tren / pullback sehat / waspada reversal / reversal terkonfirmasi / range.
// SEMUA angka di bawah NILAI AWAL USULAN, belum divalidasi backtest (tampilkan sebagai heuristik). Naikkan VERSION kalau aturan diubah.
// Fitur bukti bernilai ya / tidak / null (null = data tidak ada, tidak dihitung). Putusan dari selisih skor dua sisi.
const TRENSTATE_CONFIG = Object.freeze({
  VERSION: 1,
  MIN_CANDLES: _posInt(process.env.TRENSTATE_MIN_CANDLES, 60), // candle closed minimal (EMA50 + ATR + struktur); kurang -> null "data belum cukup"
  // --- fase (kedalaman retrace leg terakhir, 0 = di ujung leg, 1 = kembali ke awal leg) ---
  CONTINUE_DEPTH: _num(process.env.TRENSTATE_CONTINUE_DEPTH, 0.236), // retrace < ini (atau close sudah membuat HH/LL baru) = LANJUT
  HEALTHY_MIN: _num(process.env.TRENSTATE_HEALTHY_MIN, 0.382), // zona retrace sehat (condong lanjut)
  HEALTHY_MAX: _num(process.env.TRENSTATE_HEALTHY_MAX, 0.618),
  DEEP_MAX: _num(process.env.TRENSTATE_DEEP_MAX, 0.786), // di atas ini hampir pasti rusak: bukti retrace dalam berbobot DEEP_WEIGHT
  DEEP_WEIGHT: _num(process.env.TRENSTATE_DEEP_WEIGHT, 2),
  RECLAIM_DEPTH: _num(process.env.TRENSTATE_RECLAIM_DEPTH, 0.382), // level "lanjut jika close kembali di atas/bawah": retrace segini dari ujung leg
  // --- fitur bukti ---
  VOL_LOOKBACK: _posInt(process.env.TRENSTATE_VOL_LOOKBACK, 20), // pembanding volume spike: rata-rata sekian candle sebelum candle itu
  VOL_CORR_MAX: _num(process.env.TRENSTATE_VOL_CORR_MAX, 0.8), // rata-rata volume koreksi <= ini x rata-rata volume leg impuls = mengering (lanjut)
  VOL_SPIKE_MULT: _num(process.env.TRENSTATE_VOL_SPIKE_MULT, 1.5), // candle melawan tren dengan volume >= ini x rata-rata = spike (reversal)
  BODY_ATR_MAX: _num(process.env.TRENSTATE_BODY_ATR_MAX, 0.6), // rata-rata body candle koreksi <= ini x ATR = body kecil (lanjut)
  SPEED_MULT: _num(process.env.TRENSTATE_SPEED_MULT, 1.0), // kecepatan koreksi (ATR/candle) >= ini x kecepatan impuls = lebih cepat (reversal)
  DIV_LOOKBACK: _posInt(process.env.TRENSTATE_DIV_LOOKBACK, 15), // divergence dihitung sampai pivot yang terkonfirmasi sekian candle terakhir
  DIV_RADIUS: _posInt(process.env.TRENSTATE_DIV_RADIUS, 3), // pivot kedua divergence harus >= (index ekstrem - ini)
  // --- putusan ---
  VERDICT_GAP: _num(process.env.TRENSTATE_VERDICT_GAP, 2), // selisih skor >= ini = condong; di bawahnya "koreksi, belum jelas"
  GRADE_STRONG_LEAD: _num(process.env.TRENSTATE_GRADE_STRONG_LEAD, 4), // selisih skor >= ini = grade kuat
  MIN_APPLICABLE: _posInt(process.env.TRENSTATE_MIN_APPLICABLE, 4), // fitur yang bisa dinilai < ini = grade lemah (bukti tipis)
  CONFIRM_BEYOND_ATR: _num(process.env.TRENSTATE_CONFIRM_BEYOND_ATR, 0.2), // grade reversal terkonfirmasi: close melewati level >= ini x ATR
  // --- histeresis: status baru dianggap berubah setelah bertahan sekian candle closed berturut-turut ---
  HYST_BARS: _posInt(process.env.TRENSTATE_HYST_BARS, 2),
  HYST_WINDOW: _posInt(process.env.TRENSTATE_HYST_WINDOW, 12), // candle terakhir yang diputar ulang untuk menentukan status stabil
  // --- backtest (trenStateBacktest.js) ---
  BT_WARMUP: 80,
  BT_WINDOW: 320, // sama dengan FETCH_LIMIT produksi
  BT_HORIZON: 24, // candle ke depan yang diamati
  BT_CONTINUE_ATR: 1, // reversal terkonfirmasi dianggap "jalan" bila bergerak >= ini x ATR sebelum close kembali ke level batal
  MIN_N_SHOW: _posInt(process.env.TRENSTATE_MIN_N_SHOW, 30), // statistik historis disembunyikan kalau N < ini
  TRAIN_FRAC: 0.6, // 60% waktu awal = stel, 40% akhir = ukur (walk-forward sederhana)
  FOLDS: 3,
  // --- chart skenario (trenStateChart.js); nilai awal usulan ---
  CHART_BARS: _posInt(process.env.TRENSTATE_CHART_BARS, 90), // candle yang digambar
  CHART_PROJ_BARS: _posInt(process.env.TRENSTATE_CHART_PROJ_BARS, 16), // lebar zona skenario di kanan (dalam slot candle)
  CHART_ARROW_ATR: _num(process.env.TRENSTATE_CHART_ARROW_ATR, 3), // panjang panah arah (x ATR) kalau tidak ada level target; skematis, bukan target harga
  // --- trendline (trenStateTrendline.js): alat bantu baca arah, TIDAK mengubah skor / status / statistik backtest ---
  TL_ENABLED: _posInt(process.env.TRENSTATE_TL_ENABLED, 1) === 1, // 0 = matikan trendline
  TL_MAX_SWINGS: _posInt(process.env.TRENSTATE_TL_MAX_SWINGS, 6), // swing sejenis terakhir yang dicoba dirangkai jadi garis
  TL_MIN_SPAN: _posInt(process.env.TRENSTATE_TL_MIN_SPAN, 8), // jarak minimal (candle) antara dua titik jangkar
  TL_MIN_TOUCHES: _posInt(process.env.TRENSTATE_TL_MIN_TOUCHES, 2), // sentuhan swing minimal (termasuk dua jangkar); naikkan ke 3 kalau mau lebih ketat
  TL_TOUCH_ATR: _num(process.env.TRENSTATE_TL_TOUCH_ATR, 0.35), // swing dianggap menyentuh garis kalau jaraknya <= ini x ATR
  TL_VIOL_ATR: _num(process.env.TRENSTATE_TL_VIOL_ATR, 0.3), // garis gugur kalau ada CLOSE lama melewatinya lebih dari ini x ATR
  TL_BREAK_MEMORY: _posInt(process.env.TRENSTATE_TL_BREAK_MEMORY, 3), // candle terakhir yang boleh sudah melewati garis (baru patah) tanpa membuat garis gugur
  TL_BREAK_ATR: _num(process.env.TRENSTATE_TL_BREAK_ATR, 0.2), // close dianggap menembus garis kalau melewatinya >= ini x ATR
  TL_NEAR_ATR: _num(process.env.TRENSTATE_TL_NEAR_ATR, 0.5), // "dekat garis" kalau jarak close ke garis <= ini x ATR
  TL_MIN_WIDTH_ATR: _num(process.env.TRENSTATE_TL_MIN_WIDTH_ATR, 1), // garis paralel (channel turunan) hanya dibuat kalau lebar jalur >= ini x ATR
  // jalur regresi (cadangan kalau tidak ada garis swing yang valid)
  TL_REG_BARS: _posInt(process.env.TRENSTATE_TL_REG_BARS, 60), // candle terakhir yang diregresi (minimal 20)
  TL_REG_K: _num(process.env.TRENSTATE_TL_REG_K, 2), // lebar jalur = k x simpangan baku residu
  TL_REG_MIN_R2: _num(process.env.TRENSTATE_TL_REG_MIN_R2, 0.35), // R2 di bawah ini = kecocokan lemah, arah regresi tidak dipakai sebagai condong
  TL_FLAT_SLOPE_ATR: _num(process.env.TRENSTATE_TL_FLAT_SLOPE_ATR, 0.025), // |kemiringan| <= ini x ATR per candle = datar
});

// Kekuatan tren (Fitur 3, trendStrength.js). SEMUA angka NILAI AWAL USULAN, belum divalidasi backtest. Naikkan VERSION kalau aturan diubah.
// Output hanya tiga tingkat (KUAT / SEDANG / LEMAH); skor internal tidak ditampilkan.
const STRENGTH_CONFIG = Object.freeze({
  VERSION: 1,
  MIN_CANDLES: _posInt(process.env.STRENGTH_MIN_CANDLES, 60), // candle closed minimal; kurang -> "data belum cukup"
  SWING_RUN_MIN: _posInt(process.env.STRENGTH_SWING_RUN_MIN, 3), // swing berlabel beruntun searah tren (HH/HL atau LL/LH) minimal
  SLOPE_ATR_MIN: _num(process.env.STRENGTH_SLOPE_ATR_MIN, 0.08), // kemiringan garis searah tren >= ini x ATR per candle
  R2_MIN: _num(process.env.STRENGTH_R2_MIN, 0.6), // kerapian garis (R2 regresi) >= ini
  CANDLE_BARS: _posInt(process.env.STRENGTH_CANDLE_BARS, 5), // candle terakhir yang dinilai (body + sumbu)
  CANDLE_MIN: _posInt(process.env.STRENGTH_CANDLE_MIN, 3), // minimal sekian dari CANDLE_BARS yang searah, body besar, sumbu lawan pendek
  BODY_ATR_MIN: _num(process.env.STRENGTH_BODY_ATR_MIN, 0.5), // body "besar" >= ini x ATR
  WICK_AGAINST_MAX: _num(process.env.STRENGTH_WICK_AGAINST_MAX, 0.35), // sumbu melawan arah tren <= ini x range candle
  RETRACE_MAX: _num(process.env.STRENGTH_RETRACE_MAX, 0.382), // retrace leg terakhir <= ini = dangkal
  VOL_BARS: _posInt(process.env.STRENGTH_VOL_BARS, 10), // candle terakhir untuk membandingkan volume searah vs berlawanan
  VOL_RATIO_MIN: _num(process.env.STRENGTH_VOL_RATIO_MIN, 1.1), // rata-rata volume candle searah >= ini x candle berlawanan
  MIN_APPLICABLE: _posInt(process.env.STRENGTH_MIN_APPLICABLE, 4), // komponen yang bisa dinilai < ini = paling tinggi LEMAH
  STRONG_RATIO: _num(process.env.STRENGTH_STRONG_RATIO, 0.75), // lolos >= ini dari yang bisa dinilai = KUAT
  WEAK_RATIO: _num(process.env.STRENGTH_WEAK_RATIO, 0.4), // lolos <= ini = LEMAH; di antaranya SEDANG
  // --- backtest (trendStrengthBacktest.js): apakah tren KUAT benar lebih sering lanjut daripada LEMAH ---
  BT_WARMUP: 80,
  BT_WINDOW: 320, // sama dengan FETCH_LIMIT produksi
  BT_HORIZON: 24, // candle ke depan yang diamati
  BT_STEP: _posInt(process.env.STRENGTH_BT_STEP, 4), // sampel tiap sekian candle (mengurangi tumpang tindih; tetap tidak independen)
  TRAIN_FRAC: 0.6, // 60% waktu awal = stel, 40% akhir = ukur (walk-forward sederhana)
  MIN_N_SHOW: _posInt(process.env.STRENGTH_MIN_N_SHOW, 30), // kesimpulan KUAT vs LEMAH hanya dibuat kalau N kedua kelompok >= ini
  Z_MIN: _num(process.env.STRENGTH_Z_MIN, 1.64), // selisih % lanjut KUAT vs LEMAH dianggap nyata kalau z >= ini (satu sisi, ~95%)
});

// Estimasi sebaran harga (Fitur 4, gaussian.js). Nilai AWAL USULAN; divalidasi lewat scripts/kalibrasi-gaussian.js. Naikkan VERSION kalau aturan diubah.
// Ini ringkasan sebaran data lama (log return), BUKAN prediksi psikologi pasar.
const GAUSSIAN_CONFIG = Object.freeze({
  VERSION: 1,
  WINDOW: _posInt(process.env.GAUSS_WINDOW, 800), // candle closed terakhir yang dipakai (jendela tetap)
  HORIZON: _posInt(process.env.GAUSS_HORIZON, 6), // candle ke depan (return h candle)
  MIN_N: _posInt(process.env.GAUSS_MIN_N, 100), // return minimal; kurang -> "data belum cukup", tanpa angka
  COND_MIN_N: _posInt(process.env.GAUSS_COND_MIN_N, 30), // kejadian mirip minimal (sama dengan STATS_MIN_N backtest)
  Z1: _num(process.env.GAUSS_Z1, 1), // rentang dalam: mu +- Z1 x sigma (~68%)
  Z2: _num(process.env.GAUSS_Z2, 2), // rentang luar: mu +- Z2 x sigma (~95%)
  KURT_WARN: _num(process.env.GAUSS_KURT_WARN, 1), // kurtosis berlebih >= ini = ekor tebal, sebaran empiris ikut ditampilkan
  CAL_STEP: _posInt(process.env.GAUSS_CAL_STEP, 0), // langkah uji kalibrasi (0 = sama dengan horizon, supaya hasil uji tidak tumpang tindih)
  CAL_TOL: _num(process.env.GAUSS_CAL_TOL, 5), // toleransi (poin %) cakupan terhadap target sebelum dianggap tidak terkalibrasi
});

// Backtest HHLL (hhllBacktest.js, scripts/backtest-hhll.js).
const HHLL_BACKTEST_CONFIG = Object.freeze({
  WARMUP: 60, // candle awal yang dilewati
  WINDOW: 320, // sama dengan FETCH_LIMIT produksi: struktur dihitung dari paling banyak 320 candle
  HORIZON: 24, // candle ke depan yang diamati
  FAIL_BARS: 3, // gagal = close kembali ke dalam level dalam K candle
  CONTINUE_ATR: 1, // lanjut = MFE >= ini x ATR sebelum close kembali ke level
  FEE_PCT: 0.1, // fee per sisi (persen), tarif spot Binance reguler
  SLIP_PCT: 0.05, // slip per sisi (persen), asumsi
  MIN_N_SHOW: 30, // statistik di !hhll disembunyikan kalau N < ini
  MIN_N_FILTER: 100, // sampel minimal per kelompok untuk memutuskan sebuah filter
  MIN_GAIN_PP: 3, // filter dipertahankan hanya kalau tingkat lanjut naik >= sekian poin persen di periode ukur
  MIN_KEEP_RATIO: 0.3, // ...dan masih menyisakan >= sekian bagian dari jumlah sinyal
  TRAIN_FRAC: 0.6, // 60% waktu awal = stel, 40% akhir = ukur
  FOLDS: 3, // walk-forward: jumlah potongan waktu berurutan
});

// Higher High / Lower Low (market structure): !hhll dan alarm !alerthhll.
// Swing = pivot (high/low tertinggi/terendah dalam +-PIVOT_WIN candle closed). Pivot baru dianggap pasti setelah
// PIVOT_WIN candle di kanannya closed, jadi candle yang belum closed tidak memunculkan atau mengubah swing.
const HHLL_CONFIG = Object.freeze({
  PIVOT_WIN: Math.max(1, _posInt(process.env.HHLL_PIVOT_WIN, 3)),
  MIN_SWING_PCT: _num(process.env.HHLL_MIN_SWING_PCT, 0.5), // gerak minimal antar swing (persen); lebih kecil = noise, dilewati
  EQUAL_PCT: _num(process.env.HHLL_EQUAL_PCT, 0.05), // selisih <= ini dianggap sama (bukan HH/LH atau HL/LL)
  MIN_CANDLES: 30, // data closed minimal supaya struktur layak dihitung
  SHOW_SWINGS: 6, // jumlah swing terakhir yang ditulis di !hhll
  CHART_BARS: 120, // jumlah candle yang digambar di chart !hhll
});

const HHLL_ALERT_CONFIG = Object.freeze({
  VERSION: 2, // v2: grade konteks, opsi kuat/searah, tahap gagal. Kunci dedupe hhllKey sengaja tetap "v1" (lihat hhllAlertCore.js)
  CHECK_MS: Math.max(5_000, _posInt(process.env.HHLL_CHECK_MS, 15_000)),
  INTERVAL_MS: Math.max(30_000, _posInt(process.env.HHLL_INTERVAL_MS, 60_000)), // jeda ambil ulang per koin+TF
  MAX_PAIRS: _posInt(process.env.HHLL_MAX_PAIRS, 60), // batas koin+TF per putaran (sisanya bergilir)
  FINAL_DELAY_MS: _posInt(process.env.HHLL_FINAL_DELAY_MS, 10_000), // tunggu setelah candle tutup agar data Binance final
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.HHLL_MAX_MSG_PER_CHAT_HOUR, 20),
  LINES_PER_MSG: _posInt(process.env.HHLL_LINES_PER_MSG, 15),
  PDF_MIN: _posInt(process.env.HHLL_PDF_MIN, 16), // kejadian >= ini (satu penerima, satu putaran) -> 1 pesan pengantar + 1 PDF
  SEND_GAP_MS: _posInt(process.env.HHLL_SEND_GAP_MS, 1_000),
  MAX_PER_USER: _posInt(process.env.HHLL_ALERT_MAX_PER_USER, 10),
  MAX_PER_CHAT: _posInt(process.env.HHLL_ALERT_MAX_PER_CHAT, 20),
  CONCURRENCY: _posInt(process.env.HHLL_CONCURRENCY, 8),
  HTF_CACHE_MS: _posInt(process.env.HHLL_HTF_CACHE_MS, 180_000), // cache candle TF besar per koin+TF (diambil hanya saat ada kejadian)
});

// Accumulation / Manipulation / Distribution (AMD, "Power of 3"): !signal (dulu !amd) dan alarm !alertamd.
//   Akumulasi   : range sempit (lebar <= RANGE_MAX_ATR x ATR) minimal RANGE_MIN_BARS candle closed, sideways, tepi atas & bawah tersentuh.
//   Manipulasi  : satu candle closed menembus high/low range (wick) lalu close kembali ke dalam range (sweep / stop hunt).
//   Distribusi  : setelah sweep, close pertama menembus swing berlawanan (market structure break, hhllCore.js) dalam CONFIRM_BARS candle.
// Angka-angkanya NILAI AWAL USULAN, bukan hasil backtest. Naikkan VERSION kalau aturan diubah.
const AMD_CONFIG = Object.freeze({
  VERSION: 1,
  MIN_CANDLES: 60, // data closed minimal supaya ATR dan range layak dihitung
  RANGE_MIN_BARS: _posInt(process.env.AMD_RANGE_MIN_BARS, 8), // candle minimum pembentuk range akumulasi
  RANGE_MAX_BARS: _posInt(process.env.AMD_RANGE_MAX_BARS, 40), // candle maksimum yang dipindai ke belakang
  RANGE_MAX_ATR: _num(process.env.AMD_RANGE_MAX_ATR, 5), // lebar range (high-low) maksimum dalam kelipatan ATR(14)
  EDGE_FRAC: _num(process.env.AMD_EDGE_FRAC, 0.25), // tepi range = 25% teratas / terbawah dari lebar range
  EDGE_MIN_TOUCHES: _posInt(process.env.AMD_EDGE_MIN_TOUCHES, 2), // tepi atas dan bawah masing-masing minimal disentuh sekian candle
  DRIFT_MAX: _num(process.env.AMD_DRIFT_MAX, 0.6), // |close akhir - close awal| maksimum = 60% lebar range (kalau lebih = tren, bukan sideways)
  SWEEP_MIN_ATR: _num(process.env.AMD_SWEEP_MIN_ATR, 0.1), // tembusan minimal di luar tepi range (kelipatan ATR); lebih kecil = noise
  CONFIRM_BARS: _posInt(process.env.AMD_CONFIRM_BARS, 10), // batas candle setelah sweep untuk menunggu break struktur
  STATE_LOOKBACK: _posInt(process.env.AMD_STATE_LOOKBACK, 12), // !signal: sweep sampai sekian candle terakhir masih dianggap fase berjalan
  VOL_LOOKBACK: 20, // pembanding volume range akumulasi (info saja, bukan syarat)
  CHART_BARS: 110, // jumlah candle yang digambar di chart AMD di !signal
});

const AMD_ALERT_CONFIG = Object.freeze({
  VERSION: 1,
  CHECK_MS: Math.max(5_000, _posInt(process.env.AMD_CHECK_MS, 15_000)),
  INTERVAL_MS: Math.max(30_000, _posInt(process.env.AMD_INTERVAL_MS, 60_000)), // jeda ambil ulang per koin+TF
  MAX_PAIRS: _posInt(process.env.AMD_MAX_PAIRS, 60), // batas koin+TF per putaran (sisanya bergilir)
  FINAL_DELAY_MS: _posInt(process.env.AMD_FINAL_DELAY_MS, 10_000), // tunggu setelah candle tutup agar data Binance final
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.AMD_MAX_MSG_PER_CHAT_HOUR, 20),
  LINES_PER_MSG: _posInt(process.env.AMD_LINES_PER_MSG, 15),
  SEND_GAP_MS: _posInt(process.env.AMD_SEND_GAP_MS, 1_000),
  MAX_PER_USER: _posInt(process.env.AMD_ALERT_MAX_PER_USER, 10),
  MAX_PER_CHAT: _posInt(process.env.AMD_ALERT_MAX_PER_CHAT, 20),
  CONCURRENCY: _posInt(process.env.AMD_CONCURRENCY, 8),
  // Rencana SL/TP otomatis (ikut di tiap notifikasi). Entry: harga close (konfirmasi) atau level break struktur (dini).
  // SL = di luar ujung sweep + SL_ATR_BUFFER x ATR. TP = entry +/- kelipatan jarak SL (R). Usulan awal, bukan hasil backtest.
  RR_TP1: _num(process.env.AMD_RR_TP1, 1.5), // TP1 default (kelipatan R); bisa diganti per alarm: !alertamd btc 4h rr2:4
  RR_TP2: _num(process.env.AMD_RR_TP2, 3), // TP2 default (kelipatan R)
  RR_MIN: 0.5, // batas bawah kelipatan R yang boleh diset user
  RR_MAX: 20, // batas atas kelipatan R yang boleh diset user
  SL_ATR_BUFFER: _num(process.env.AMD_SL_ATR_BUFFER, 0.2), // jarak tambahan SL di luar ujung sweep (kelipatan ATR); 0 = tepat di ujung sweep
  CAPTION_MAX: 1000, // batas aman caption gambar WhatsApp (1024); lebih dari ini gambar dan teks dikirim terpisah
});

/**
 * Alarm USDT.D masuk golden zone (!alertdusdt): kirim kabar saat level USDT Dominance (nilai terkini, sama dengan
 * !dusdt) MASUK ke golden zone Fibonacci 0.5-0.618 pada swing USDT.D di timeframe yang dipilih (fib dihitung dari
 * candle closed USDT.D, persis seperti !dusdt / !fib).
 *
 * Aturan "masuk": sebelumnya di luar zona, sekarang di dalam. Zona baru dianggap ditinggalkan setelah level keluar
 * lebih dari REARM_MARGIN (selisih kedalaman retracement) dari tepi zona, supaya level yang bolak-balik di tepi zona
 * tidak memicu alarm berulang. Kalau swing Fibonacci berganti, status hanya disinkronkan ulang tanpa alarm (zona
 * bergeser bukan berarti harga yang bergerak). Kondisi yang sudah ada saat alarm dibuat tidak diumumkan.
 * Semua angka bisa diubah lewat env; naikkan VERSION kalau aturan diubah.
 */
const DUSDT_ALERT_CONFIG = Object.freeze({
  VERSION: 1,
  CHECK_MS: Math.max(5_000, _posInt(process.env.DUSDT_ALERT_CHECK_MS, 30_000)),
  INTERVAL_MS: Math.max(60_000, _posInt(process.env.DUSDT_ALERT_INTERVAL_MS, 120_000)), // jeda ambil ulang per timeframe (data penyedia di-cache 1-5 menit)
  ZONE_LOW: _num(process.env.DUSDT_ALERT_ZONE_LOW, 0.5), // tepi atas zona (kedalaman retracement)
  ZONE_HIGH: _num(process.env.DUSDT_ALERT_ZONE_HIGH, 0.618), // tepi bawah zona
  REARM_MARGIN: _num(process.env.DUSDT_ALERT_REARM_MARGIN, 0.03), // keluar zona > margin ini baru dianggap benar-benar keluar
  MAX_MSG_PER_CHAT_HOUR: _posInt(process.env.DUSDT_ALERT_MAX_MSG_PER_CHAT_HOUR, 10),
  MAX_PER_USER: _posInt(process.env.DUSDT_ALERT_MAX_PER_USER, 4),
  MAX_PER_CHAT: _posInt(process.env.DUSDT_ALERT_MAX_PER_CHAT, 8),
});

// !pola (patternCore.js): fondasi pengenal pola (catatan saran "Pengenalan Pola", Bagian 2, 9, 11).
// SEMUA angka di bawah NILAI AWAL USULAN, belum divalidasi backtest (tampilkan sebagai heuristik). Naikkan VERSION kalau aturan diubah.
// Pola = bukti bersyarat (level konfirmasi + level batal), bukan sinyal. Toleransi dalam ATR, bukan persen tetap.
const PATTERN_CONFIG = Object.freeze({
  VERSION: 3, // 2 = Fase 1 candlestick; 3 = Fase 2 pola swing (swingPatterns.js)
  MIN_CANDLES: _posInt(process.env.PATTERN_MIN_CANDLES, 60), // candle closed minimal (ATR + swing); kurang -> null "data belum cukup"
  MIN_SWINGS: _posInt(process.env.PATTERN_MIN_SWINGS, 4), // swing berlabel minimal untuk pola swing/garis
  // --- ukuran umum (satuan ATR) ---
  BODY_MIN_ATR: _num(process.env.PATTERN_BODY_MIN_ATR, 0.5), // body minimal pola candlestick bermakna
  EQUAL_TOL_ATR: _num(process.env.PATTERN_EQUAL_TOL_ATR, 0.6), // dua level dianggap setara (double top/bottom)
  SHOULDER_TOL_ATR: _num(process.env.PATTERN_SHOULDER_TOL_ATR, 1.0), // bahu setara (head and shoulders)
  CONFIRM_BEYOND_ATR: _num(process.env.PATTERN_CONFIRM_BEYOND_ATR, 0.2), // grade kuat: close melewati level konfirmasi >= ini x ATR
  // --- grade tiga tingkat (kuat / sedang / lemah), tanpa persentase ---
  GRADE_STRONG_NET: _posInt(process.env.PATTERN_GRADE_STRONG_NET, 2), // bukti (+) dikurangi (-) >= ini (dan terkonfirmasi) = kuat
  GRADE_MEDIUM_NET: _posInt(process.env.PATTERN_GRADE_MEDIUM_NET, 0), // >= ini = sedang; di bawahnya lemah
  MIN_EVIDENCE: _posInt(process.env.PATTERN_MIN_EVIDENCE, 2), // bukti yang bisa dinilai < ini = paling tinggi lemah
  // --- aturan prioritas (Bagian 9) ---
  LOCATION_TOL_CANDLES: _posInt(process.env.PATTERN_LOCATION_TOL_CANDLES, 2), // candlestick dianggap "di lokasi pola besar" bila <= sekian candle dari titik kunci
  OB_BOS_MAX_GAP: _posInt(process.env.PATTERN_OB_BOS_MAX_GAP, 10), // order block hanya sah bila BOS searah terjadi <= sekian candle setelahnya
  // --- histeresis dan dedupe (seperti !trenstate) ---
  HYST_BARS: _posInt(process.env.PATTERN_HYST_BARS, 2), // status baru berlaku setelah bertahan sekian candle closed berturut-turut
  HYST_WINDOW: _posInt(process.env.PATTERN_HYST_WINDOW, 12),
  // --- Fase 1: candlestick (candlePatterns.js). Semua NILAI AWAL USULAN, belum tervalidasi. ---
  MAX_SHOW: _posInt(process.env.PATTERN_MAX_SHOW, 4), // pola yang ditampilkan per timeframe (sisanya diringkas)
  RECENT_BARS: _posInt(process.env.PATTERN_RECENT_BARS, 3), // pola yang berakhir <= sekian candle closed terakhir ditampilkan
  BIG_BODY_ATR: _num(process.env.PATTERN_BIG_BODY_ATR, 0.8), // candle "besar" (star candle 1, piercing / dark cloud candle 1)
  HARAMI_BODY_ATR: _num(process.env.PATTERN_HARAMI_BODY_ATR, 1.0), // body candle induk harami
  THREE_METHODS_BIG_ATR: _num(process.env.PATTERN_THREE_METHODS_BIG_ATR, 1.0), // body candle besar pertama/terakhir three methods
  SMALL_BODY_ATR: _num(process.env.PATTERN_SMALL_BODY_ATR, 0.3), // body candle tengah star (<= ini x ATR)
  PIN_WICK_PCT: _num(process.env.PATTERN_PIN_WICK_PCT, 0.6), // pin bar: sumbu panjang >= 60% range
  PIN_WICK_BODY_MULT: _num(process.env.PATTERN_PIN_WICK_BODY_MULT, 2), // pin bar: sumbu >= 2 x body
  PIN_RANGE_ATR: _num(process.env.PATTERN_PIN_RANGE_ATR, 0.8), // pin bar: range >= ini x ATR
  DOJI_BODY_PCT: _num(process.env.PATTERN_DOJI_BODY_PCT, 0.1), // doji: body <= 10% range
  DOJI_RANGE_ATR: _num(process.env.PATTERN_DOJI_RANGE_ATR, 0.5), // doji: range >= ini x ATR (buang noise)
  DOJI_LONG_WICK_PCT: _num(process.env.PATTERN_DOJI_LONG_WICK_PCT, 0.6), // dragonfly / gravestone: sumbu panjang >= 60% range
  DOJI_SHORT_WICK_PCT: _num(process.env.PATTERN_DOJI_SHORT_WICK_PCT, 0.1), // dragonfly / gravestone: sumbu sisi lain <= 10% range
  LEGGED_WICK_PCT: _num(process.env.PATTERN_LEGGED_WICK_PCT, 0.35), // long-legged doji: tiap sumbu >= 35% range
  LEGGED_RANGE_ATR: _num(process.env.PATTERN_LEGGED_RANGE_ATR, 1.0), // long-legged doji: range >= ini x ATR
  SPINNING_BODY_PCT: _num(process.env.PATTERN_SPINNING_BODY_PCT, 0.3), // spinning top: body <= 30% range
  SPINNING_WICK_PCT: _num(process.env.PATTERN_SPINNING_WICK_PCT, 0.25), // spinning top: tiap sumbu >= 25% range
  MARUBOZU_BODY_PCT: _num(process.env.PATTERN_MARUBOZU_BODY_PCT, 0.9), // marubozu: body >= 90% range
  MARUBOZU_RANGE_ATR: _num(process.env.PATTERN_MARUBOZU_RANGE_ATR, 1.2), // marubozu: range >= ini x ATR
  BELT_OPEN_WICK_PCT: _num(process.env.PATTERN_BELT_OPEN_WICK_PCT, 0.05), // belt hold: sumbu di sisi open <= 5% range
  TWEEZER_TOL_ATR: _num(process.env.PATTERN_TWEEZER_TOL_ATR, 0.15), // tweezer: selisih high (low) <= ini x ATR
  TWEEZER_RANGE_ATR: _num(process.env.PATTERN_TWEEZER_RANGE_ATR, 0.5), // tweezer: range tiap candle >= ini x ATR
  PIERCE_OPEN_TOL_ATR: _num(process.env.PATTERN_PIERCE_OPEN_TOL_ATR, 0.1), // piercing / dark cloud: open candle 2 <= (>=) close candle 1 +- ini x ATR. LONGGAR dari usulan "open melewati ekstrem" yang jarang terjadi di pasar 24 jam tanpa gap
  INSIDE_MOTHER_MIN_ATR: _num(process.env.PATTERN_INSIDE_MOTHER_MIN_ATR, 0.8), // inside bar: range candle induk >= ini x ATR
  SOLDIER_BODY_ATR: _num(process.env.PATTERN_SOLDIER_BODY_ATR, 0.5), // three soldiers / crows: body tiap candle >= ini x ATR
  SOLDIER_WICK_PCT: _num(process.env.PATTERN_SOLDIER_WICK_PCT, 0.3), // three soldiers / crows: sumbu lawan <= 30% range
  THREE_METHODS_SMALL_RATIO: _num(process.env.PATTERN_THREE_METHODS_SMALL_RATIO, 0.5), // three methods: body tiap candle koreksi <= ini x body candle besar pertama
  PRIOR_MOVE_BARS: _posInt(process.env.PATTERN_PRIOR_MOVE_BARS, 2), // engulfing / tweezer: gerak searah >= sekian candle (close menurun/menaik beruntun) sebelum pola
  // --- konteks wajib: ekstrem swing / zona SNR (tanpa lookahead) ---
  EXT_LOOKBACK: _posInt(process.env.PATTERN_EXT_LOOKBACK, 20), // ekstrem berjalan: low/high pola dibanding sekian candle sebelum pola
  EXT_TOL_ATR: _num(process.env.PATTERN_EXT_TOL_ATR, 0.5), // toleransi "di ekstrem" (x ATR)
  SWING_TOL_ATR: _num(process.env.PATTERN_SWING_TOL_ATR, 0.5), // dekat swing terkonfirmasi (x ATR)
  SWING_LOOKBACK: _posInt(process.env.PATTERN_SWING_LOOKBACK, 80), // swing yang dipakai: yang terbentuk <= sekian candle sebelum pola
  SNR_ZONE_ATR: _num(process.env.PATTERN_SNR_ZONE_ATR, 0.25), // zona SNR (x ATR), sama dengan SUDDEN_CONFIG.ZONE_ATR
  BREAKOUT_LOOKBACK: _posInt(process.env.PATTERN_BREAKOUT_LOOKBACK, 20), // marubozu / three soldiers: "keluar range" = close melewati ekstrem sekian candle sebelumnya
  // --- bukti tambahan (+/-) ---
  EV_BIG_BODY_ATR: _num(process.env.PATTERN_EV_BIG_BODY_ATR, 1.0), // bukti (+) bila body candle penentu >= ini x ATR
  EV_VOL_LOOKBACK: _posInt(process.env.PATTERN_EV_VOL_LOOKBACK, 20),
  EV_VOL_HIGH: _num(process.env.PATTERN_EV_VOL_HIGH, 1.2), // volume >= ini x rata-rata = bukti (+)
  EV_VOL_LOW: _num(process.env.PATTERN_EV_VOL_LOW, 0.8), // volume <= ini x rata-rata = bukti (-)
  // --- Fase 2: pola swing (swingPatterns.js). Semua NILAI AWAL USULAN, belum tervalidasi. ---
  SW_MIN_BARS: _posInt(process.env.PATTERN_SW_MIN_BARS, 5), // double top/bottom + equal highs/lows: jarak antar puncak >= sekian candle
  SW_MAX_BARS: _posInt(process.env.PATTERN_SW_MAX_BARS, 60), // ... dan <= sekian candle
  DT_VALLEY_ATR: _num(process.env.PATTERN_DT_VALLEY_ATR, 1.5), // double top/bottom: lembah (puncak) antara sedalam >= ini x ATR
  HS_HEAD_ATR: _num(process.env.PATTERN_HS_HEAD_ATR, 0.5), // head and shoulders: kepala melewati kedua bahu >= ini x ATR
  EQ_TOL_ATR: _num(process.env.PATTERN_EQ_TOL_ATR, 0.3), // equal highs/lows: selisih <= ini x ATR
  RECT_TOL_ATR: _num(process.env.PATTERN_RECT_TOL_ATR, 0.5), // rectangle: tiap sisi setara dalam ini x ATR
  RECT_MIN_HEIGHT_ATR: _num(process.env.PATTERN_RECT_MIN_HEIGHT_ATR, 2), // rectangle: tinggi >= ini x ATR
  RECT_MIN_BARS: _posInt(process.env.PATTERN_RECT_MIN_BARS, 15), // rectangle: lebar >= sekian candle
  RECT_MAX_SWINGS: _posInt(process.env.PATTERN_RECT_MAX_SWINGS, 10), // rectangle: swing terakhir yang dicoba dirangkai
  BREAK_BODY_ATR: _num(process.env.PATTERN_BREAK_BODY_ATR, 0.5), // breakout-retest: body candle tembus >= ini x ATR
  RETEST_MIN_BARS: _posInt(process.env.PATTERN_RETEST_MIN_BARS, 3), // retest: sentuhan ulang paling cepat sekian candle setelah tembus
  RETEST_MAX_BARS: _posInt(process.env.PATTERN_RETEST_MAX_BARS, 20), // ... paling lambat
  RETEST_TOUCH_ATR: _num(process.env.PATTERN_RETEST_TOUCH_ATR, 0.3), // retest: jarak sentuh ke level <= ini x ATR
  SW_RECENT_BARS: _posInt(process.env.PATTERN_SW_RECENT_BARS, 5), // pola swing terkonfirmasi / BOS / CHoCH ditampilkan bila <= sekian candle terakhir
  SW_CANDIDATE_BARS: _posInt(process.env.PATTERN_SW_CANDIDATE_BARS, 40), // calon masih ditampilkan bila swing terakhirnya sah <= sekian candle lalu
  // --- chart bukti !pola (patternChart.js) ---
  CHART_BARS: _posInt(process.env.PATTERN_CHART_BARS, 70), // candle yang digambar (nilai awal usulan)
  // --- Fase 5: pola garis dan zona (linePatterns.js, zonePatterns.js). NILAI AWAL USULAN, belum tervalidasi. ---
  LN_MAX_SWINGS: _posInt(process.env.PATTERN_LN_MAX_SWINGS, 8), // segitiga/wedge/channel: swing terakhir yang dicoba dirangkai
  LN_MIN_BARS: _posInt(process.env.PATTERN_LN_MIN_BARS, 15), // lebar pola >= sekian candle
  LN_MIN_HEIGHT_ATR: _num(process.env.PATTERN_LN_MIN_HEIGHT_ATR, 1.5), // lebar awal (jarak dua garis) >= ini x ATR
  LN_TOUCH_ATR: _num(process.env.PATTERN_LN_TOUCH_ATR, 0.3), // sentuhan: jarak swing ke garis <= ini x ATR
  LN_MIN_TOUCHES: _posInt(process.env.PATTERN_LN_MIN_TOUCHES, 3), // sentuhan total minimal
  LN_FLAT_SLOPE_ATR: _num(process.env.PATTERN_LN_FLAT_SLOPE_ATR, 0.02), // garis rata: |kemiringan| <= ini (ATR per candle)
  LN_PARALLEL_TOL: _num(process.env.PATTERN_LN_PARALLEL_TOL, 0.02), // channel: selisih kemiringan <= ini (ATR per candle)
  LN_CONTRACT_RATIO: _num(process.env.PATTERN_LN_CONTRACT_RATIO, 0.8), // menyempit: lebar akhir <= ini x lebar awal
  FLAG_POLE_ATR: _num(process.env.PATTERN_FLAG_POLE_ATR, 3), // flag: impuls >= ini x ATR
  FLAG_POLE_BARS: _posInt(process.env.PATTERN_FLAG_POLE_BARS, 8), // ... dalam <= sekian candle
  FLAG_RETRACE_MAX: _num(process.env.PATTERN_FLAG_RETRACE_MAX, 0.5), // koreksi <= ini x impuls (lebih dalam = batal)
  FLAG_MIN_BARS: _posInt(process.env.PATTERN_FLAG_MIN_BARS, 3), // koreksi minimal sekian candle
  FLAG_MAX_BARS: _posInt(process.env.PATTERN_FLAG_MAX_BARS, 15), // koreksi maksimal sekian candle (lebih lama = kedaluwarsa)
  FLAG_SCAN_BARS: _posInt(process.env.PATTERN_FLAG_SCAN_BARS, 30), // puncak impuls dicari dalam sekian candle terakhir
  ZN_GAP_ATR: _num(process.env.PATTERN_ZN_GAP_ATR, 0.3), // FVG: ukuran gap >= ini x ATR
  ZN_IMPULSE_ATR: _num(process.env.PATTERN_ZN_IMPULSE_ATR, 1), // FVG: range candle 2 >= ini x ATR
  ZN_OB_IMPULSE_ATR: _num(process.env.PATTERN_ZN_OB_IMPULSE_ATR, 3), // order block: impuls >= ini x ATR
  ZN_OB_IMPULSE_BARS: _posInt(process.env.PATTERN_ZN_OB_IMPULSE_BARS, 8), // ... dalam <= sekian candle
  ZN_OB_BACK: _posInt(process.env.PATTERN_ZN_OB_BACK, 3), // candle berlawanan dicari mundur sekian candle dari dasar impuls
  ZN_MAX_AGE: _posInt(process.env.PATTERN_ZN_MAX_AGE, 60), // zona ditampilkan bila terbentuk <= sekian candle lalu
  ZN_WAIT: _posInt(process.env.PATTERN_ZN_WAIT, 40), // backtest: tunggu sentuhan pertama paling lama sekian candle
  ZN_BASE_STRIDE: _posInt(process.env.PATTERN_ZN_BASE_STRIDE, 5), // backtest baseline zona: satu level acak tiap sekian candle
  // --- Fase 4: backtest pola (patternBacktest.js, Bagian 10). NILAI AWAL USULAN, belum tervalidasi. ---
  BT_WARMUP: _posInt(process.env.PATTERN_BT_WARMUP, 80), // candle awal yang dilewati (ATR + swing)
  BT_WINDOW: _posInt(process.env.PATTERN_BT_WINDOW, 320), // jendela per candle, sama dengan FETCH_LIMIT produksi
  BT_HORIZON: _posInt(process.env.PATTERN_BT_HORIZON, 24), // candle ke depan yang diamati
  BT_CONTINUE_ATR: _num(process.env.PATTERN_BT_CONTINUE_ATR, 1), // "jalan" = gerak searah >= ini x ATR sebelum close melewati level batal
  BT_TRAIN_FRAC: _num(process.env.PATTERN_BT_TRAIN_FRAC, 0.6), // 60% waktu awal = stel, 40% akhir = ukur (out-of-sample)
  BT_BASE_LOOKBACK: _posInt(process.env.PATTERN_BT_BASE_LOOKBACK, 20), // baseline: tembus ekstrem sekian candle sebelumnya
  BT_BASE_COOLDOWN: _posInt(process.env.PATTERN_BT_BASE_COOLDOWN, 6), // baseline: jeda antar sampel (kurangi tumpang tindih)
  BT_MIN_EDGE_PCT: _num(process.env.PATTERN_BT_MIN_EDGE_PCT, 0), // pola harus unggul >= ini poin persen "jalan" atas baseline, dan tidak lebih sering gagal
  // --- statistik historis (Bagian 12) ---
  STATS_MIN_N: _posInt(process.env.PATTERN_STATS_MIN_N, 30), // statistik disembunyikan kalau sampel < ini
});

// Alarm pola !alertpola (patternAlertCore.js). Paket 1 hanya butuh batas jumlah alarm dan koin; interval cek, jeda kirim, dan
// pemecah pesan dipakai paket berikutnya (engine / command). Angkanya NILAI AWAL USULAN, bukan hasil pengukuran.
const PATTERN_ALERT_CONFIG = Object.freeze({
  VERSION: 1,
  MAX_PER_USER: _posInt(process.env.PATALERT_MAX_PER_USER, 10), // alarm per orang
  MAX_PER_CHAT: _posInt(process.env.PATALERT_MAX_PER_CHAT, 20), // alarm per chat (grup)
  MAX_COINS_PER_ALERT: _posInt(process.env.PATALERT_MAX_COINS, 30), // koin yang dipantau satu alarm `watchlist` (sisanya dipotong, bukan semua koin)
  LINES_PER_MSG: _posInt(process.env.PATALERT_LINES_PER_MSG, 8), // kejadian per pesan (satu kejadian = beberapa baris)
});

module.exports = { PATTERN_ALERT_CONFIG, INDICATOR_CONFIG, BIAS_CONFIG, SIGNAL_CONFIG, PROB_CONFIG, SUDDEN_CONFIG, POSITION_CONFIG, ADV_ALERT_CONFIG, SNR_ALERT_CONFIG, SIGNAL_ALERT_CONFIG, HHLL_CONFIG, HHLL_CONTEXT_CONFIG, HHLL_BACKTEST_CONFIG, HHLL_ALERT_CONFIG, TRENSTATE_CONFIG, STRENGTH_CONFIG, GAUSSIAN_CONFIG, PATTERN_CONFIG, AMD_CONFIG, AMD_ALERT_CONFIG, DUSDT_ALERT_CONFIG };
