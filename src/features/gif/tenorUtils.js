// =====================================================
// Utilitas buat provider GIF Tenor versi SCRAPING (bukan Tenor API v2 pakai
// API key lagi). Diadaptasi APA ADANYA dari `src/lib/tenor/utils.ts` di
// proyek TENOR-Scrapper milik user -- cuma dipindah dari TypeScript ke
// JavaScript/CommonJS biasa (supaya konsisten sama sisa file bot ini),
// TANPA ada perubahan logic normalisasi/validasi/dedup-nya sama sekali.
// =====================================================

// Domain yang beneran dipakai Tenor buat serve media, sesuai observasi di
// halaman publik Tenor sendiri. Cuma URL yang (a) cocok whitelist ini DAN
// (b) memang hasil ekstraksi dari halaman Tenor yang kita fetch sendiri
// yang dipercaya -- gak pernah nerima URL "media" sembarangan dari luar.
const ALLOWED_MEDIA_HOSTS = [
  "media.tenor.com",
  "media1.tenor.com",
  "media2.tenor.com",
  "media3.tenor.com",
  "media4.tenor.com",
  "c.tenor.com",
  "tenor.com",
];

function ipToInt(ip) {
  const parts = ip.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipRange(start, end) {
  return [ipToInt(start), ipToInt(end)];
}

const PRIVATE_IPV4_RANGES = [
  ipRange("0.0.0.0", "0.255.255.255"),
  ipRange("10.0.0.0", "10.255.255.255"),
  ipRange("100.64.0.0", "100.127.255.255"), // CGNAT
  ipRange("127.0.0.0", "127.255.255.255"), // loopback
  ipRange("169.254.0.0", "169.254.255.255"), // link-local (termasuk cloud metadata)
  ipRange("172.16.0.0", "172.31.255.255"),
  ipRange("192.0.0.0", "192.0.0.255"),
  ipRange("192.168.0.0", "192.168.255.255"),
  ipRange("198.18.0.0", "198.19.255.255"),
  ipRange("224.0.0.0", "255.255.255.255"), // multicast/reserved
];

function isPrivateOrLoopbackIPv4(host) {
  const value = ipToInt(host);
  if (value === null) return false;
  return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isLikelyPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (h === "::1" || h.startsWith("[::1]")) return true;
  if (h.startsWith("[")) return true; // tolak literal IPv6 mentah -- gak dibutuhkan buat media Tenor
  if (isPrivateOrLoopbackIPv4(h)) return true;
  return false;
}

// Normalisasi raw keyword: trim, rapatin whitespace ganda, lowercase (buat
// dipakai sbg bagian dari URL pencarian), sekalian batasin panjang/karakter
// yang wajar. Gak pernah throw -- return null kalau invalid, biar caller
// yang mutusin mau ngelempar error jenis apa.
function normalizeQuery(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.length > 100) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

// Bangun URL halaman pencarian publik Tenor buat sebuah keyword, dengan
// encoding yang aman (gak pernah interpolasi raw user input mentah-mentah).
function buildTenorSearchUrl(query) {
  return `https://tenor.com/search/${encodeURIComponent(query).replace(/%20/g, "-")}`;
}

// Validasi kalau kandidat URL media aman dipakai & memang berasal dari
// domain yang beneran di-serve Tenor. Ini satu-satunya gerbang anti-SSRF:
// nolak scheme selain https, IP privat/localhost, dan host di luar
// whitelist media Tenor.
function isValidMediaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (isLikelyPrivateHostname(parsed.hostname)) return false;

  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_MEDIA_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
  if (!isAllowed) return false;

  return true;
}

// Sama kayak isValidMediaUrl tapi buat URL halaman ("page URL", halaman
// tenor.com/view/... dari sebuah GIF) -- selalu di tenor.com.
function isValidTenorPageUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "tenor.com" || parsed.hostname.endsWith(".tenor.com"))
    );
  } catch {
    return false;
  }
}

function guessMediaTypeFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "unknown";
}

// Buang hasil duplikat berdasarkan mediaUrl (fallback ke pageUrl), simpan
// kemunculan pertama.
function removeDuplicateResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = r.mediaUrl || r.pageUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Generator id stabil sederhana turunan dari URL, gak butuh dependency luar.
function idFromUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

module.exports = {
  normalizeQuery,
  buildTenorSearchUrl,
  isValidMediaUrl,
  isValidTenorPageUrl,
  guessMediaTypeFromUrl,
  removeDuplicateResults,
  idFromUrl,
};
