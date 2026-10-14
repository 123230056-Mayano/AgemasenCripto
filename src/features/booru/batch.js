const {
  sessionLabel,
  loadMoreCandidates,
  searchAndSendImage,
  pickRandom,
  downloadImage,
} = require("./safebooru");
const { loadMorePinterestCandidates } = require("../pinterest/pinterest");
const { loadMorePixivCandidates } = require("../pixiv/pixiv");
const { sessions, touchSession, assignSessionCode } = require("./sessionStore");
const { t } = require("../../i18n");
const { createZip, detectImageExt } = require("../../utils/zip");
const { sanitizeFilename } = require("../../utils/filename");

// =====================================================
// Jumlah gambar per pencarian: "!img special week #8", "!pin kucing #5"
// -----------------------------------------------------
// - "#N" harus di AKHIR teks dan dipisah spasi dari kata sebelumnya.
// - Tanpa "#N" -> 1 gambar (perilaku lama, tidak berubah sama sekali).
// - Dibatasi BATCH_MAX (default 100, ubah lewat env IMG_BATCH_MAX) supaya
//   bot tidak spam chat & nomor WA tidak gampang kena limit/ban.
// =====================================================
const BATCH_MAX = Math.max(1, parseInt(process.env.IMG_BATCH_MAX, 10) || 100);

// Kalau jumlah gambar yang berhasil didapat >= ZIP_MIN, hasilnya TIDAK dikirim
// satu-satu, tapi dibungkus jadi 1 file .zip (nama: "<keyword> <jumlah>.zip",
// contoh "special week 10.zip"). Ubah lewat env IMG_ZIP_MIN. Isi 0 untuk
// mematikan fitur zip.
const ZIP_MIN_RAW = parseInt(process.env.IMG_ZIP_MIN, 10);
const ZIP_MIN = Number.isFinite(ZIP_MIN_RAW) ? ZIP_MIN_RAW : 10;

// Berapa gambar di-download barengan (kirimnya tetap berurutan).
const DOWNLOAD_CONCURRENCY = 3;

// Jeda antar pesan supaya tidak terlalu agresif ke WhatsApp.
const SEND_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pisahkan "#N" di ujung teks.
//   "special week #12" -> { rest: "special week", count: 12, clamped: false }
//   (kalau melebihi BATCH_MAX -> count = BATCH_MAX, clamped = true)
// "#0" / tanpa angka valid -> count 1.
function parseCountArg(raw) {
  const input = String(raw || "").trim();
  const m = /(?:^|\s)#(\d+)\s*$/.exec(input);

  if (!m) return { rest: input, count: 1, clamped: false };

  const requested = parseInt(m[1], 10);
  const rest = input.slice(0, m.index).trim();

  if (!Number.isFinite(requested) || requested < 1) {
    return { rest, count: 1, clamped: false };
  }
  if (requested > BATCH_MAX) {
    return { rest, count: BATCH_MAX, clamped: true };
  }
  return { rest, count: requested, clamped: false };
}

// Nama file zip dari keyword + jumlah gambar: "special week 10.zip".
// Tag Safebooru ("special_week_(umamusume)") dirapikan: underscore jadi spasi.
function buildZipName(session, count) {
  const keyword = String(session.tag || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${sanitizeFilename(keyword, "images")} ${count}.zip`;
}

// Caption TUNGGAL untuk satu batch (dipasang di gambar pertama): judul,
// keyword/karakter, kode sesi, daftar ID bernomor sesuai urutan kirim, lalu
// petunjuk lanjut. Dipasang di gambar pertama; sisanya TANPA caption.
function buildBatchCaption(
  posts,
  label,
  { code, source, lang, withIds = true },
) {
  const isPinterest = source === "pinterest";
  const isPixiv = source === "pixiv";
  const mediaWord = t(lang, "cap.mediaImage");
  const sourceTag = isPinterest ? " (Pinterest)" : isPixiv ? " (Pixiv)" : "";
  const labelLine = isPinterest || isPixiv
    ? `🔎 *${t(lang, "cap.keyword")}:* ${label}`
    : `👤 *${t(lang, "cap.character")}:* ${label}`;
  const codeLine = code
    ? `\n🔢 *${t(lang, "cap.sessionCode")}:* ${code}`
    : "";
  // Pixiv: tampilkan link karya (bisa diklik di WhatsApp), bukan sekadar ID.
  const idList = posts
    .map((p, i) =>
      isPixiv
        ? `${i + 1}. ${p.source_link || `https://www.pixiv.net/en/artworks/${p.id}`}`
        : `${i + 1}. ${p.id}`,
    )
    .join("\n");
  const continueLine = code
    ? t(lang, "cap.nextWithCode", { code, media: mediaWord.toLowerCase() })
    : t(lang, "cap.next", { media: mediaWord.toLowerCase() });

  // Mode zip: daftar ID dibuang supaya caption ringkas (ID sudah ada di
  // nama file di dalam zip).
  const idBlock = withIds
    ? `${t(lang, "batch.idList", { n: posts.length })}\n${idList}\n\n`
    : "";

  return `🖼️ *${t(lang, "cap.result", { media: mediaWord })}*${sourceTag}

${labelLine}${codeLine}

${idBlock}${continueLine}`;
}

// Kirim `count` gambar dari satu session pencarian (Safebooru, Pinterest, atau Pixiv).
//
// - count <= 1 -> persis alur lama (searchAndSendImage).
// - count  > 1 -> ambil acak dari pool, isi ulang pool dari halaman
//   berikutnya kalau habis, download paralel kecil, kirim BERURUTAN.
//   Gambar yang sama TIDAK dikirim dua kali dalam satu batch (pickRandom
//   sudah menandai seenIds). Gambar yang gagal di-download otomatis
//   diganti gambar lain.
// - Satu caption (kode sesi, daftar ID, petunjuk lanjut) hanya di gambar
//   PERTAMA; gambar lain tanpa caption biar chat tidak penuh teks.
// - Kalau hasil yang tersedia kurang dari permintaan, user dikasih tau.
async function sendImageBatch(
  sock,
  jid,
  sessionKey,
  tag,
  session,
  lang,
  count = 1,
) {
  if (count <= 1) {
    return searchAndSendImage(sock, jid, sessionKey, tag, session, lang);
  }

  const loader =
    session.source === "pinterest"
      ? loadMorePinterestCandidates
      : session.source === "pixiv"
        ? loadMorePixivCandidates
        : loadMoreCandidates;

  touchSession(session);
  sessions.set(sessionKey, session);
  const code = assignSessionCode(jid, session);
  const label = sessionLabel(session);

  const ready = []; // { post, buffer } yang sudah ter-download, urutan kirim
  let downloaded = 0;
  let failures = 0;

  while (downloaded < count && failures < count) {
    if (session.pool.length === 0) {
      let more = false;
      try {
        more = await loader(session);
      } catch (err) {
        // Sudah ada hasil -> kirim yang ada. Belum ada sama sekali -> lempar.
        if (downloaded === 0) throw err;
        console.log("[batch] gagal ambil halaman berikutnya:", err.message);
      }
      if (!more || session.pool.length === 0) break; // benar-benar habis
    }

    const take = Math.min(
      count - downloaded,
      DOWNLOAD_CONCURRENCY,
      session.pool.length,
    );
    const posts = [];
    for (let i = 0; i < take; i++) posts.push(pickRandom(session));

    const results = await Promise.allSettled(
      posts.map((p) => downloadImage(p.file_url)),
    );

    for (let i = 0; i < posts.length; i++) {
      if (results[i].status === "fulfilled") {
        ready.push({ post: posts[i], buffer: results[i].value });
        session.lastId = posts[i].id;
        downloaded++;
      } else {
        failures++;
        console.log(
          `[batch] download gagal (id ${posts[i].id}):`,
          results[i].reason?.message || results[i].reason,
        );
      }
    }
  }

  if (ready.length === 0) {
    throw new Error("batch: semua download gambar gagal");
  }

  // Caption tunggal dipasang di gambar PERTAMA (berisi daftar ID semua
  // gambar, makanya baru bisa dibuat setelah semua selesai di-download).
  const asZip = ZIP_MIN > 0 && ready.length >= ZIP_MIN;
  const caption = buildBatchCaption(
    ready.map((r) => r.post),
    label,
    { code, source: session.source, lang, withIds: !asZip },
  );

  // Banyak gambar (>= ZIP_MIN) -> kirim sebagai satu file zip.
  if (asZip) {
    const zipName = buildZipName(session, ready.length);
    const base = zipName.replace(/\.zip$/i, "");
    const zipBuffer = createZip(
      ready.map(({ post, buffer }, i) => ({
        name: `${base} ${i + 1} (${post.id}).${detectImageExt(buffer)}`,
        data: buffer,
      })),
    );

    await sock.sendMessage(jid, {
      document: zipBuffer,
      mimetype: "application/zip",
      fileName: zipName,
      caption,
    });

    if (ready.length < count) {
      await sock.sendMessage(jid, {
        text: t(lang, "batch.partial", {
          found: ready.length,
          requested: count,
        }),
      });
    }
    return;
  }

  let sent = 0;
  for (const { buffer } of ready) {
    const msg = { image: buffer };
    if (sent === 0) msg.caption = caption;
    await sock.sendMessage(jid, msg);
    sent++;
    if (sent < ready.length) await sleep(SEND_DELAY_MS + Math.floor(Math.random() * 2000));
  }

  if (sent < count) {
    await sock.sendMessage(jid, {
      text: t(lang, "batch.partial", { found: sent, requested: count }),
    });
  }
}

module.exports = {
  BATCH_MAX,
  ZIP_MIN,
  parseCountArg,
  sendImageBatch,
};