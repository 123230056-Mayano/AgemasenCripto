const { fetchWithRetry } = require("../booru/safebooru");

// =====================================================
// Fitur: Cari ilustrasi di Pixiv berdasarkan keyword ("!pixiv")
// -----------------------------------------------------
// Pixiv gak punya API publik resmi, jadi ini pakai endpoint /ajax/ yang
// dipakai situs pixiv.net sendiri (sama seperti proyek pixiv-safe-search).
// Bukan API berdokumen -- bisa berubah / diblokir kapan saja.
//
// Alurnya SENGAJA sama dengan !pin (lihat features/pinterest/pinterest.js)
// supaya numpang mekanisme session / "!next" / kode sesi / "#N" yang sudah
// ada. Bedanya: Pinterest paging pakai "bookmark", Pixiv pakai nomor
// halaman (`page`).
//
// KEAMANAN (bot ini dipakai di grup, jadi berlapis):
//  1. Keyword dewasa ditolak sebelum request (isQueryBlocked).
//  2. Request ke Pixiv SELALU mode=safe (dipaksa di sini).
//  3. Hasil dibuang kalau xRestrict != 0, sanity level > 2, atau tag masuk
//     daftar blokir (isItemSafe).
//
// FILTER AI (default AKTIF, supaya hasil bersih dari gambar AI-generated):
//  a. Request ke Pixiv dikirim dengan ai_type=1 (Pixiv sendiri yang
//     menyembunyikan karya AI -- sama seperti toggle "Hide AI-generated
//     works" di situs).
//  b. Cadangan: item dibuang kalau aiType === 2 (ditandai AI oleh Pixiv)
//     atau tag-nya mengandung penanda AI (isAiItem). Perlu karena
//     sebagian karya AI lolos dari flag Pixiv (belum diberi label).
//  Matikan lewat env var PIXIV_HIDE_AI=0 kalau suatu saat mau hasil AI.
// =====================================================
const PIXIV_TIMEOUT_MS = 15000;
const PIXIV_PER_PAGE = 60;
// Batas halaman Pixiv yang boleh di-paging per pencarian.
const PIXIV_MAX_PAGE = 20;
// Batas berapa halaman yang dicoba SEKALI PANGGILAN kalau hasilnya habis
// kefilter (sudah pernah dikirim / tidak aman) supaya tidak nyangkut lama.
const PIXIV_MAX_PAGES_PER_CALL = 5;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------- Aturan keamanan ----------

// Keyword latin: dicocokkan sebagai KATA UTUH (boleh akhiran "s"), supaya
// "hero"/"zero" tidak ikut terblokir gara-gara mengandung "ero".
const BLOCKED_QUERY_LATIN = [
  "r-18", "r18", "r-18g", "r18g", "nsfw", "porn", "hentai", "nude", "naked",
  "nipple", "sex", "sexy", "lewd", "ecchi", "erotic", "ero", "guro", "gore",
];
// Keyword CJK: tidak ada spasi antar kata, jadi cukup cek "mengandung".
const BLOCKED_QUERY_CJK = [
  "18禁", "エロ", "えろ", "裸", "全裸", "ヌード", "おっぱい", "乳首", "セックス",
  "グロ", "下着", "パンツ", "触手",
];

// Tag pada hasil yang disaring walau sudah lolos mode=safe dari Pixiv.
const BLOCKED_TAGS = [
  "r-18", "r-18g", "r18", "nsfw", "porn", "hentai", "nude", "naked",
  "nipples", "lewd", "ecchi", "erotic", "18禁", "エロ", "えろ", "裸",
  "全裸", "ヌード", "おっぱい", "乳首", "下着", "パンツ", "触手", "セックス",
  "グロ", "guro", "gore",
];

// Pixiv "sanity level": 2 = aman, 4 = meragukan, 6 = dewasa.
const MAX_SANITY_LEVEL = 2;

// ---------- Filter karya AI ----------

// Default aktif. Isi PIXIV_HIDE_AI dengan 0 / false / off / no untuk mematikan.
const HIDE_AI = !/^(0|false|off|no)$/i.test(
  String(process.env.PIXIV_HIDE_AI ?? "1").trim(),
);

// Tag penanda karya AI. Dicocokkan sebagai "mengandung" (lowercase).
const AI_TAGS = [
  "ai生成", "aiイラスト", "aiart", "ai art", "ai-generated", "aigenerated",
  "ai generated", "ai画像", "aiエロ", "novelai", "stablediffusion",
  "stable diffusion", "midjourney", "niji journey", "nijijourney",
  "dall-e", "dalle", "comfyui", "webui", "autismmix", "pony diffusion",
  "ponydiffusion", "sdxl", "illustrious", "nai diffusion", "naifu",
  "ai-generated-art", "ai生成イラスト", "ai제작", "ai그림", "ai绘图", "ai绘画",
  "ai生成图片",
];

// Tag pendek yang harus SAMA PERSIS (bukan "mengandung"), supaya tag biasa
// seperti "rain" / "maid" tidak ikut kena.
const AI_TAGS_EXACT = new Set([
  "ai", "ai-assisted", "ai assisted", "aiassisted", "ai補助", "ai補完",
  "ai加工", "ai-generated", "ai generated", "nai", "nai3", "nai4", "naiv3",
  "sd", "sdxl", "flux", "lora", "aigc", "bing image creator",
  "bingimagecreator", "adobe firefly", "firefly", "leonardo ai", "leonardoai",
  "ai创作", "ai創作", "ai繪圖", "ai图", "ai圖",
]);

// Pixiv baru punya label "AI-generated" sejak akhir Oktober 2022. Karya
// aiType 0 ("belum diset") yang dibuat SEBELUM tanggal ini aman (era
// pra-AI). Yang dibuat SESUDAHNYA tapi masih 0 dianggap mencurigakan.
const AI_FLAG_START = Date.parse("2022-11-01T00:00:00+09:00");

function isAiItem(item) {
  const aiType = Number(item?.aiType);

  // aiType: 0 = belum diset, 1 = bukan AI, 2 = AI-generated.
  if (aiType === 2) return true;

  // Mode ketat: karya baru (setelah label AI ada) yang TIDAK dilabeli 1
  // dibuang. Kalau Pixiv tidak mengirim field aiType sama sekali, bagian
  // ini dilewati (supaya hasil tidak kosong semua) dan tag yang jadi andalan.
  if (item && item.aiType !== undefined && item.aiType !== null && aiType !== 1) {
    const created = Date.parse(item.createDate || "");
    if (Number.isNaN(created) || created >= AI_FLAG_START) return true;
  }

  const tags = (item?.tags || []).map((t) => String(t).toLowerCase().trim());
  return tags.some(
    (t) => AI_TAGS_EXACT.has(t) || AI_TAGS.some((a) => t.includes(a)),
  );
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LATIN_QUERY_REGEXES = BLOCKED_QUERY_LATIN.map(
  (w) => new RegExp(`(^|[^a-z0-9])${escapeRegex(w)}s?([^a-z0-9]|$)`),
);

function isQueryBlocked(q) {
  const s = String(q || "").toLowerCase();
  if (LATIN_QUERY_REGEXES.some((re) => re.test(s))) return true;
  return BLOCKED_QUERY_CJK.some((w) => s.includes(w));
}

function isItemSafe(item) {
  if (!item || !item.id || !item.url) return false; // iklan / data rusak
  if (item.xRestrict !== 0) return false; // 0 = bukan R-18/R-18G
  if ((item.sl ?? 0) > MAX_SANITY_LEVEL) return false;
  const tags = (item.tags || []).map((t) => String(t).toLowerCase());
  if (HIDE_AI && isAiItem(item)) return false;
  return !tags.some((t) => BLOCKED_TAGS.some((b) => t.includes(b)));
}

// ---------- Fetch ----------

// Thumbnail dari hasil pencarian itu kecil (250x250). Ubah ke versi
// "master1200" (sisi terpanjang 1200px) supaya gambar yang dikirim ke
// WhatsApp jelas:
//   /c/250x250_80_a2/img-master/.../123_p0_square1200.jpg
//   /c/250x250_80_a2/custom-thumb/.../123_p0_custom1200.jpg
//     -> /img-master/.../123_p0_master1200.jpg
function toMasterUrl(thumbUrl) {
  return String(thumbUrl)
    .replace(/\/c\/[^/]+\/(?:img-master|custom-thumb)\//, "/img-master/")
    .replace(/_(?:square|custom)1200\./, "_master1200.");
}

// Ambil satu halaman hasil pencarian Pixiv. `page` mulai dari 1.
// Return { pins, total, rawCount }; `rawCount` = jumlah item mentah dari
// Pixiv SEBELUM difilter (0 berarti halaman kosong = sudah habis).
async function fetchPixivPage(query, page) {
  const word = encodeURIComponent(query);
  const params = {
    word: query,
    order: "date_d",
    mode: "safe", // SELALU safe, dipaksa di sini
    p: page,
    s_mode: "s_tag",
    type: "all",
    lang: "en",
  };
  if (HIDE_AI) params.ai_type = 1; // 1 = sembunyikan karya AI-generated
  const res = await fetchWithRetry(
    `https://www.pixiv.net/ajax/search/artworks/${word}`,
    {
      params,
      headers: {
        "User-Agent": UA,
        Referer: "https://www.pixiv.net/",
        Accept: "application/json",
      },
      timeout: PIXIV_TIMEOUT_MS,
    },
  );

  const body = res.data?.body || {};
  const block = body.illustManga ?? body.illust ?? {};
  const raw = Array.isArray(block.data) ? block.data : [];
  const total = block.total ?? 0;

  const pins = raw.filter(isItemSafe).map((it) => ({
    id: String(it.id),
    file_url: toMasterUrl(it.url),
    width: it.width,
    height: it.height,
    title: it.title || "",
    user: it.userName || "",
    pages: it.pageCount ?? 1,
    source_link: `https://www.pixiv.net/en/artworks/${it.id}`,
  }));

  return { pins, total, rawCount: raw.length };
}

// ---------- Session (dipakai bareng !next / kode sesi / #N) ----------

// Session baru untuk keyword Pixiv baru. pool masih kosong -- caller wajib
// panggil loadMorePixivCandidates() dulu sebelum kirim gambar pertama.
function newPixivSession(query) {
  return {
    source: "pixiv",
    tag: query,
    pool: [],
    seenIds: new Set(),
    page: 0, // halaman terakhir yang sudah di-load
    noMore: false,
  };
}

// Isi ulang `session.pool` dengan karya BARU (belum pernah dikirim di
// session ini). Return true kalau pool terisi, false kalau sudah habis /
// tidak ada hasil aman sama sekali.
async function loadMorePixivCandidates(session) {
  let pagesTried = 0;

  while (!session.noMore && pagesTried < PIXIV_MAX_PAGES_PER_CALL) {
    pagesTried++;
    const nextPage = session.page + 1;

    const { pins, total, rawCount } = await fetchPixivPage(
      session.tag,
      nextPage,
    );

    session.page = nextPage;
    if (
      rawCount === 0 ||
      nextPage >= PIXIV_MAX_PAGE ||
      nextPage * PIXIV_PER_PAGE >= total
    ) {
      session.noMore = true;
    }

    const inPool = new Set(session.pool.map((p) => String(p.id)));
    const fresh = pins.filter(
      (p) => !session.seenIds.has(p.id) && !inPool.has(p.id),
    );
    if (fresh.length > 0) {
      session.pool.push(...fresh);
      return true;
    }
  }

  return false;
}

// Dipanggil refillPool() di router kalau semua halaman sudah habis dilihat:
// mulai siklus dari awal.
function resetPixivSession(session) {
  session.page = 0;
  session.noMore = false;
}

module.exports = {
  PIXIV_TIMEOUT_MS,
  UA,
  isQueryBlocked,
  isItemSafe,
  isAiItem,
  HIDE_AI,
  toMasterUrl,
  fetchPixivPage,
  newPixivSession,
  loadMorePixivCandidates,
  resetPixivSession,
};