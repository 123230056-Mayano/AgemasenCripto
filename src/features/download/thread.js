const fs = require("fs");
const { sendVideoOrDocument } = require("./sendVideo");
const axios = require("axios");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { t } = require("../../i18n");
const {
  GALLERYDL_COOKIES_FILE,
  GALLERYDL_INSTAGRAM_USERNAME,
  GALLERYDL_INSTAGRAM_PASSWORD,
  enqueueDownloadJob,
} = require("./ytdlp");
const { runGalleryDl } = require("./gallerydl");
const { parseThreadsHtml } = require("./threadsParser");

// =====================================================
// Fitur: download THREAD ("!dl <link> thread" / "!dlt <link>")
// -----------------------------------------------------
// Thread = rangkaian postingan (X/Twitter thread, Threads/threads.net,
// dst). Hasilnya: SEMUA teks postingan digabung urut (dikirim sebagai
// pesan teks), lalu semua media (foto/video) dikirim satu-satu sesuai
// urutan postingannya.
//
// Pakai gallery-dl (sama kayak jalur foto di gallerydl.js) dengan
// "--write-metadata", jadi tiap file media punya "<file>.json" yang
// isinya teks, penulis, tanggal, id postingan. Opsi "-o text-tweets=true"
// bikin tweet TANPA media tetap ikut diambil (penting buat thread
// yang isinya teks doang), dan "-o conversations=true" bikin gallery-dl
// narik seluruh percakapan dari 1 link tweet. Opsi yang gak dikenal
// extractor situs lain otomatis diabaikan gallery-dl, jadi aman dipakai
// bareng untuk semua situs.
//
// PENGECUALIAN: Threads (Meta). gallery-dl dan yt-dlp sama-sama TIDAK
// punya extractor Threads (semua link threads.net/threads.com ditolak
// "Unsupported URL", di versi terbaru sekalipun), jadi link Threads
// diambil lewat downloadThreadsFromUrl() -- baca HTML halamannya
// langsung (lihat threadsParser.js).
// =====================================================

const THREAD_MAX_MEDIA = 20; // batas jumlah media yang dikirim per thread
const THREAD_MAX_FILESIZE = "95M"; // sama kayak batas !dl biasa
const THREAD_TEXT_CHUNK = 3500; // batas aman panjang 1 pesan teks WhatsApp

const IMAGE_RE = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

// Link Threads (Meta) otomatis diperlakukan sebagai thread oleh "!dl".
function isThreadsUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)threads\.(net|com)$/.test(host);
  } catch {
    return false;
  }
}

// Link "Bagikan" Threads (threads.com/share/XXXX) itu link pendek yang
// gak dikenal gallery-dl ("Unsupported URL") -- harus diubah dulu ke link
// asli (/@user/post/KODE). Cara: ikuti redirect-nya; kalau redirect gak
// ngasih link asli, cari link post di HTML-nya (canonical/og:url).
// Gagal resolve = return URL asli apa adanya (biar pesan error tetap
// jujur, bukan crash).
const THREADS_POST_PATH_RE = /\/@[\w.]+\/post\/[\w-]+/;

async function resolveThreadsShareUrl(url) {
  if (!isThreadsUrl(url)) return url;

  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }
  if (!/^\/share\//i.test(pathname)) return url;

  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 15000,
      responseType: "text",
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const finalUrl = res.request?.res?.responseUrl || res.config?.url || "";
    if (THREADS_POST_PATH_RE.test(finalUrl)) return finalUrl;

    const html = typeof res.data === "string" ? res.data : "";
    const m =
      html.match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      ) || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (m && THREADS_POST_PATH_RE.test(m[1])) return m[1];
  } catch (err) {
    console.log("[dl][thread] gagal resolve link share:", err.message || err);
  }

  return url;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// Metadata gallery-dl beda-beda tiap situs, jadi baca beberapa kemungkinan
// nama field -- yang gak ada ya dilewati.
function extractPostInfo(meta) {
  if (!meta || typeof meta !== "object") return {};

  const id = pick(meta, ["tweet_id", "post_id", "id", "code"]);
  const content = pick(meta, ["content", "text", "caption", "description"]);

  const authorObj = meta.author || meta.user || {};
  const handle =
    pick(authorObj, ["name", "username"]) || pick(meta, ["username"]);

  let date = pick(meta, ["date", "created_at"]);
  if (date && typeof date !== "string") date = String(date);

  return {
    id: id !== null ? String(id) : null,
    content: typeof content === "string" ? content.trim() : null,
    handle: handle ? String(handle) : null,
    date,
  };
}

function compareIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return 0;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function buildGalleryDlArgs(jobDir, url) {
  const args = [
    "-D",
    jobDir,
    "--no-mtime",
    "--write-metadata",
    "--filesize-max",
    THREAD_MAX_FILESIZE,
    "-o",
    "text-tweets=true",
    "-o",
    "conversations=true",
  ];

  if (GALLERYDL_COOKIES_FILE) {
    args.push("--cookies", GALLERYDL_COOKIES_FILE);
  } else if (GALLERYDL_INSTAGRAM_USERNAME && GALLERYDL_INSTAGRAM_PASSWORD) {
    args.push(
      "--username",
      GALLERYDL_INSTAGRAM_USERNAME,
      "--password",
      GALLERYDL_INSTAGRAM_PASSWORD,
    );
  }

  args.push(url);
  return args;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Crawler preview Meta -- kadang dapat HTML yang lebih lengkap tanpa login wall.
const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

async function fetchThreadsHtml(url, userAgent) {
  const res = await axios.get(url, {
    maxRedirects: 5,
    timeout: 20000,
    responseType: "text",
    validateStatus: () => true,
    headers: {
      "User-Agent": userAgent,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return { status: res.status, html: typeof res.data === "string" ? res.data : "" };
}

// Return { posts, media: [{type, buffer}], totalMedia } -- bentuk sama
// dengan downloadThreadFromUrl versi gallery-dl.
async function downloadThreadsFromUrl(url) {
  // buang query tracking (?xmt=...&slof=1) -- gak ngubah isi postingan
  let clean = url;
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    clean = u.toString();
  } catch {
    // biarin url apa adanya
  }

  let parsed = { posts: [], media: [] };
  let lastStatus = 0;

  for (const ua of [BROWSER_UA, CRAWLER_UA]) {
    const { status, html } = await fetchThreadsHtml(clean, ua);
    lastStatus = status;
    if (status >= 400 && !html) continue;
    parsed = parseThreadsHtml(html, clean);
    if (parsed.posts.length > 0 || parsed.media.length > 0) break;
  }

  if (parsed.posts.length === 0 && parsed.media.length === 0) {
    if (lastStatus === 401 || lastStatus === 403) {
      throw new Error(`Threads minta login (HTTP ${lastStatus}) -- login required`);
    }
    if (lastStatus === 404) {
      throw new Error("Threads: postingan tidak ada (404) -- post not found");
    }
    if (lastStatus === 429) {
      throw new Error("Threads: 429 rate limit");
    }
    throw new Error("Tidak ada isi thread yang bisa diunduh.");
  }

  const wanted = parsed.media.slice(0, THREAD_MAX_MEDIA);
  const media = [];
  for (const m of wanted) {
    try {
      const res = await axios.get(m.url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: 95 * 1024 * 1024,
        maxBodyLength: 95 * 1024 * 1024,
        headers: { "User-Agent": BROWSER_UA },
      });
      media.push({ type: m.type, buffer: Buffer.from(res.data) });
    } catch (err) {
      // 1 media gagal/kegedean jangan bikin seluruh thread gagal
      console.log("[dl][thread][threads] media gagal diunduh:", err.message || err);
    }
  }

  if (parsed.posts.length === 0 && media.length === 0) {
    throw new Error("Tidak ada isi thread yang bisa diunduh.");
  }

  return { posts: parsed.posts, media, totalMedia: parsed.media.length };
}

// Return { posts: [{handle,date,content}], media: [{type, buffer}] }
async function downloadThreadFromUrl(url) {
  // Threads gak didukung gallery-dl -- jalur sendiri.
  if (isThreadsUrl(url)) return downloadThreadsFromUrl(url);

  const uid = crypto.randomBytes(6).toString("hex");
  const jobDir = path.join(os.tmpdir(), `dlthread-${uid}`);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    let runError = null;
    try {
      await runGalleryDl(buildGalleryDlArgs(jobDir, url));
    } catch (err) {
      // gallery-dl keluar dengan kode non-0 walau SEBAGIAN postingan
      // berhasil diambil (mis. 1 media kegedean/gagal). Jangan langsung
      // nyerah -- cek dulu apakah ada hasil di folder.
      runError = err;
    }

    const allFiles = fs.readdirSync(jobDir).sort();
    const postsById = new Map(); // key -> { info, files: [] }
    const order = []; // urutan kemunculan key (fallback kalau id bukan angka)

    for (const f of allFiles) {
      if (f.endsWith(".json")) continue;

      const metaFile = path.join(jobDir, f + ".json");
      const info = fs.existsSync(metaFile)
        ? extractPostInfo(readJsonSafe(metaFile))
        : {};

      const key = info.id || `file:${f}`;
      if (!postsById.has(key)) {
        postsById.set(key, { info, files: [] });
        order.push(key);
      }
      const entry = postsById.get(key);
      if (!entry.info.content && info.content) entry.info = info;
      if (IMAGE_RE.test(f) || VIDEO_RE.test(f)) entry.files.push(f);
    }

    const keys = order.slice().sort((a, b) => {
      const ia = postsById.get(a).info.id;
      const ib = postsById.get(b).info.id;
      if (ia && ib) return compareIds(ia, ib);
      return order.indexOf(a) - order.indexOf(b);
    });

    const posts = [];
    const seenText = new Set();
    const mediaFiles = [];

    for (const key of keys) {
      const { info, files } = postsById.get(key);
      if (info.content && !seenText.has(info.content)) {
        seenText.add(info.content);
        posts.push({
          handle: info.handle,
          date: info.date,
          content: info.content,
        });
      }
      for (const f of files) mediaFiles.push(f);
    }

    if (posts.length === 0 && mediaFiles.length === 0) {
      throw runError || new Error("Tidak ada isi thread yang bisa diunduh.");
    }

    const media = mediaFiles.slice(0, THREAD_MAX_MEDIA).map((f) => ({
      type: VIDEO_RE.test(f) ? "video" : "image",
      buffer: fs.readFileSync(path.join(jobDir, f)),
    }));

    return { posts, media, totalMedia: mediaFiles.length };
  } finally {
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  }
}

function formatPost(p, index, total) {
  const head = [`*${index}/${total}*`];
  if (p.handle) head.push(`@${p.handle.replace(/^@/, "")}`);
  if (p.date) head.push(`_${p.date}_`);
  return `${head.join(" · ")}\n${p.content}`;
}

// Gabungin teks tiap postingan jadi beberapa pesan <= THREAD_TEXT_CHUNK,
// tanpa motong di tengah satu postingan (kecuali 1 postingan sendiri
// kepanjangan).
function chunkPosts(posts) {
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  posts.forEach((p, i) => {
    let block = formatPost(p, i + 1, posts.length);

    while (block.length > THREAD_TEXT_CHUNK) {
      flush();
      chunks.push(block.slice(0, THREAD_TEXT_CHUNK));
      block = block.slice(THREAD_TEXT_CHUNK);
    }

    if (current && current.length + block.length + 2 > THREAD_TEXT_CHUNK) {
      flush();
    }
    current = current ? `${current}\n\n${block}` : block;
  });

  flush();
  return chunks;
}

// Ambil alasan gagal yang singkat & bisa dibaca dari error gallery-dl, buat
// ditampilin ke user (log lengkapnya tetap di console server).
function describeThreadError(err) {
  const raw = String(err?.stderr || err?.message || "").trim();
  if (!raw) return "unknown";

  if (/Unsupported URL/i.test(raw)) {
    return "link tidak dikenali gallery-dl (Unsupported URL) / not recognized by gallery-dl";
  }
  if (/tidak ditemukan di server|ENOENT/i.test(raw)) {
    return "gallery-dl not installed on the server";
  }
  if (/login required|minta login/i.test(raw)) {
    return "Threads minta login / Threads requires login for this post";
  }
  if (/login|cookies|401|403|authentication|checkpoint/i.test(raw)) {
    return "perlu login/cookies / login or cookies required";
  }
  if (/404|not found|NotFound|deleted/i.test(raw)) {
    return "postingan tidak ada / post not found";
  }
  if (/429|rate.?limit|too many/i.test(raw)) {
    return "rate limit";
  }
  if (/Tidak ada isi thread/i.test(raw)) {
    return "tidak ada teks/media yang terambil / nothing could be extracted";
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || raw).slice(0, 200);
}

// "!dl <link> thread" / "!dlt <link>" / link threads.net
async function handleDlThread(sock, jid, url, quotedMsg, lang) {
  try {
    await sock.sendMessage(jid, { text: t(lang, "dl.threadWait") });

    const { posts, media, totalMedia } = await enqueueDownloadJob(() =>
      downloadThreadFromUrl(url),
    );

    let first = true;
    const quoteOpt = () => {
      if (first && quotedMsg) {
        first = false;
        return { quoted: quotedMsg };
      }
      first = false;
      return undefined;
    };

    for (const chunk of chunkPosts(posts)) {
      await sock.sendMessage(jid, { text: chunk }, quoteOpt());
    }

    for (const m of media) {
      if (m.type === "video") {
        await sendVideoOrDocument(sock, jid, m.buffer, quoteOpt());
      } else {
        await sock.sendMessage(jid, { image: m.buffer }, quoteOpt());
      }
    }

    if (totalMedia > media.length) {
      await sock.sendMessage(jid, {
        text: t(lang, "dl.threadTruncated", {
          sent: media.length,
          total: totalMedia,
        }),
      });
    }
  } catch (err) {
    console.log("=== [dl][thread] gagal ===");
    console.log(err.message || err);
    console.log("==========================");
    await sock.sendMessage(jid, {
      text: t(lang, "dl.threadFail", { detail: describeThreadError(err) }),
    });
  }
}

module.exports = {
  isThreadsUrl,
  resolveThreadsShareUrl,
  downloadThreadFromUrl,
  downloadThreadsFromUrl,
  handleDlThread,
};