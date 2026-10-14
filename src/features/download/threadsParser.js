// =====================================================
// Parser halaman Threads (threads.net / threads.com)
// -----------------------------------------------------
// gallery-dl dan yt-dlp TIDAK punya extractor Threads, jadi thread.js
// ambil HTML halaman postingannya sendiri lalu dibaca di sini.
//
// Halaman Threads menanam data postingan sebagai JSON di dalam
// <script type="application/json" data-sjs>. Struktur tiap postingan
// (field penting): code, pk, user.username, taken_at, caption.text,
// media_type, image_versions2.candidates[], video_versions[],
// carousel_media[] (kalau 1 postingan isinya banyak foto/video campur).
//
// Struktur ini punya Meta dan bisa berubah kapan aja, makanya parser
// jalan dengan cara "cari objek yang bentuknya mirip postingan" di
// seluruh JSON (bukan nyusur path tetap), dan masih ada fallback ke
// meta og:* kalau JSON-nya gak ketemu.
//
// File ini murni (tanpa network / dependency) supaya gampang dites.
// =====================================================

const POST_PATH_RE = /\/@[\w.]+\/post\/([\w-]+)/i;
const SHORT_PATH_RE = /\/t\/([\w-]+)/i;

function getPostCode(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(POST_PATH_RE) || p.match(SHORT_PATH_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractJsonBlobs(html) {
  const blobs = [];
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw || (raw[0] !== "{" && raw[0] !== "[")) continue;
    try {
      blobs.push(JSON.parse(raw));
    } catch {
      // blob rusak / bukan JSON murni -- lewati
    }
  }
  return blobs;
}

function looksLikePost(o) {
  return (
    o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    typeof o.code === "string" &&
    o.code &&
    (o.user || o.owner) &&
    ("caption" in o ||
      "image_versions2" in o ||
      "video_versions" in o ||
      "carousel_media" in o)
  );
}

function collectPosts(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  let guard = 0;

  while (stack.length && guard++ < 500000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (looksLikePost(node)) found.push(node);

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else {
      for (const k of Object.keys(node)) stack.push(node[k]);
    }
  }
  return found;
}

function bestImageUrl(item) {
  const c = item?.image_versions2?.candidates;
  if (Array.isArray(c) && c.length) {
    // ambil resolusi terbesar
    const best = c
      .filter((x) => x && x.url)
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    if (best) return best.url;
  }
  return null;
}

function bestVideoUrl(item) {
  const v = item?.video_versions;
  if (Array.isArray(v) && v.length) {
    const best = v
      .filter((x) => x && x.url)
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
    if (best) return best.url;
  }
  return null;
}

// 1 postingan -> daftar media (video diutamakan kalau 1 item punya
// keduanya, karena image_versions2 di item video cuma thumbnail).
function mediaFromPost(post) {
  const items =
    Array.isArray(post.carousel_media) && post.carousel_media.length
      ? post.carousel_media
      : [post];

  const out = [];
  for (const it of items) {
    const video = bestVideoUrl(it);
    if (video) {
      out.push({ type: "video", url: video });
      continue;
    }
    const image = bestImageUrl(it);
    if (image) out.push({ type: "image", url: image });
  }
  return out;
}

function postInfo(post) {
  const user = post.user || post.owner || {};
  const caption =
    typeof post.caption === "string" ? post.caption : post.caption?.text;

  let date = null;
  if (post.taken_at) {
    const d = new Date(Number(post.taken_at) * 1000);
    if (!Number.isNaN(d.getTime())) date = d.toISOString().slice(0, 16).replace("T", " ");
  }

  return {
    handle: user.username || null,
    date,
    content: typeof caption === "string" ? caption.trim() : "",
  };
}

// Fallback terakhir: meta og:* (cuma 1 postingan, 1 media).
function parseOgFallback(html) {
  const meta = (prop) => {
    const m =
      html.match(
        new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"),
      ) ||
      html.match(
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, "i"),
      );
    return m ? decodeEntities(m[1]) : null;
  };

  const desc = meta("og:description");
  const video = meta("og:video") || meta("og:video:secure_url");
  const image = meta("og:image");

  const posts = desc ? [{ handle: null, date: null, content: desc.trim() }] : [];
  const media = [];
  if (video) media.push({ type: "video", url: video });
  else if (image) media.push({ type: "image", url: image });

  return { posts, media };
}

// Return { posts: [{handle,date,content}], media: [{type,url}] }
// Urutan: postingan thread (penulis yang sama dengan link) dari yang
// terlama; media ikut urutan postingannya.
function parseThreadsHtml(html, url) {
  if (typeof html !== "string" || !html) return { posts: [], media: [] };

  const all = [];
  for (const blob of extractJsonBlobs(html)) all.push(...collectPosts(blob));

  if (all.length === 0) return parseOgFallback(html);

  // dedupe per code, urutan kemunculan dipertahankan
  const byCode = new Map();
  for (const p of all) {
    const prev = byCode.get(p.code);
    // kalau ada duplikat, pilih yang datanya lebih lengkap
    if (!prev || mediaFromPost(p).length > mediaFromPost(prev).length) {
      byCode.set(p.code, p);
    }
  }
  const unique = Array.from(byCode.values());

  const targetCode = getPostCode(url);
  const target = targetCode ? byCode.get(targetCode) : null;
  const author = (target || unique[0])?.user?.username || (target || unique[0])?.owner?.username;

  // Thread = postingan beruntun dari penulis yang sama. Balasan orang
  // lain yang ikut ke-embed di halaman dibuang.
  let mine = author
    ? unique.filter((p) => (p.user?.username || p.owner?.username) === author)
    : unique;
  if (mine.length === 0) mine = unique;

  const order = new Map(unique.map((p, i) => [p.code, i]));
  mine.sort((a, b) => {
    const ta = Number(a.taken_at) || 0;
    const tb = Number(b.taken_at) || 0;
    if (ta && tb && ta !== tb) return ta - tb;
    return order.get(a.code) - order.get(b.code);
  });

  const posts = [];
  const media = [];
  const seenUrl = new Set();
  const seenText = new Set();

  for (const p of mine) {
    const info = postInfo(p);
    if (info.content && !seenText.has(info.content)) {
      seenText.add(info.content);
      posts.push(info);
    }
    for (const m of mediaFromPost(p)) {
      if (seenUrl.has(m.url)) continue;
      seenUrl.add(m.url);
      media.push(m);
    }
  }

  // JSON ketemu tapi kosong -> coba og:* sebelum nyerah
  if (posts.length === 0 && media.length === 0) return parseOgFallback(html);

  return { posts, media };
}

module.exports = { parseThreadsHtml, getPostCode, decodeEntities };