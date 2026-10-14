// Port dari lib/names.ts (UMA-API-TESTER) + helper ranking hasil pencarian.
// API uma.moe mencocokkan nama secara harfiah, sedangkan nama trainer sering
// pakai tanda baca fullwidth (［HCM］, A．Z．A．N) -> dicoba beberapa varian.
const PUNCT = /[!-/:-@[-`{-~ ]/g;
const full = (c) => (c === " " ? "\u3000" : String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const BRACKETS = /[[\](){}<>［］（）｛｝＜＞「」『』【】]/g;

function nameVariants(q) {
  const base = q.normalize("NFKC");
  const types = Array.from(new Set(base.match(PUNCT) || []));
  const out = [q];
  const build = (mask) =>
    base.replace(PUNCT, (c) => (mask & (1 << types.indexOf(c)) ? full(c) : c));
  if (types.length > 0 && types.length <= 3) {
    const all = (1 << types.length) - 1;
    out.push(build(all), build(0));
    for (let m = 1; m < all; m++) out.push(build(m));
  } else if (types.length > 3) {
    out.push(base.replace(PUNCT, full), base);
  } else {
    out.push(base);
  }
  out.push(base.replace(BRACKETS, "").trim());
  return Array.from(new Set(out)).filter(Boolean);
}

// Keyword pendek tanpa tanda baca (mis. "azan") juga dicari dalam bentuk
// "a.z.a.n" / "a．z．a．n", supaya nama bergaya titik-titik ikut muncul.
// Kalau API ternyata case-sensitive, tambahkan varian upper/lower di sini.
function buildQueries(q) {
  const list = [q];
  if (/^[\p{L}\p{N}]{2,8}$/u.test(q)) {
    const chars = Array.from(q);
    list.push(chars.join("."), chars.join("．"));
  }
  return Array.from(new Set(list));
}

// "[HCM] A．Z．A．N" -> "hcmazan" (huruf/angka saja, huruf kecil)
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// Skor kemiripan: makin kecil makin mirip.
function matchScore(name, query) {
  const n = norm(name);
  const q = norm(query);
  if (!q) return 9;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  // urutan huruf cocok walau terselip karakter lain
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 3 : 4;
}

module.exports = { nameVariants, buildQueries, matchScore, norm };
