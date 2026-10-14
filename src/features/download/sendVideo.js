// Pengiriman video "pintar": video biasa kalau kecil, otomatis DOKUMEN
// kalau melewati batas. Dipakai semua jalur download (yt-dlp, SilenceYTDown,
// thread, dst) supaya aturannya satu tempat.
//
// Env (opsional):
//   DL_DOC_THRESHOLD_MB  batas video->dokumen, default 95
//   DL_VIDEO_HARD_MB     batas keras video biasa kalau user paksa "video", default 100

const DOC_THRESHOLD_BYTES =
  (Number(process.env.DL_DOC_THRESHOLD_MB) || 95) * 1024 * 1024;
const VIDEO_HARD_BYTES =
  (Number(process.env.DL_VIDEO_HARD_MB) || 100) * 1024 * 1024;

function shouldSendAsDocument(size, sendAs = "auto") {
  if (sendAs === "doc") return true;
  if (sendAs === "video") return size > VIDEO_HARD_BYTES;
  return size > DOC_THRESHOLD_BYTES;
}

async function sendVideoOrDocument(sock, jid, buffer, options, sendAs = "auto", extra = {}) {
  const sendDoc = () =>
    sock.sendMessage(
      jid,
      {
        document: buffer,
        mimetype: "video/mp4",
        fileName: `video-${Date.now()}.mp4`,
        ...extra,
      },
      options,
    );

  if (shouldSendAsDocument(buffer.length, sendAs)) return sendDoc();

  try {
    return await sock.sendMessage(
      jid,
      { video: buffer, mimetype: "video/mp4", ...extra },
      options,
    );
  } catch (err) {
    // Jaring pengaman: kalau kirim sebagai video gagal (mis. ditolak
    // WhatsApp karena ukuran/durasi), coba sekali lagi sebagai dokumen.
    console.log(`[dl] kirim video gagal (${err.message}) -> retry sebagai dokumen`);
    return sendDoc();
  }
}

module.exports = {
  DOC_THRESHOLD_BYTES,
  shouldSendAsDocument,
  sendVideoOrDocument,
};
