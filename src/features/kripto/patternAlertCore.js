"use strict";

/**
 * features/kripto/patternAlertCore.js
 * ------------------------------------------------------------------
 * Aturan MURNI alarm !alertpola (tanpa jaringan, tanpa penyimpanan, bisa diuji unit). Fitur 5A, Paket 1/4.
 * Meniru hhllAlertCore.js. Engine / command / penyimpanan ada di paket berikutnya.
 *
 * Dua tahap, dinilai dari candle CLOSED terakhir (X) dengan membandingkan hasil pindai
 * SEBELUM X (prefix candle) dan SESUDAH X (scanTf di patternCommand.js, tanpa lookahead):
 *   DINI (early)   : pola baru yang muncul di X dengan status CALON (belum ada close menembus level konfirmasi).
 *   KONFIRMASI     : pola yang di X berstatus TERKONFIRMASI padahal sebelum X belum (CALON, atau belum ada sama sekali).
 * Pola BATAL tidak diumumkan. Satu kejadian diumumkan sekali (kunci dedupe), hanya kejadian setelah alarm dibuat.
 *
 * Catatan: pola berstatus CALON tidak pernah lebih tinggi dari grade "sedang" (patternCore.gradeOf), jadi `dini` + `kuat`
 * tidak akan pernah cocok; parser menolak kombinasi itu daripada membuat alarm yang diam selamanya.
 *
 * Pesan versi A belum memuat prioritas TF besar, kekuatan tren, atau Gaussian. Baris tambahan didaftarkan lewat
 * EXTRA_LINE_BUILDERS (fungsi (lang, ev) -> string | null), tanpa mengubah buildLine / buildPatternText.
 */

const { t } = require("../../i18n");
const { fmtPrice } = require("../../utils/priceFormat");
const { PATTERN_ALERT_CONFIG: PA } = require("../../config/indicatorConfig");
const { TF_MS, TF_LABEL, COIN_WATCHLIST, DAILY_TZ_LABEL, fmtCandleTime } = require("./divAlertCore");

const DIRS = ["up", "down"]; // pola netral (doji, rectangle, dst) = dir "neutral", hanya cocok kalau arah tidak dibatasi
const STAGES = ["early", "confirm"];
const DEFAULT_STAGES = [...STAGES];
const TF_ORDER = ["1D", "4H", "1H", "15M"];
const STAGE_RANK = { confirm: 0, early: 1 };
const GRADE_RANK = { kuat: 0, sedang: 1, lemah: 2 };
const GRADE_KEY = { kuat: "hhllalert.grade.strong", sedang: "hhllalert.grade.medium", lemah: "hhllalert.grade.weak" };
const ICON = { up: "🟢", down: "🔴", neutral: "⚪" };

const isNum = (v) => typeof v === "number" && isFinite(v);

/** Formatter bersama (utils/priceFormat.js, murni: tetap bisa diuji tanpa memuat canvas/axios). dp = presisi koin dari hasil pindai. */
const fmtLevel = (p, dp) => fmtPrice(p, dp);

// =====================================================================
// 1. Deteksi kejadian
// =====================================================================

/** Arah alarm dari arah pola patternCore: bullish -> up, bearish -> down, selain itu neutral. */
const dirOf = (p) => (p.dir === "bullish" ? "up" : p.dir === "bearish" ? "down" : "neutral");

/**
 * Identitas satu pola lintas dua pindaian (prefix vs lengkap). Index candle tidak bergeser karena prefix = awal array yang sama.
 * startI sengaja tidak dipakai: pola yang masih tumbuh bisa menggeser awalnya, sedangkan candle penutupnya tetap.
 */
const patternId = (p) => [p.variant || p.kind, p.dir, p.endI].join(":");

/**
 * @param {object[]} prevPatterns hasil pindai pada candle closed SEBELUM X (boleh kosong / null = belum ada data)
 * @param {object[]} nowPatterns  hasil pindai pada candle closed sampai X
 * @returns {{stage:"early"|"confirm", dir:"up"|"down"|"neutral", kind:string, variant:string|null, grade:string, status:string,
 *   level:number, invalid:number, id:string}[]}  coin/tf/now/candleT diisi engine lewat withMeta()
 */
function detectEvents(prevPatterns, nowPatterns) {
  const prev = new Map();
  for (const p of prevPatterns || []) prev.set(patternId(p), p);
  const out = [];
  for (const p of nowPatterns || []) {
    if (!p || !isNum(p.confirmLevel) || !isNum(p.invalidLevel)) continue; // pola wajib bersyarat: ada level konfirmasi + batal
    const before = prev.get(patternId(p));
    let stage = null;
    if (p.status === "confirmed" && before?.status !== "confirmed") stage = "confirm";
    else if (p.status === "candidate" && !before) stage = "early";
    if (!stage) continue;
    out.push({
      stage,
      dir: dirOf(p),
      kind: p.kind,
      variant: p.variant || null,
      grade: p.grade || "lemah",
      status: p.status,
      level: p.confirmLevel,
      invalid: p.invalidLevel,
      momentumAgainst: !!p.momentumAgainst, // tweezer yang MACD dan RSI-nya melawan (grade sudah dibatasi lemah)
      id: patternId(p),
      endI: p.endI, // index candle penutup di array yang dipindai; engine memakainya untuk kunci dedupe berbasis waktu
    });
  }
  return out;
}

/** Lengkapi kejadian dengan konteks pindai. candleT = waktu BUKA candle X, now = close X. */
function withMeta(events, { coin, tf, candleT, now }) {
  return events.map((e) => ({ ...e, coin, tf, candleT, now }));
}

/**
 * Kejadian hanya sah kalau candle X TUTUP setelah alarm dibuat (tfMs diberikan; sama dengan aturan hhllAlertEngine).
 * Tanpa tfMs: candle X harus DIBUKA pada/sesudah alarm dibuat (lebih ketat; perilaku lama).
 */
const isAfterCreation = (sub, candleT, tfMs) => !isNum(sub?.createdAt) || (isNum(tfMs) && tfMs > 0 ? candleT + tfMs > sub.createdAt : candleT >= sub.createdAt);

/**
 * Saring kejadian sesuai langganan { dirs, anyDir, stages, strongOnly }.
 */
function matchSub(ev, sub) {
  if (ev.dir === "neutral") {
    if (!sub.anyDir) return false;
  } else if (!sub.dirs.includes(ev.dir)) return false;
  if (!sub.stages.includes(ev.stage)) return false;
  if (sub.strongOnly && ev.grade !== "kuat") return false;
  return true;
}

// =====================================================================
// 2. Kunci dedupe
// =====================================================================
/**
 * candleT = waktu BUKA candle X. Satu kejadian per (penerima, koin, TF, tahap, arah, pola, candle).
 * Pola ikut ke kunci (id memuat jenis + arah + candle penutup) supaya dua pola berbeda di candle yang sama tidak saling menutupi.
 */
const patKey = (chat, userJid, coin, tf, stage, ev, candleT) => ["pat", "v1", chat, userJid, coin, tf, stage, ev.dir, ev.id, candleT].join("|");

// =====================================================================
// 3. Parser command
// =====================================================================
const COIN_RE = /^[A-Z0-9]{1,15}$/;
const DIR_TOKENS = { naik: "up", up: "up", bull: "up", bullish: "up", turun: "down", down: "down", bear: "down", bearish: "down" };
const STAGE_TOKENS = { dini: "early", early: "early", konfirmasi: "confirm", confirm: "confirm", confirmed: "confirm", final: "confirm", closed: "confirm" };
const STRONG_TOKENS = new Set(["kuat", "strong"]);
const WATCH_TOKENS = new Set(["watchlist", "wl"]);
const LIST_TOKENS = new Set(["list", "daftar", "ls"]);
const DELETE_TOKENS = new Set(["hapus", "delete", "del", "remove", "rm"]);
const OFF_TOKENS = new Set(["off", "mati", "matikan"]);
const ALL_TOKENS = new Set(["semua", "all"]);

/**
 * !alertpola <koin|watchlist> [15m|1H|4H|1D] [naik|turun] [dini|konfirmasi] [kuat]
 * !alertpola list | off | hapus <id|semua>
 * Tanpa naik/turun = dua arah (pola netral ikut). Dengan naik atau turun = hanya arah itu (pola netral tidak ikut).
 * Tanpa dini/konfirmasi = keduanya. `kuat` = hanya grade pola "kuat" (otomatis hanya konfirmasi).
 * @returns {object|null} null = format salah (-> tampilkan penjelasan command)
 *   action: "list" | "deleteAll" | "delete" | "noAll" | "conflict" | "create"
 */
function parsePatternArgs(raw, defaultTf) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0].toLowerCase();
  if (LIST_TOKENS.has(first)) return tokens.length === 1 ? { action: "list" } : null;
  if (OFF_TOKENS.has(first)) return tokens.length === 1 ? { action: "deleteAll", viaOff: true } : null;
  if (DELETE_TOKENS.has(first)) {
    if (tokens.length !== 2) return null;
    const arg = tokens[1].toLowerCase();
    if (ALL_TOKENS.has(arg)) return { action: "deleteAll" };
    const m = arg.match(/^#?p?(\d{1,6})$/);
    return m ? { action: "delete", id: `p${Number(m[1])}` } : null;
  }

  let coin = null;
  let tf = null;
  let strongOnly = false;
  const dirs = [];
  const stages = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const up = tok.toUpperCase();
    if (TF_MS[up]) tf = up;
    else if (DIR_TOKENS[low]) dirs.push(DIR_TOKENS[low]);
    else if (STAGE_TOKENS[low]) stages.push(STAGE_TOKENS[low]);
    else if (STRONG_TOKENS.has(low)) strongOnly = true;
    else if (coin == null) {
      if (WATCH_TOKENS.has(low)) coin = COIN_WATCHLIST;
      else if (ALL_TOKENS.has(low)) return { action: "noAll" }; // semua koin terlalu berat; pakai watchlist
      else if (COIN_RE.test(up)) coin = up;
      else return null;
    } else return null;
  }
  if (!coin) return null;
  const pick = (arr, all, dflt) => (arr.length ? all.filter((x) => arr.includes(x)) : dflt);
  const sub = {
    action: "create",
    coin,
    tf: tf || defaultTf,
    dirs: pick(dirs, DIRS, [...DIRS]),
    anyDir: dirs.length === 0,
    stages: pick(stages, STAGES, [...DEFAULT_STAGES]),
    strongOnly,
  };
  // Pola CALON tidak pernah kuat -> alarm "dini kuat" tidak akan pernah bunyi. Tolak, jangan diam-diam.
  if (strongOnly && stages.length && !sub.stages.includes("confirm")) return { action: "conflict", reason: "earlyStrong" };
  if (strongOnly) sub.stages = ["confirm"];
  return sub;
}

// =====================================================================
// 4. Batas jumlah alarm dan koin
// =====================================================================

/** Dua langganan dianggap sama kalau semua opsinya sama (id / waktu dibuat tidak dihitung). */
function sameSub(a, b) {
  const eq = (x, y) => x.length === y.length && x.every((v) => y.includes(v));
  return a.coin === b.coin && a.tf === b.tf && eq(a.dirs, b.dirs) && !!a.anyDir === !!b.anyDir && eq(a.stages, b.stages) && !!a.strongOnly === !!b.strongOnly;
}

/**
 * Boleh membuat alarm baru?
 * @param {{userJid:string, chat:string, sub:object}[]} existing semua alarm yang sudah ada
 * @returns {"ok"|"exists"|"user"|"chat"}  urutan cek: sama persis dulu, lalu batas per orang, lalu batas per chat
 */
function canCreate(existing, { userJid, chat, sub }, cfg = PA) {
  const mine = existing.filter((x) => x.userJid === userJid && x.chat === chat);
  if (mine.some((x) => sameSub(x.sub, sub))) return "exists";
  if (existing.filter((x) => x.userJid === userJid).length >= cfg.MAX_PER_USER) return "user";
  if (existing.filter((x) => x.chat === chat).length >= cfg.MAX_PER_CHAT) return "chat";
  return "ok";
}

/** Potong daftar koin (mis. watchlist) ke batas. Urutan asli dipertahankan, sisanya dilaporkan (tidak dibuang diam-diam). */
function capCoins(coins, max = PA.MAX_COINS_PER_ALERT) {
  const uniq = [...new Set((coins || []).map((c) => String(c).toUpperCase()))];
  return { used: uniq.slice(0, max), cut: Math.max(0, uniq.length - max) };
}

// =====================================================================
// 5. Teks pesan
// =====================================================================

const EXTRA_LINE_BUILDERS = []; // paket berikutnya: prioritas TF besar, kekuatan tren, Gaussian

/** Baris level: konfirmasi tercapai (tahap konfirmasi) atau syarat konfirmasi (tahap dini), plus level batal. */
function levelLine(lang, ev) {
  const lv = fmtLevel(ev.level, ev.dp);
  const inv = fmtLevel(ev.invalid, ev.dp);
  const cancel = ev.dir === "neutral" ? t(lang, "patalert.cancel.neutral", { level: inv }) : t(lang, `patalert.cancel.${ev.dir}`, { level: inv });
  if (ev.stage === "confirm") return `${t(lang, "patalert.level.done", { level: lv })} | ${cancel}`;
  const need = ev.dir === "neutral" ? t(lang, "patalert.need.neutral", { level: lv }) : t(lang, `patalert.need.${ev.dir}`, { level: lv });
  return `${need} | ${cancel}`;
}

/** Satu blok per kejadian: judul pola, baris level, lalu baris tambahan (kalau ada). */
function buildLine(lang, ev) {
  const label = t(lang, `pola.kind.${ev.variant || ev.kind}`);
  const status = ev.stage === "confirm" ? t(lang, "pola.status.confirmed") : t(lang, "pola.status.candidate");
  const grade = GRADE_KEY[ev.grade] ? t(lang, GRADE_KEY[ev.grade]).toLowerCase() : ev.grade;
  const head = `${ICON[ev.dir] || ICON.neutral} *${ev.coin}* ${TF_LABEL[ev.tf] || ev.tf} ${label} - ${status} - ${grade}`;
  const lines = [head, levelLine(lang, ev)];
  if (ev.momentumAgainst) lines.push(t(lang, "patalert.momAgainst"));
  for (const fn of EXTRA_LINE_BUILDERS) {
    const extra = fn(lang, ev);
    if (extra) lines.push(extra);
  }
  return lines.join("\n");
}

/** TF besar dulu, konfirmasi sebelum dini, arah naik sebelum turun, grade tinggi dulu, lalu koin. */
function sortEvents(events) {
  const tfRank = (tf) => TF_ORDER.indexOf(tf);
  const dirRank = (d) => (d === "up" ? 0 : d === "down" ? 1 : 2);
  return [...events].sort(
    (a, b) =>
      tfRank(a.tf) - tfRank(b.tf) ||
      (STAGE_RANK[a.stage] ?? 9) - (STAGE_RANK[b.stage] ?? 9) ||
      dirRank(a.dir) - dirRank(b.dir) ||
      (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9) ||
      a.coin.localeCompare(b.coin),
  );
}

/** Pecah daftar jadi potongan berisi paling banyak `size` elemen (tidak ada yang dibuang). */
function chunk(list, size = PA.LINES_PER_MSG) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Teks satu pesan alarm. ms = waktu evaluasi. */
function buildPatternText(lang, events, { ms, part = 1, parts = 1, total = events.length }) {
  const blocks = sortEvents(events).map((ev) => buildLine(lang, ev));
  const head = t(lang, "patalert.head", { time: fmtCandleTime(lang, ms), n: total });
  const partTag = parts > 1 ? ` (${part}/${parts})` : "";
  return `${head}${partTag}\n${blocks.join("\n\n")}\n\n${t(lang, "patalert.foot")}`;
}

/** Ringkasan satu langganan untuk !alertpola list / pesan konfirmasi. */
function describePattern(lang, sub) {
  const dirs = sub.anyDir ? t(lang, "patalert.dir.any") : sub.dirs.map((x) => t(lang, `patalert.dir.${x}`)).join(" + ");
  const isDefault = sub.stages.length === DEFAULT_STAGES.length && DEFAULT_STAGES.every((x) => sub.stages.includes(x));
  const stages = isDefault ? t(lang, "patalert.stage.both") : STAGES.filter((x) => sub.stages.includes(x)).map((x) => t(lang, `patalert.stage.${x}`)).join(" + ");
  const extra = sub.strongOnly ? `, ${t(lang, "patalert.strongOnly")}` : "";
  return `${dirs}, ${stages}${extra}`;
}

module.exports = {
  DIRS,
  STAGES,
  DEFAULT_STAGES,
  TF_ORDER,
  EXTRA_LINE_BUILDERS,
  patternId,
  detectEvents,
  withMeta,
  isAfterCreation,
  matchSub,
  patKey,
  parsePatternArgs,
  sameSub,
  canCreate,
  capCoins,
  buildLine,
  buildPatternText,
  sortEvents,
  chunk,
  describePattern,
  DAILY_TZ_LABEL,
};
