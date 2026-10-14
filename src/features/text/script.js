// Deteksi jenis tulisan (RTL / kompleks) + pemecahan teks per "grapheme".

// Arab, Ibrani, Syriac, Thaana, NKo, dst + Presentation Forms.
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
// Huruf kuat LTR (Latin, CJK, dll) -- dipakai buat nentuin arah paragraf.
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u058F\u0900-\u1FFF\u3040-\u9FFF\uAC00-\uD7AF]/;

function hasRTL(text) {
  return RTL_CHAR.test(String(text || ""));
}

// Arah paragraf = arah karakter "kuat" PERTAMA (aturan Unicode bidi).
// "مرحبا hello" -> rtl, "hello مرحبا" -> ltr.
function isRTLText(text) {
  for (const ch of String(text || "")) {
    if (RTL_CHAR.test(ch)) return true;
    if (STRONG_LTR.test(ch)) return false;
  }
  return false;
}

// Skrip yang hurufnya saling menyambung/bergeser (Arab, Devanagari, Thai...).
// Letter-spacing (apalagi negatif) MERUSAK tulisan ini -> harus 0.
const COMPLEX_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u0900-\u0DFF\u0E00-\u0EFF]/;
function hasComplexScript(text) {
  return COMPLEX_SCRIPT.test(String(text || ""));
}

// Pecah jadi grapheme cluster (huruf + tanda baris/harakat/jamo tetap utuh).
// Array.from() memecah per code point -> harakat Arab & Hangul jamo terlepas.
const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
function graphemes(text) {
  const s = String(text || "");
  if (!segmenter) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

// Canvas ini (@napi-rs/canvas) MENGABAIKAN ctx.direction -- arah dasar selalu
// kiri-ke-kanan. Akibatnya kalimat Arab yang berisi kata Latin/angka urutannya
// salah. Pembungkus RLI...PDI (isolate kanan-ke-kiri) memaksa arah dasar RTL
// untuk teks itu, dan lebarnya 0 (tidak mengubah hasil measureText).
function bidiWrap(text, rtl = isRTLText(text)) {
  return rtl ? "\u2067" + text + "\u2069" : text;
}

// Urutan kata dari KIRI ke KANAN secara visual untuk 1 baris yang kata-katanya
// sudah dipecah dalam urutan logis. Kata Arab/Ibrani berurutan dianggap 1 blok
// yang dibalik; blok Latin/CJK/angka tetap urutan normal.
function visualWordOrder(words, baseRTL) {
  const isR = words.map((w) => hasRTL(w));
  // kelompokkan jadi blok (run) berdasarkan kelas R/L
  const runs = [];
  words.forEach((_, i) => {
    const last = runs[runs.length - 1];
    if (last && last.r === isR[i]) last.idx.push(i);
    else runs.push({ r: isR[i], idx: [i] });
  });
  // blok R dibalik urutan katanya
  const placed = runs.map((run) => (run.r ? [...run.idx].reverse() : run.idx));
  // baris berbasis RTL: urutan blok juga dibalik
  const ordered = baseRTL ? placed.reverse() : placed;
  return ordered.flat();
}

module.exports = { hasRTL, isRTLText, hasComplexScript, graphemes, bidiWrap, visualWordOrder };
