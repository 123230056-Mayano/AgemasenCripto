// =====================================================
// Parser HTML halaman pencarian Tenor. Diadaptasi APA ADANYA dari
// `src/lib/tenor/parser.ts` di proyek TENOR-Scrapper milik user -- 4
// strategi ekstraksi yang sama persis, cuma dipindah dari TypeScript ke
// JavaScript/CommonJS biasa.
// =====================================================
const cheerio = require("cheerio");
const {
  guessMediaTypeFromUrl,
  idFromUrl,
  isValidMediaUrl,
  isValidTenorPageUrl,
} = require("./tenorUtils");

// Kontrak strategi ekstraksi: tiap strategi nyoba narik hasil dari raw HTML
// dan return [] kalau gak nemu apa-apa (gak pernah throw buat kasus "gak
// ketemu" -- cuma error parsing beneran yang boleh throw). Strategi dicoba
// berurutan di parseTenorHtml() supaya kalau markup Tenor berubah, cukup
// nambah/nyesuain satu strategi, gak perlu nulis ulang parser-nya.
function toResult(partial) {
  const { title, pageUrl, mediaUrl, previewUrl, width, height } = partial;
  if (!mediaUrl || !isValidMediaUrl(mediaUrl)) return null;
  if (pageUrl && !isValidTenorPageUrl(pageUrl)) return null;

  const finalPreview = previewUrl && isValidMediaUrl(previewUrl) ? previewUrl : mediaUrl;

  return {
    id: idFromUrl(mediaUrl),
    title: (title || "Tenor GIF").trim().slice(0, 200),
    pageUrl: pageUrl || mediaUrl,
    mediaUrl,
    previewUrl: finalPreview,
    mediaType: guessMediaTypeFromUrl(mediaUrl),
    width: width && width > 0 ? width : 0,
    height: height && height > 0 ? height : 0,
    source: "tenor",
  };
}

// -----------------------------------------------------
// Strategi 1: blok structured data (JSON-LD), kalau Tenor nyertain itu.
// JSON-LD ini permukaan ekstraksi paling stabil karena kontrak SEO yang
// terdokumentasi, bukan markup kebetulan.
// -----------------------------------------------------
function extractFromJsonLd(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        walkJsonLdNode(item, results);
      }
    } catch {
      // blok JSON-LD rusak -- skip, coba script tag berikutnya
    }
  });

  return results;
}

function walkJsonLdNode(node, out) {
  if (!node || typeof node !== "object") return;
  const obj = node;

  const type = obj["@type"];
  const isImageOrVideoObject =
    type === "ImageObject" || type === "VideoObject" || type === "ImageGallery";

  if (isImageOrVideoObject) {
    const contentUrl = typeof obj.contentUrl === "string" ? obj.contentUrl : undefined;
    const thumbnailUrl =
      typeof obj.thumbnailUrl === "string"
        ? obj.thumbnailUrl
        : typeof obj.thumbnail?.url === "string"
          ? obj.thumbnail.url
          : undefined;
    const url = typeof obj.url === "string" ? obj.url : undefined;
    const name = typeof obj.name === "string" ? obj.name : undefined;
    const width = typeof obj.width === "number" ? obj.width : undefined;
    const height = typeof obj.height === "number" ? obj.height : undefined;

    const built = toResult({
      title: name,
      pageUrl: url,
      mediaUrl: contentUrl,
      previewUrl: thumbnailUrl,
      width,
      height,
    });
    if (built) out.push(built);
  }

  // Rekursif ke array/objek nested (mis. itemListElement, associatedMedia)
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      value.forEach((v) => walkJsonLdNode(v, out));
    } else if (value && typeof value === "object") {
      walkJsonLdNode(value, out);
    }
  }
}

// -----------------------------------------------------
// Strategi 2: blob JSON yang di-embed di halaman buat hydration client-side
// (mis. payload __NEXT_DATA__ / gaya Redux). Scan semua inline <script>
// buat JSON lalu cari rekursif objek yang "kayak" entri GIF (ada field
// url-ish + width/height).
// -----------------------------------------------------
function extractFromEmbeddedJson(html) {
  const $ = cheerio.load(html);
  const results = [];

  $("script").each((_, el) => {
    const type = $(el).attr("type");
    if (type && type !== "application/json" && type !== "text/javascript" && type !== "") return;
    const raw = $(el).contents().text();
    if (!raw || raw.length < 20) return;

    // Cuma coba JSON.parse pada script yang KELIHATAN kayak payload JSON
    // murni (diawali { atau [) biar gak nge-run parsing/regex berat ke
    // JS executable sembarangan.
    const trimmed = raw.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;

    try {
      const data = JSON.parse(trimmed);
      findGifLikeObjects(data, results, 0);
    } catch {
      // bukan JSON standalone yang valid -- skip
    }
  });

  return results;
}

function findGifLikeObjects(node, out, depth) {
  if (depth > 8 || !node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) findGifLikeObjects(item, out, depth + 1);
    return;
  }

  const obj = node;
  const candidateUrlKeys = ["gif", "mp4", "webm", "url", "src"];
  let mediaUrl;

  for (const key of candidateUrlKeys) {
    const val = obj[key];
    if (typeof val === "string" && /\.(gif|mp4|webm)(\?|$)/i.test(val)) {
      mediaUrl = val;
      break;
    }
    if (val && typeof val === "object" && typeof val.url === "string") {
      const nested = val.url;
      if (/\.(gif|mp4|webm)(\?|$)/i.test(nested)) {
        mediaUrl = nested;
        break;
      }
    }
  }

  if (mediaUrl) {
    const built = toResult({
      title: typeof obj.title === "string" ? obj.title : undefined,
      pageUrl: typeof obj.itemurl === "string" ? obj.itemurl : typeof obj.url === "string" ? obj.url : undefined,
      mediaUrl,
      width: typeof obj.width === "number" ? obj.width : undefined,
      height: typeof obj.height === "number" ? obj.height : undefined,
    });
    if (built) out.push(built);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") findGifLikeObjects(value, out, depth + 1);
  }
}

// -----------------------------------------------------
// Strategi 3: <meta> tag HTML (Open Graph / Twitter Card), paling kepake
// buat halaman single-result/detail, tapi gapapa dijalanin di halaman
// pencarian juga (gak ngerusak apa-apa kalau gak ketemu).
// -----------------------------------------------------
function extractFromMetaTags(html) {
  const $ = cheerio.load(html);
  const mediaUrl =
    $('meta[property="og:video"]').attr("content") ||
    $('meta[property="og:image"]').attr("content");
  const pageUrl = $('meta[property="og:url"]').attr("content");
  const title = $('meta[property="og:title"]').attr("content");

  const built = toResult({ title, pageUrl, mediaUrl });
  return built ? [built] : [];
}

// -----------------------------------------------------
// Strategi 4: fallback DOM selector. Ini strategi paling rapuh dan SENGAJA
// ditaruh terakhir. Nyari elemen <img>/<video>/<source> yang src/srcset-nya
// nunjuk ke host media Tenor, dipasangin sama <a> ancestor terdekat buat
// page URL-nya.
// -----------------------------------------------------
function extractFromDomSelectors(html) {
  const $ = cheerio.load(html);
  const results = [];

  $("img, video, source").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src") || $el.attr("data-src") || $el.attr("srcset")?.split(" ")[0];
    if (!src || !isValidMediaUrl(src)) return;

    const $link = $el.closest("a");
    const href = $link.attr("href");
    const pageUrl = href
      ? href.startsWith("http")
        ? href
        : `https://tenor.com${href.startsWith("/") ? "" : "/"}${href}`
      : undefined;

    const title = $el.attr("alt") || $link.attr("aria-label") || undefined;
    const width = Number($el.attr("width")) || undefined;
    const height = Number($el.attr("height")) || undefined;

    const built = toResult({ title, pageUrl, mediaUrl: src, width, height });
    if (built) results.push(built);
  });

  return results;
}

const STRATEGIES = [
  extractFromJsonLd,
  extractFromEmbeddedJson,
  extractFromMetaTags,
  extractFromDomSelectors,
];

// Jalanin SEMUA strategi ekstraksi dan gabungin hasilnya, bukan berhenti di
// strategi pertama yang non-kosong. Ini penting di praktiknya: strategi
// kayak JSON-LD sering cuma expose 1-2 item level-halaman (mis. share
// metadata), bukan seluruh grid hasil, jadi kalau cuma andelin itu bisa
// diam-diam motong hasil 20 GIF jadi cuma 1-2. Strategi berikutnya tetap
// jalan walau strategi sebelumnya udah nemu sesuatu.
//
// Urutan tetap penting buat dedup: removeDuplicateResults() (dipanggil di
// tenor.js) nyimpen kemunculan PERTAMA dari sebuah mediaUrl, jadi kalau GIF
// yang sama ketemu lewat lebih dari satu strategi, hasil dari strategi yang
// lebih awal (lebih terstruktur/reliable) yang menang.
function parseTenorHtml(html) {
  const merged = [];
  for (const strategy of STRATEGIES) {
    try {
      merged.push(...strategy(html));
    } catch {
      // satu strategi gagal gak boleh nge-block strategi lainnya
    }
  }
  return merged;
}

module.exports = { parseTenorHtml };
