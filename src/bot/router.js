const { downloadMediaMessage, jidNormalizedUser } = require("@whiskeysockets/baileys");
const { PDFParse } = require("pdf-parse");
const axios = require("axios");

const { runArtikelCommand } = require("../commands/artikel");
const { handleAnalisisCommand } = require("../features/analisis/analisisCommand");
const { handleKriptoCommand } = require("../features/kripto/kriptoCommand");
const { handleKriptoNext } = require("../features/kripto/pasar");
const { normalizeCommandAlias } = require("./commandAliases");
const {
  handleTsundereChat,
  forgetGroqChat,
  summarizeDocumentText,
  saveDocumentContext,
  DOC_HARD_MAX_CHARS,
  SUMMARY_SINGLE_PASS_MAX_CHARS,
  SUMMARY_CHUNK_CHARS,
  DOC_CONTEXT_TTL_MS,
} = require("../../agemasenTsundere");

const { markReadHuman } = require("../utils/humanize");
const { getQuotedUrl, hasQuotedMessage } = require("../utils/quotedUrl");
const { getSenderJid, getSessionKey, getTsundereSessionKey, isOwnerMsg } = require("../utils/whatsapp");
const { isBotDisabledFor } = require("../state/botState");
const { recordUserActivity, isUserDisabled } = require("../state/userState");
const { logCommand } = require("../features/stats/stats");
const { rememberName, getCachedName } = require("../state/nameCache");
const {
  handleWhoamiCommand,
  sendNgambekReply,
  handleBotSwitchCommand,
  handleListGroupsCommand,
  handleUserSwitchCommand,
  handleListUsersCommand,
} = require("../features/owner/ownerCommands");

const {
  handleSubCommand,
  handleSubUserCommand,
  handleMySubscriptionCommand,
  sendSubscriptionBlockedReply,
} = require("../features/owner/subscriptionCommands");
const { checkSubscription } = require("../state/subscriptionStore");
const { registerUser } = require("../state/chatRegistry");
const { sendMenu, sendCommandDetail } = require("../features/menu/menu");
const { t, DEFAULT_LANG } = require("../i18n");
const { getLang } = require("../state/languageStore");
const { handleLanguageCommand } = require("../features/settings/languageCommand");
const {
  handleGroupInfoCommand,
  handleOnlineCommand,
  handleBotStatusCommand,
} = require("../features/group/groupInfo");

const {
  sessions,
  touchSession,
  chatCodeSessions,
  assignSessionCode,
} = require("../features/booru/sessionStore");
const {
  searchAndSendImage,
  pickRandom,
  downloadImage,
  buildCaption,
  sessionLabel,
  errorReplyText,
  newCandidateSession,
  loadMoreCandidates,
  fetchMatchingTags,
  fetchById,
  buildTagChoiceList,
} = require("../features/booru/safebooru");
const {
  isAllExplicit,
  buildSlots,
  advance,
  countAskable,
} = require("../features/booru/tagFlow");
const {
  newPinterestSession,
  loadMorePinterestCandidates,
} = require("../features/pinterest/pinterest");
const {
  isQueryBlocked: isPixivQueryBlocked,
  newPixivSession,
  loadMorePixivCandidates,
  resetPixivSession,
} = require("../features/pixiv/pixiv");
const { parseCountArg, sendImageBatch } = require("../features/booru/batch");
const {
  newGifSession,
  loadMoreGifCandidates,
  downloadGifFromPool,
} = require("../features/gif/gifService");
const { NoGifFoundError } = require("../features/gif/errors");
const { handleTrainerCommand, handleTrainerPick } = require("../features/trainer/trainerCommand");
const { handleClubCommand, handleClubPick, handleThresholdCommand, handleLeaderboardCommand } = require("../features/circle/circleCommand");

const {
  findPdfSource,
  findGifSource,
  findStickerSource,
  findAnySource,
  findStickerOnlySource,
  downloadGifBuffer,
  isStillMedia,
} = require("../features/media/detect");
const {
  animatedStickerToGifVideo,
  stickerToImageBuffer,
} = require("../features/media/sticker");
const { gifToTextSticker, mediaToSticker } = require("../features/meme/stickerBuilder");
const {
  textToBratSticker,
  MAX_CHARS: BRAT_MAX_CHARS,
} = require("../features/meme/bratSticker");
const {
  textToBratGifSticker,
  countWords: countBratGifWords,
  MAX_WORDS: BRATGIF_MAX_WORDS,
  MAX_CHARS: BRATGIF_MAX_CHARS,
} = require("../features/meme/bratGif");
const {
  textToDialogSticker,
  MAX_NAME_CHARS: SCHAT_MAX_NAME_CHARS,
  MAX_MESSAGE_CHARS: SCHAT_MAX_MESSAGE_CHARS,
} = require("../features/meme/dialogSticker");

const {
  findImageSource,
  parseHdScaleArg,
  upscaleImageWithRealEsrgan,
  enqueueHdJob,
  getHdActiveWorkers,
  HD_ENGINE,
  HD_QUEUE_CONCURRENCY,
} = require("../features/upscale/realesrgan");
const { upscaleImageWithSharp } = require("../features/upscale/sharpUpscale");

const {
  getYtdlpBackoffRemainingMs,
  formatDurationId,
} = require("../features/download/ytdlp");
const {
  handleDlDownload,
  handleDlrDownload,
} = require("../features/download/gallerydl");
const {
  isThreadsUrl,
  resolveThreadsShareUrl,
  handleDlThread,
} = require("../features/download/thread");

// Resolusi yang boleh diminta user lewat "!dl <link> <height>p". Batasnya
// 720p (bukan sampai 2160p walau SilenceYTDown sendiri sanggup) karena
// jalur fallback yt-dlp lokal di ytdlp.js memang di-cap segitu buat jaga
// ukuran file/waktu proses tetap aman buat WhatsApp -- lihat
// YTDLP_ALLOWED_HEIGHTS di ytdlp.js.
const DL_ALLOWED_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

function normalizeJidSafe(jid) {
  if (!jid) return null;
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

// Dipanggil buat SETIAP pesan masuk (lihat awal handleMessagesUpsert):
// "nyolong dengar" pushName pengirimnya dan disimpan ke nameCache, di
// SEMUA bentuk jid yang Baileys kasih buat pesan ini (participant/@lid
// DAN participantPn/senderPn/nomor asli sekaligus, kalau ada) -- supaya
// nanti pas di-tag/reply pakai !schat, nama aslinya ketemu gak peduli
// bentuk jid mana yang muncul di situ. Lihat komentar panjang di
// state/nameCache.js buat alasan lengkapnya.
function rememberNamesFromMsg(msg) {
  const pushName = msg.pushName;
  if (!pushName) return;

  const isGroup = !!msg.key.participant;
  const rawJids = [
    msg.key.participant,
    msg.key.participantPn,
    msg.key.senderPn,
    isGroup ? null : msg.key.remoteJid, // chat pribadi: remoteJid = si pengirim
  ].filter(Boolean);

  for (const raw of rawJids) {
    rememberName(normalizeJidSafe(raw), pushName);
  }
}

// Pola AWALAN teks mention WhatsApp mentah, mis. "@262796902162504 " --
// ini yang BENERAN kekirim di isi pesan kalau user pilih kontak lewat
// fitur @mention WA (WA gak pernah nyisipin nama asli ke teksnya, cuma
// angka ID). Dipakai buat deteksi "field Nama di !schat ini DIAWALI hasil
// nge-tag" -- baik itu SELURUH isinya (murni hasil pilih @mention) maupun
// cuma awalannya doang (user nge-tag buat avatar, TERUS nambahin nama
// custom sendiri setelahnya, mis. "@628xxx aku baik").
const MENTION_PREFIX_RE = /^@\d{5,}\s*/;
const MENTION_UNKNOWN_NAME_FALLBACK = "Seseorang";

// Resolusi nama yang ditampilkan di stiker:
//   1. Field Nama gak diawali mention sama sekali -> dipakai apa adanya
//      (user ketik manual, gak nge-tag).
//   2. Diawali mention TAPI ada teks custom nempel setelahnya (mis.
//      "@628xxx aku baik") -> teks custom itu yang dipakai, avatar tetap
//      dari orang yang di-tag. Ini prioritas PALING TINGGI -- user yang
//      nulis sendiri, jadi dianggap paling benar, gak perlu nebak apa pun.
//   3. Field-nya CUMA mention doang, gak ada nama custom nempel -> coba
//      pushName pengirim sendiri (kalau avatar-nya emang dirinya sendiri),
//      lalu coba nameCache (butuh orang itu PERNAH kelihatan ngirim pesan
//      sebelumnya), baru kalau semua gagal fallback ke label generik
//      "Seseorang" (BUKAN angka ID mentah -- jelek & gak enak dibaca).
function resolveSchatDisplayName(rawName, msg, avatarJid) {
  const mentionMatch = rawName.match(MENTION_PREFIX_RE);
  if (!mentionMatch) return rawName;

  const customName = rawName.slice(mentionMatch[0].length).trim();
  if (customName) return customName;

  const normalized = avatarJid ? normalizeJidSafe(avatarJid) : null;

  if (normalized && normalized === getSenderJid(msg) && msg.pushName) {
    return msg.pushName.trim();
  }

  const cached = normalized ? getCachedName(normalized) : null;
  return cached || MENTION_UNKNOWN_NAME_FALLBACK;
}

// =====================================================
// Helper khusus "!schat": nentuin jid siapa yang fotonya mau dipakai
// jadi avatar, KALAU user gak ngirim/reply gambar secara langsung.
//
// Prioritas:
//   1. Jid pengirim pesan yang di-REPLY (ctx.participant) -- kalau user
//      reply ke chat orang lain terus ketik "!schat ...", ambil pp orang
//      yang di-reply itu. Ini yang paling natural buat "sticker dialog
//      dari chat yang di-reply".
//   2. Jid orang yang di-TAG/mention (@user) di teks command-nya.
//   3. Fallback: pengirim command itu sendiri (pp sendiri).
// =====================================================
function resolveSchatAvatarJid(msg, senderJid) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant) return ctx.participant;
  if (ctx?.mentionedJid && ctx.mentionedJid.length > 0) return ctx.mentionedJid[0];
  return senderJid;
}

// Ambil foto profil WA (buffer) buat 1 jid. Baileys sock.profilePictureUrl
// bisa gagal/nolak kalau privasi orangnya emang ditutup ("hanya kontak
// saya", dst) -- itu WAJAR, bukan bug, makanya error di sini SENGAJA
// ditelan (return null) supaya !schat tetap lanjut pakai avatar fallback
// (lingkaran huruf) alih-alih gagal total.
async function fetchProfilePictureBuffer(sock, jid) {
  if (!jid) return null;

  try {
    const normalized = jidNormalizedUser(jid);
    const url = await sock.profilePictureUrl(normalized, "image");
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
    });
    return Buffer.from(res.data);
  } catch (err) {
    return null;
  }
}

// Tangani satu event "messages.upsert" dari Baileys. Ini adalah router
// utama semua command (!ping, !img, !meme, !dl, dst) -- pisahan logic
// tiap fitur sendiri ada di src/features/*, di sini cuma orkestrasinya.
// ---------------------------------------------------------------------
// Antrean pesan masuk. Tujuannya: SEMUA pesan diproses, tidak ada yang
// ke-skip, walau datang beruntun / bersamaan dari banyak grup.
//  - Pesan masuk di-enqueue, dijalankan max MSG_CONCURRENCY sekaligus
//    (global, lintas grup) supaya ffmpeg/canvas tidak overload.
//  - Pesan yang sama (key.id) tidak diproses 2x (jaga-jaga kalau Baileys
//    mengirim ulang lewat type "append").
// ---------------------------------------------------------------------
const MSG_CONCURRENCY = Number(process.env.MSG_CONCURRENCY) || 3;
const seenMsgIds = new Set();
const pendingJobs = [];
let runningJobs = 0;

function pumpQueue() {
  while (runningJobs < MSG_CONCURRENCY && pendingJobs.length) {
    const job = pendingJobs.shift();
    runningJobs++;
    job()
      .catch((err) => console.error("[router] Error proses pesan:", err))
      .finally(() => {
        runningJobs--;
        pumpQueue();
      });
  }
}

function rememberMsgId(id) {
  if (!id) return true;
  if (seenMsgIds.has(id)) return false;
  seenMsgIds.add(id);
  if (seenMsgIds.size > 2000) {
    // buang yang paling lama
    seenMsgIds.delete(seenMsgIds.values().next().value);
  }
  return true;
}

// Baileys bisa mengirim BANYAK pesan sekaligus dalam satu event upsert,
// dan pesan yang datang beruntun kadang ditandai type "append" (bukan
// "notify"). Dulu cuma messages[0] & type "notify" yang diproses.
async function handleMessagesUpsert(sock, { messages, type }) {
  const list = messages || [];
  console.log(`[upsert] type=${type} jumlah=${list.length}`);

  const nowSec = Math.floor(Date.now() / 1000);

  for (const m of list) {
    if (!m?.message || m.key?.fromMe) continue;

    // "append" = biasanya pesan lama/riwayat. Terima hanya kalau barusan
    // masuk (<= 2 menit), supaya pesan lama tidak dieksekusi ulang.
    if (type !== "notify") {
      const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp) || 0;
      if (!ts || nowSec - ts > 120) continue;
    }

    if (!rememberMsgId(m.key?.id)) continue;

    pendingJobs.push(() => handleSingleMessage(sock, m));
  }

  pumpQueue();
}

// Cari link buat !dl/!dlr/!dlt: prioritas link yang diketik langsung di
// command; kalau tidak ada, ambil dari pesan yang di-reply.
// Return { url, hint, fromReply, noLinkInReply }.
function resolveDlTarget(msg, rest) {
  const urlMatch = rest.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    return {
      url: urlMatch[0],
      hint: rest.slice(urlMatch.index + urlMatch[0].length).trim().toLowerCase(),
      fromReply: false,
      noLinkInReply: false,
    };
  }

  const quotedUrl = getQuotedUrl(msg);
  if (quotedUrl) {
    // Tidak ada link di command -> seluruh sisa teks dianggap hint
    // (mis. reply link lalu ketik "!dl 1080p doc").
    return { url: quotedUrl, hint: rest.trim().toLowerCase(), fromReply: true, noLinkInReply: false };
  }

  return { url: null, hint: "", fromReply: false, noLinkInReply: hasQuotedMessage(msg) };
}

async function handleSingleMessage(sock, msg) {
    if (!msg?.message) return;

    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const sessionKey = getSessionKey(msg);
    // Sesi khusus obrolan AI tsundere -- di grup, ini SATU key buat seluruh
    // anggota grup (bukan per-orang seperti sessionKey biasa di atas),
    // supaya siapa pun bisa reply ke pesan bot manapun dan tetap nyambung
    // ke obrolan yang sama. Lihat komentar di getTsundereSessionKey.
    const tsundereSessionKey = getTsundereSessionKey(msg);

    // "Nyolong dengar" pushName pengirim pesan ini (lihat nameCache.js) --
    // dipanggil paling awal & UNCONDITIONAL (gak peduli command apa/lagi
    // dimatiin atau enggak) biar cache-nya selalu ke-update dari lalu
    // lintas chat normal, terlepas dari fitur apa yang akhirnya jalan.
    rememberNamesFromMsg(msg);

    // =====================
    // Bahasa chat ini (id/en), dibaca dari cache memori yang disinkron dari
    // Supabase (lihat state/languageStore.js) -- tidak ada request jaringan
    // per pesan. Grup -> pengaturan GRUP; DM -> pengaturan NOMOR pengirim.
    // Belum pernah diatur -> bahasa default (DEFAULT_LANG, awalnya "id").
    // =====================
    const lang = jid.endsWith("@g.us")
      ? getLang("group", jid)
      : jid.endsWith("@broadcast")
        ? DEFAULT_LANG
        : getLang("user", getSenderJid(msg));
    const tr = (key, vars) => t(lang, key, vars);

    const originalText = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.videoMessage?.caption ||
      msg.message.imageMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""
    ).trim();
    // !summarize/!article/!forget/!subscription -> nama kanonik (lihat
    // bot/commandAliases.js), jadi command versi English & Indonesia sama-sama jalan.
    const text = normalizeCommandAlias(originalText);

    // Tandai dibaca dengan jeda acak (fire-and-forget) untuk pesan command.
    if (text.startsWith("!")) markReadHuman(sock, msg);

    // =====================
    // !whoami -- debug: cek jid apa yang kedeteksi buat pengirim pesan ini
    // (berguna kalau owner check meleset gara-gara @lid dsb). Ditaruh
    // paling atas juga biar bisa dipakai walau grup lagi dinonaktifin.
    // =====================
    if (await handleWhoamiCommand(sock, msg, { jid, text })) {
      return;
    }

    // =====================
    // !bot on / !bot off / !bot status -- KHUSUS owner, PALING ATAS
    // supaya tetap jalan walaupun grup lagi dinonaktifin (owner harus
    // selalu bisa nyalain lagi).
    // =====================
    if (await handleBotSwitchCommand(sock, msg, { jid, text, lang })) {
      return;
    }

    // =====================
    // !listgrup -- KHUSUS owner, PALING ATAS juga (sama kayak !bot),
    // biar owner tetap bisa cek daftar grup walau lagi di grup yang
    // dinonaktifin.
    // =====================
    if (await handleListGroupsCommand(sock, msg, { jid, text, lang })) {
      return;
    }

    // =====================
    // !user on / !user off / !user status <nomor> -- KHUSUS owner.
    // Blokir/buka balasan bot buat DM dari nomor tertentu. Bisa dipanggil
    // dari MANA PUN (gak harus dari chat sama nomor targetnya), jadi
    // ditaruh paling atas juga.
    // =====================
    if (await handleUserSwitchCommand(sock, msg, { jid, text, lang })) {
      return;
    }

    // =====================
    // !listuser -- KHUSUS owner. Monitoring: daftar semua nomor yang
    // pernah DM bot ini + jumlah pesan, terakhir kontak, status blokir.
    // =====================
    if (await handleListUsersCommand(sock, msg, { jid, text, lang })) {
      return;
    }

    // =====================
    // !sub / !subuser -- KHUSUS owner. Kelola langganan (data di Supabase).
    // Ditaruh paling atas juga: owner harus tetap bisa perpanjang walau
    // grupnya sudah kena blokir karena langganan habis.
    // =====================
    if (await handleSubCommand(sock, msg, { jid, text, lang })) {
      return;
    }
    if (await handleSubUserCommand(sock, msg, { jid, text, lang })) {
      return;
    }

    // =====================
    // Monitoring DM pribadi: catat setiap orang yang DM bot ini (nomor,
    // jumlah pesan, terakhir kontak) supaya bisa dipantau lewat
    // "!listuser". Cuma buat chat pribadi, bukan grup (grup dipantau
    // lewat "!listgrup").
    //
    // PENTING: dicatat pakai getSenderJid(msg), BUKAN "jid" (remoteJid)
    // mentah. Kalau kontaknya pakai fitur privasi WhatsApp "Linked ID",
    // remoteJid muncul dalam bentuk "xxxxx@lid" (bukan nomor telepon
    // asli), beda tiap device -- sedangkan "!user off <nomor>" (di
    // ownerCommands.js) selalu bikin key dalam format nomor telepon
    // asli ("<nomor>@s.whatsapp.net"). Kalau di sini masih pakai
    // remoteJid mentah, hasilnya adalah 2 key yang gak akan pernah nyambung
    // -- blokir keliatan "berhasil" tapi gak akan pernah efektif buat
    // kontak yang JID-nya "@lid". getSenderJid() sudah nanganin ini
    // (dia ambil nomor asli lewat field senderPn dari Baileys), jadi
    // key yang kepakai di sini SELALU konsisten sama yang diketik owner.
    // =====================
    const isPrivateChat = !jid.endsWith("@g.us") && !jid.endsWith("@broadcast");
    const senderJid = isPrivateChat ? getSenderJid(msg) : null;
    if (isPrivateChat && senderJid && !isOwnerMsg(msg)) {
      recordUserActivity(senderJid, msg.pushName || null);
      // Catat juga ke Supabase (tabel chats) supaya DM yang belum berlangganan
      // tetap muncul di daftar admin. Fire-and-forget + di-throttle.
      registerUser(senderJid, msg.pushName || null);
    }

    // =====================
    // Saklar blokir per NOMOR (DM pribadi): kalau nomor ini lagi
    // DIBLOKIR owner lewat "!user off <nomor>" dan bukan owner sendiri,
    // bot "ngambek" -- gak proses command/fitur apa pun lagi buat dia.
    // =====================
    if (isPrivateChat && senderJid && isUserDisabled(senderJid) && !isOwnerMsg(msg)) {
      if (text.startsWith("!")) {
        await sendNgambekReply(sock, jid, lang);
      }
      return;
    }

    // =====================
    // Saklar aktif/nonaktif per grup: kalau grup ini lagi DIMATIIN dan
    // pengirimnya BUKAN owner, bot "ngambek" -- gak proses command/fitur
    // apa pun lagi (termasuk chat AI tsundere di bawah). Owner sendiri
    // gak kena blokir ini sama sekali.
    // =====================
    if (isBotDisabledFor(jid) && !isOwnerMsg(msg)) {
      if (text.startsWith("!")) {
        await sendNgambekReply(sock, jid, lang);
      }
      return;
    }

    // =====================
    // !langganan -- cek sisa langganan. Sengaja SEBELUM gerbang langganan di
    // bawah, jadi anggota tetap bisa lihat kapan habisnya walau langganan
    // sudah berakhir.
    // =====================
    if (await handleMySubscriptionCommand(sock, msg, { jid, text, senderJid, lang })) {
      return;
    }

    // =====================
    // Gerbang LANGGANAN (hitung mundur dari Supabase). Beda dengan saklar
    // on/off di atas (manual), ini otomatis mati begitu expires_at lewat.
    // Grup dicek per jid grup, DM dicek per nomor pengirim. Owner lolos.
    // Murni baca cache memori, tidak ada request jaringan per pesan.
    // =====================
    {
      const subKind = isPrivateChat ? "user" : jid.endsWith("@g.us") ? "group" : null;
      const subId = isPrivateChat ? senderJid : jid;
      if (subKind && subId && !isOwnerMsg(msg)) {
        const sub = checkSubscription(subKind, subId);
        if (!sub.allowed) {
          // Command ("!...") di grup/DM -> selalu dibalas info langganan.
          // Chat bebas di DM -> diingatkan sesekali (cooldown panjang).
          // Chat bebas di grup -> diam saja, biar grup tidak dispam.
          if (text.startsWith("!")) {
            await sendSubscriptionBlockedReply(sock, jid, subKind, sub, { lang });
          } else if (isPrivateChat && text.trim()) {
            await sendSubscriptionBlockedReply(sock, jid, subKind, sub, {
              freeChat: true,
              lang,
            });
          }
          return;
        }
      }
    }

    // Catat command untuk dashboard web (fire-and-forget).
    if (text.startsWith("!")) {
      logCommand({ command: text.trim().split(/\s+/)[0].toLowerCase(), jid });
    }

    // =====================
    // !groupinfo / !online / !botstatus -- info grup, cek yang online,
    // dan status bot. Ditaruh SETELAH cek grup nonaktif, jadi cuma jalan
    // di grup yang bot-nya aktif (owner tetap lolos).
    // =====================
    if (await handleGroupInfoCommand(sock, msg, { jid, text, lang })) return;
    if (await handleOnlineCommand(sock, msg, { jid, text, lang })) return;
    if (await handleBotStatusCommand(sock, msg, { jid, text, lang })) return;

    // =====================
    // !lang / !bahasa -- ganti bahasa bot (per nomor di DM, per grup di
    // grup; disimpan di Supabase). Lihat features/settings/languageCommand.js.
    // =====================
    if (await handleLanguageCommand(sock, msg, { jid, text, lang })) return;

    // =====================
    // !ping
    // =====================
    if (text === "!ping") {
      await sock.sendMessage(jid, { text: "🏓 Pong!" });
      return;
    }

    // =====================
    // !trainer <nama|id> -- cari trainer Uma Musume (uma.moe), pilih dari
    // daftar, lalu kirim kartu trainer. Lihat src/features/trainer/.
    // =====================
    if (await handleTrainerCommand(sock, msg, { jid, text, lang })) return;

    // =====================
    // !club <nama|id>, !threshold, !leaderboard -- circle/club Uma Musume
    // (uma.moe). Lihat src/features/circle/.
    // =====================
    if (await handleClubCommand(sock, msg, { jid, text, lang })) return;
    if (await handleThresholdCommand(sock, msg, { jid, text, lang })) return;
    if (await handleLeaderboardCommand(sock, msg, { jid, text, lang })) return;

    // =====================
    // !lupain -- reset ingatan obrolan chat AI (tsundere).
    // Di grup ini bakal ngelupain obrolan BERSAMA seluruh grup (karena
    // sekarang 1 grup = 1 sesi tsundere, lihat tsundereSessionKey).
    // =====================
    if (text === "!lupain") {
      const had = forgetGroqChat(tsundereSessionKey);
      await sock.sendMessage(jid, {
        text: tr(had ? "forget.had" : "forget.none"),
      });
      return;
    }

    // =====================
    // !menu
    // =====================
    if (text === "!menu") {
      await sendMenu(sock, jid, lang);
      return;
    }

    // =====================
    // !artikel <kata kunci | doi <DOI> | arxiv <kata kunci> | URL> -> pencarian
    // publikasi (OpenAlex -> Crossref -> Unpaywall -> arXiv, lihat
    // src/services/journal). Kalau inputnya URL, jalan alur lama: Article/
    // Document Downloader (Provider Registry di src/providers).
    // Gak pernah nyoba bypass paywall/login/CAPTCHA -- lihat src/commands/artikel.js.
    // =====================
    if (text === "!artikel" || text.startsWith("!artikel ")) {
      const articleInput = text.slice("!artikel".length).trim();
      const senderId = getSenderJid(msg);
      await runArtikelCommand(sock, jid, articleInput, senderId, lang);
      return;
    }

    // =====================
    // !analisis <koin> [1H|4H|1D] -> analisis teknikal crypto (web
    // KriptoPredict, env ANALYST_URL) dikirim sebagai PDF.
    // Lihat src/features/analisis/.
    // =====================
    if (await handleAnalisisCommand(sock, msg, { jid, text, lang })) return;

    // !chart / !harga / !level <koin> [tf] -> analisis dasar kripto (data
    // langsung dari Binance, tidak butuh ANALYST_URL). Lihat src/features/kripto/.
    if (await handleKriptoCommand(sock, msg, { jid, text, lang })) return;

    // =====================
    // !ringkas [instruksi tambahan] -> baca teks dari dokumen PDF (langsung
    // dikirim dengan caption, atau reply ke PDF yang sudah ada), lalu minta
    // Groq bikin ringkasan GARIS BESARnya (dokumen panjang otomatis diproses
    // per-bagian dulu, lihat summarizeDocumentText di agemasenTsundere.js).
    // Teks lengkap dokumennya ikut "diinget" di sesi ini (lihat
    // saveDocumentContext) selama DOC_CONTEXT_TTL_MS, jadi user bisa nanya
    // lebih lanjut soal isi dokumennya lewat chat AI (tag bot/reply) setelah
    // ini, gak cuma dapet ringkasannya doang.
    //
    // Kalau PDF-nya hasil scan/foto tanpa lapisan teks, pdf-parse gak bakal
    // nemu teks apa-apa -- kita kasih tau user daripada maksain ringkasan
    // kosong/ngasal.
    // =====================
    if (text === "!ringkas" || text.startsWith("!ringkas ")) {
      const userInstruction = text.slice("!ringkas".length).trim();
      const pdfSource = findPdfSource(msg);

      if (!pdfSource) {
        await sendCommandDetail(sock, jid, "ringkas", lang);
        return;
      }

      try {
        await sock.sendMessage(jid, {
          text: tr("ringkas.reading"),
        });

        const fakeMsg = { key: pdfSource.refKey, message: pdfSource.content };
        const pdfBuffer = await downloadMediaMessage(fakeMsg, "buffer", {});
        const fileName = pdfSource.content.documentMessage?.fileName || "dokumen.pdf";

        const parser = new PDFParse({ data: pdfBuffer });
        let rawText;
        try {
          const result = await parser.getText();
          rawText = result.text || "";
        } finally {
          await parser.destroy();
        }

        // Buang penanda antar-halaman ("-- N of M --") yang disisipkan
        // pdf-parse -- itu bukan bagian isi dokumen, cuma bikin bising
        // buat model pas diringkas.
        const cleanedTextFull = rawText
          .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // Jaring pengaman terakhir buat dokumen yang BENERAN ekstrem
        // (ratusan-ribuan halaman) -- di luar ini dipotong total, gak ikut
        // diproses maupun disimpan sebagai ingatan.
        const hardTruncated = cleanedTextFull.length > DOC_HARD_MAX_CHARS;
        const cleanedText = hardTruncated
          ? cleanedTextFull.slice(0, DOC_HARD_MAX_CHARS)
          : cleanedTextFull;

        // Kalau bakal lewat proses map-reduce (dokumen panjang), kasih tau
        // user duluan biar gak bingung nunggu -- sekalian estimasi jumlah
        // bagian yang bakal diproses satu-satu.
        if (cleanedText.length > SUMMARY_SINGLE_PASS_MAX_CHARS) {
          const estChunks = Math.ceil(cleanedText.length / SUMMARY_CHUNK_CHARS);
          await sock.sendMessage(jid, {
            text: tr("ringkas.long", { chunks: estChunks }),
          });
        }

        const senderName = msg.pushName || "";
        let lastProgressSentAt = 0;
        const { chunks } = await summarizeDocumentText(cleanedText, {
          senderName,
          fileName,
          userInstruction,
          truncated: hardTruncated,
          lang,
          // Update presence "typing..." tiap beberapa bagian biar user tau
          // bot masih proses (bukan macet), tanpa spam pesan tiap bagian.
          onProgress: async (current, total) => {
            const now = Date.now();
            if (now - lastProgressSentAt < 8000 && current !== total) return;
            lastProgressSentAt = now;
            await sock.sendPresenceUpdate("composing", jid);
          },
        });

        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(
            jid,
            { text: chunks[i] },
            i === 0 ? { quoted: msg } : {},
          );
        }

        // Simpan teks lengkapnya (bukan ringkasannya) ke sesi ini biar bisa
        // dipakai lagi kalau user nanya-nanya lanjutan soal isi dokumennya.
        saveDocumentContext(tsundereSessionKey, { text: cleanedText, fileName });

        const ttlHours = Math.round(DOC_CONTEXT_TTL_MS / (60 * 60 * 1000));
        await sock.sendMessage(jid, {
          text: tr("ringkas.tip", { hours: ttlHours }),
        });
      } catch (err) {
        console.log("[!ringkas] gagal:", err.message || err);
        const isConfigError = /GROQ_API_KEY/.test(err.message || "");
        await sock.sendMessage(jid, {
          text: tr(isConfigError ? "ringkas.noGroq" : "ringkas.fail"),
        });
      }

      return;
    }

    // =====================
    // !hd / !hd 2x / !hd 4x  -> AI Image Upscaler (Real-ESRGAN lokal).
    // Lihat komentar lengkap di definisi upscaleImageWithRealEsrgan() di
    // atas buat detail alur & alasan desainnya.
    // =====================
    if (text === "!hd" || text.startsWith("!hd ")) {
      const argPart = text.slice(4).trim();
      const parsedScale = parseHdScaleArg(argPart);

      if (!parsedScale.ok) {
        await sock.sendMessage(jid, {
          text: tr("hd.badScale"),
        });
        return;
      }

      const source = findImageSource(msg);

      if (!source) {
        await sock.sendMessage(jid, {
          text: tr("hd.needImage"),
        });
        return;
      }

      const { scale } = parsedScale;

      // Kasih tau DULUAN kalau bakal ngantre (sebelum enqueueHdJob),
      // biar user gak nunggu diem tanpa kabar kalau lagi ada proses
      // "!hd" lain yang jalan.
      if (getHdActiveWorkers() >= HD_QUEUE_CONCURRENCY) {
        await sock.sendMessage(jid, {
          text: tr("hd.queued"),
        });
      }

      const engineLabel =
        HD_ENGINE === "realesrgan"
          ? tr("hd.engineAi")
          : tr("hd.engineSharp");

      try {
        const resultBuffer = await enqueueHdJob(async () => {
          await sock.sendMessage(jid, {
            text: tr("hd.processing", { engine: engineLabel, scale }),
          });

          const inputBuffer = await downloadGifBuffer(
            source.content,
            source.refKey,
          );

          return HD_ENGINE === "realesrgan"
            ? upscaleImageWithRealEsrgan(inputBuffer, scale)
            : upscaleImageWithSharp(inputBuffer, scale);
        });

        const successLine =
          HD_ENGINE === "realesrgan"
            ? tr("hd.successAi")
            : tr("hd.successSharp");

        await sock.sendMessage(jid, {
          image: resultBuffer,
          caption: tr("hd.done", { line: successLine, scale }),
        });
      } catch (err) {
        console.log("=== [!hd] gagal ===");
        console.log(err.message || err);
        console.log("===================");
        await sock.sendMessage(jid, {
          text: tr("hd.fail"),
        });
      }

      return;
    }

    // =====================
    // Balasan angka untuk memilih karakter dari daftar disambiguasi
    // ATAU untuk lanjut (!next) pakai kode sesi.
    //
    // KEDUANYA sama-sama "ketik angka" jadi wajib dibedakan biar gak
    // bentrok satu sama lain:
    //   - Pilihan karakter: HARUS reply (quote) ke pesan daftar tag-nya
    //     (dicek lewat ctx.stanzaId === session.promptMsgId). Ini juga
    //     yang bikin gak ke-trigger cuma gara-gara kebetulan session milik
    //     pengirim ini masih ada pendingTagChoices lama yang belum expired.
    //   - Kode sesi: ketik angka POLOS (bukan reply ke daftar tag), dicek
    //     ke chatCodeSessions seperti biasa.
    // Dipakai oleh "!next" dan lanjut-pakai-kode-sesi: pool session ini
    // kosong (semua post yang sudah di-load sudah pernah dikirim), jadi
    // coba ambil halaman berikutnya dari Safebooru. Kalau ternyata SEMUA
    // halaman untuk tag ini sudah habis (berarti user sudah lihat semua
    // gambar yang ada), siklus direset dari awal (boleh muncul ulang)
    // supaya user tetap dapat gambar, bukan mentok dead-end.
    async function refillPool(session) {
      if (session.pool.length > 0) return true;

      const isPinterest = session.source === "pinterest";
      const isPixiv = session.source === "pixiv";
      const isGif = session.source === "gif";
      const loader = isGif
        ? loadMoreGifCandidates
        : isPinterest
          ? loadMorePinterestCandidates
          : isPixiv
            ? loadMorePixivCandidates
            : loadMoreCandidates;

      if (await loader(session)) return true;

      session.seenIds.clear();
      if (isGif) {
        // Tenor/GIPHY di sini gak punya cursor asli (satu batch per
        // keyword, lihat komentar di newGifSession/loadMoreGifCandidates),
        // jadi "reset" cukup buka lagi kunci noMore-nya -- searchGif()
        // biasanya masih kena cache 10 menit, jadi batch yang balik
        // (kemungkinan besar) sama seperti sebelumnya.
        session.noMore = false;
      } else if (isPinterest) {
        session.bookmark = null;
        session.noMore = false;
      } else if (isPixiv) {
        resetPixivSession(session);
      } else {
        session.pid = 0;
        session.noMorePages = false;
      }

      if (await loader(session)) {
        await sock.sendMessage(jid, {
          text: tr(isGif ? "refill.gif" : "refill.img"),
        });
        return true;
      }

      return false; // tag/keyword ini memang tidak punya gambar/GIF sama sekali
    }

    // =====================
    // Alur pencarian !img fleksibel (lihat src/features/booru/tagFlow.js).
    // Dipanggil dari !img (langkah pertama) & dari balasan angka user
    // (langkah berikutnya). Entah kirim daftar pilihan untuk slot yang
    // belum jelas, atau -- kalau semua slot sudah terpilih -- langsung cari
    // & kirim gambar yang memuat SEMUA tag terpilih.
    // =====================
    async function runTagFlow(flow) {
      const step = advance(flow);

      if (!step.done) {
        const words = step.slot.words.join(" ");
        const header =
          flow.askTotal > 1
            ? tr("tagList.step", {
                n: flow.asked + 1,
                total: flow.askTotal,
                words,
              })
            : undefined;

        const pendingSession = touchSession({
          pendingTagChoices: step.matches,
          pendingFlow: flow,
          pendingSlotIdx: step.slotIdx,
        });
        sessions.set(sessionKey, pendingSession);

        const sentMsg = await sock.sendMessage(jid, {
          text: buildTagChoiceList(step.matches, lang, {
            header,
            total: step.total,
          }),
        });
        pendingSession.promptMsgId = sentMsg?.key?.id || null;
        return;
      }

      const finalTag = step.tags.join(" ");
      const candidateSession = newCandidateSession(finalTag);
      const hasCandidates = await loadMoreCandidates(candidateSession);

      if (!hasCandidates) {
        await sock.sendMessage(jid, { text: tr("tag.noImages") });
        return;
      }

      await sendImageBatch(
        sock,
        jid,
        sessionKey,
        finalTag,
        candidateSession,
        lang,
        flow.count || 1,
      );
    }

    // =====================
    // Balasan angka ke daftar !trainer (cek reply ke pesan daftarnya).
    if (await handleTrainerPick(sock, msg, { jid, text, lang })) return;
    if (await handleClubPick(sock, msg, { jid, text, lang })) return;

    if (/^\d+$/.test(text)) {
      const session = sessions.get(sessionKey);
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const isReplyToTagPrompt =
        session?.pendingTagChoices &&
        ctx?.stanzaId &&
        session.promptMsgId &&
        ctx.stanzaId === session.promptMsgId;

      if (isReplyToTagPrompt) {
        touchSession(session);
        const idx = parseInt(text, 10) - 1;
        const choice = session.pendingTagChoices[idx];

        if (!choice) {
          await sock.sendMessage(jid, {
            text: tr("tag.invalidNumber", { max: session.pendingTagChoices.length }),
          });
          return;
        }

        // Alur !img fleksibel: simpan pilihan untuk slot ini, lalu lanjut ke
        // slot berikutnya (atau cari gambar kalau semua sudah terpilih).
        if (session.pendingFlow) {
          try {
            const flow = session.pendingFlow;
            flow.picked[session.pendingSlotIdx] = choice.name;
            flow.asked++;
            await runTagFlow(flow);
          } catch (err) {
            console.log(err);
            await sock.sendMessage(jid, {
              text: errorReplyText(err, lang),
            });
          }
          return;
        }

        try {
          const candidateSession = newCandidateSession(choice.name);
          const hasCandidates = await loadMoreCandidates(candidateSession);

          if (!hasCandidates) {
            await sock.sendMessage(jid, {
              text: tr("tag.noImages"),
            });
            return;
          }

          await sendImageBatch(
            sock,
            jid,
            sessionKey,
            choice.name,
            candidateSession,
            lang,
            session.pendingCount || 1,
          );
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err, lang),
          });
        }

        return;
      }

      // Bukan reply ke daftar disambiguasi -> cek apakah angka ini KODE
      // SESI pencarian yang lagi aktif di chat ini. Kode sesi ini
      // scope-nya per-chat (bukan per-pengirim), jadi siapa pun di grup
      // yang sama boleh pakai kode punya orang lain buat lanjut (!next)
      // pencarian itu, dan ini tidak bentrok dengan kode punya pencarian
      // lain karena tiap pencarian dapat nomor kodenya sendiri-sendiri.
      const codeNum = parseInt(text, 10);
      const codeSession = chatCodeSessions.get(jid)?.get(codeNum);

      if (codeSession) {
        touchSession(codeSession);
        try {
          const ok = await refillPool(codeSession);

          if (!ok) {
            await sock.sendMessage(jid, {
              text: tr("tag.noMore"),
            });
            return;
          }

          if (codeSession.source === "gif") {
            // Otomatis coba item LAIN di pool kalau yang kepilih random
            // gagal diproses (lihat komentar panjang di
            // downloadGifFromPool, gifService.js) -- jadi pick + download
            // digabung, bukan pickRandom() lalu downloadGifPost() 1x kayak
            // sebelumnya.
            const { buffer, post } = await downloadGifFromPool(
              codeSession,
              pickRandom,
            );
            codeSession.lastId = post.id;

            const karakterLabel = sessionLabel(codeSession);
            const caption = buildCaption(post, karakterLabel, {
              lang,
              isNext: true,
              code: codeNum,
              source: codeSession.source,
            });

            await sock.sendMessage(jid, {
              video: buffer,
              gifPlayback: true,
              caption,
            });
          } else {
            const post = pickRandom(codeSession);
            codeSession.lastId = post.id;

            const karakterLabel = sessionLabel(codeSession);
            const caption = buildCaption(post, karakterLabel, {
              lang,
              isNext: true,
              code: codeNum,
              source: codeSession.source,
            });

            const buffer = await downloadImage(post.file_url);
            await sock.sendMessage(jid, { image: buffer, caption });
          }
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err, lang),
          });
        }

        return;
      }

      // angka tanpa daftar pending & bukan kode sesi yang aktif -> biarkan
      // lewat, bukan command. TAPI kalau ternyata dia sebenarnya PUNYA
      // daftar tag pending (cuma gak reply pesannya), kasih tau caranya
      // biar gak bingung kenapa gak ada respons sama sekali.
      if (session?.pendingTagChoices) {
        await sock.sendMessage(jid, {
          text: tr("tag.pending"),
        });
        return;
      }
    }

    // =====================
    // !meme <teks>  -> KHUSUS GIF/video jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!meme" || text.startsWith("!meme ")) {
      const memeText = text.slice(5).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "meme", lang);
        return;
      }

      const source = findGifSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "meme", lang);
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        const gifBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const stickerBuffer = await gifToTextSticker(gifBuffer, memeText);

        // isAnimated WAJIB diisi manual -- Baileys TIDAK auto-deteksi dari
        // isi buffer webp-nya. Kalau ini kelewat, reply ke stiker ini nanti
        // (mis. lewat !smeme) bakal salah dianggap "gambar diam" oleh
        // isStillMedia(), yang berakibat fps/durasi GAK dipangkas sama
        // sekali pas di-render ulang -> ukurannya meledak jauh di atas
        // limit WA. !meme sumbernya selalu GIF/video (lihat findGifSource),
        // jadi selalu animasi.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: true,
        }, { quoted: msg });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("sticker.failed", { err: err.message || "" }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !smeme <teks>  -> KHUSUS stiker (emote)/foto jadi stiker bertext.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!smeme" || text.startsWith("!smeme ")) {
      const memeText = text.slice(7).trim();

      if (!memeText) {
        await sendCommandDetail(sock, jid, "smeme", lang);
        return;
      }

      const source = findStickerSource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "smeme", lang);
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await gifToTextSticker(
          mediaBuffer,
          memeText,
          isStill,
        );

        // Sama kayak di !meme: isAnimated wajib diisi manual sesuai hasil
        // deteksi sumbernya sendiri, biar kalau stiker INI di-reply lagi
        // nanti, klasifikasinya benar (lihat komentar di !meme).
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        }, { quoted: msg });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("sticker.failed", { err: err.message || "" }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !s  -> GIF/video/stiker(emote)/foto jadi stiker polos, TANPA teks.
    // Ini tetap generik (nerima semua jenis media), karena tujuannya
    // cuma bikin stiker biasa tanpa teks, bukan soal animasi vs statis.
    // Bisa dari caption langsung di medianya, atau reply ke medianya.
    // =====================
    if (text === "!s") {
      const source = findAnySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "s", lang);
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        const mediaBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const isStill = isStillMedia(source.content);
        const stickerBuffer = await mediaToSticker(mediaBuffer, isStill);

        // Sama kayak di !meme/!smeme -- isAnimated wajib diisi manual.
        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: !isStill,
        }, { quoted: msg });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("sticker.failed", { err: err.message || "" }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !sbrat <teks>  (alias: .sbrat <teks>)
    // Stiker gaya BRAT (background putih, teks hitam lowercase font
    // sempit, justify, efek blur/fried -- metode diport dari brat-generator)
    // dibuat MURNI dari teks -- beda dari !meme/!smeme/!s yang
    // semuanya butuh sumber media (GIF/video/stiker/foto). Logic render-
    // nya ada di bratSticker.js.
    // =====================
    if (
      text === "!sbrat" ||
      text.startsWith("!sbrat ") ||
      text === ".sbrat" ||
      text.startsWith(".sbrat ")
    ) {
      // "!sbrat" dan ".sbrat" sama-sama 6 karakter, jadi slice(6) berlaku
      // buat kedua prefix tanpa perlu dicabang.
      const bratText = text.slice(6).trim();

      if (!bratText) {
        await sendCommandDetail(sock, jid, "sbrat", lang);
        return;
      }

      if (bratText.length > BRAT_MAX_CHARS) {
        await sock.sendMessage(jid, {
          text: tr("sbrat.tooLong", { len: bratText.length, max: BRAT_MAX_CHARS }),
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        const stickerBuffer = await textToBratSticker(bratText);

        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: false,
        }, { quoted: msg });
      } catch (err) {
        console.log("=== [sbrat] gagal ===");
        console.log(err.message || err);
        console.log("=====================");
        await sock.sendMessage(jid, {
          text: tr("sbrat.failed", { err: err.message || tr("sbrat.renderError") }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !gifbrat <teks>  (alias: .gifbrat <teks>)
    // GIF animasi gaya BRAT yang "mengetik" per kata: tiap kata baru muncul,
    // layout brat dihitung ulang (font mengecil, wrap + justify), frame
    // terakhir = hasil akhir yang sama dengan !sbrat. Dikirim langsung
    // sebagai STIKER animasi (WebP).
    // Logic render-nya ada di bratGif.js.
    // =====================
    if (
      text === "!gifbrat" ||
      text.startsWith("!gifbrat ") ||
      text === ".gifbrat" ||
      text.startsWith(".gifbrat ")
    ) {
      // "!gifbrat" dan ".gifbrat" sama-sama 8 karakter.
      const gifBratText = text.slice(8).trim();

      if (!gifBratText) {
        await sendCommandDetail(sock, jid, "gifbrat", lang);
        return;
      }

      if (gifBratText.length > BRATGIF_MAX_CHARS) {
        await sock.sendMessage(jid, {
          text: tr("gifbrat.tooLong", {
            len: gifBratText.length,
            max: BRATGIF_MAX_CHARS,
          }),
        });
        return;
      }

      const gifBratWords = countBratGifWords(gifBratText);
      if (gifBratWords > BRATGIF_MAX_WORDS) {
        await sock.sendMessage(jid, {
          text: tr("gifbrat.tooManyWords", {
            count: gifBratWords,
            max: BRATGIF_MAX_WORDS,
          }),
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        const gifBratSticker = await textToBratGifSticker(gifBratText);

        // isAnimated wajib diisi manual (sama kayak !s / !meme).
        await sock.sendMessage(jid, {
          sticker: gifBratSticker,
          isAnimated: true,
        }, { quoted: msg });
      } catch (err) {
        console.log("=== [gifbrat] gagal ===");
        console.log(err.message || err);
        console.log("=======================");
        await sock.sendMessage(jid, {
          text: tr("gifbrat.failed", {
            err: err.message || tr("sbrat.renderError"),
          }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !schat Nama|Pesan|badge  -> stiker "dialog chat" ala screenshot
    // WhatsApp (avatar bulat + nama pengirim + bubble pesan). Bagian
    // "badge" opsional (mis. emoji kecil di sebelah nama).
    //
    // Render-nya MURNI dari teks (Canvas, lihat dialogSticker.js --
    // diport dari prototype dialog-sticker-generator.html) -- avatar
    // OPSIONAL, dipakai kalau ada gambar/stiker yang di-reply atau
    // dikirim bareng caption "!schat ..."; kalau enggak ada, fallback ke
    // lingkaran warna + huruf awal nama.
    // =====================
    if (text === "!schat" || text.startsWith("!schat ")) {
      const raw = text.slice(6).trim();
      const parts = raw.split("|").map((s) => s.trim());
      const senderName = parts[0] || "";
      const chatMessage = parts[1] || "";
      const badge = parts[2] || "";

      if (!senderName || !chatMessage) {
        await sendCommandDetail(sock, jid, "schat", lang);
        return;
      }

      if (senderName.length > SCHAT_MAX_NAME_CHARS) {
        await sock.sendMessage(jid, {
          text: tr("schat.nameTooLong", { max: SCHAT_MAX_NAME_CHARS }),
        });
        return;
      }

      if (chatMessage.length > SCHAT_MAX_MESSAGE_CHARS) {
        await sock.sendMessage(jid, {
          text: tr("schat.msgTooLong", { len: chatMessage.length, max: SCHAT_MAX_MESSAGE_CHARS }),
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("sticker.making") }, { quoted: msg });

        // Avatar -- 3 sumber, dicoba berurutan sampai ada yang berhasil:
        //   1. Gambar/stiker yang di-reply atau dikirim bareng caption-nya
        //      (matcher sama seperti !smeme).
        //   2. Foto profil WA -- punya orang yang di-reply/di-tag, atau
        //      punya pengirim command sendiri kalau gak reply/tag siapa2
        //      (lihat resolveSchatAvatarJid).
        //   3. Kalau semua gagal (mis. privasi pp-nya ditutup): fallback
        //      ke lingkaran warna + huruf awal nama di dalam
        //      textToDialogSticker sendiri.
        const avatarSource = findStickerSource(msg);
        let avatarBuffer = null;

        if (avatarSource) {
          try {
            avatarBuffer = await downloadGifBuffer(
              avatarSource.content,
              avatarSource.refKey,
            );
          } catch (err) {
            console.log("⚠️ Gagal download avatar buat !schat, coba fallback pp:", err.message);
          }
        }

        // Jid ini dipakai DUA KALI: buat fallback pp (di bawah) DAN buat
        // resolveSchatDisplayName (gantiin "@<ID mentah>" di field Nama
        // jadi nama asli kalau field itu ternyata hasil nge-tag lewat
        // @mention WA -- lihat komentarnya di atas).
        const avatarJid = resolveSchatAvatarJid(msg, getSenderJid(msg));

        if (!avatarBuffer) {
          avatarBuffer = await fetchProfilePictureBuffer(sock, avatarJid);
        }

        const displayName = resolveSchatDisplayName(senderName, msg, avatarJid);

        const stickerBuffer = await textToDialogSticker({
          avatarBuffer,
          senderName: displayName,
          badge,
          message: chatMessage,
          randomNameColor: !avatarBuffer, // biar variatif kalau avatar-nya fallback ke lingkaran huruf
        });

        await sock.sendMessage(jid, {
          sticker: stickerBuffer,
          isAnimated: false,
        }, { quoted: msg });
      } catch (err) {
        console.log("=== [schat] gagal ===");
        console.log(err.message || err);
        console.log("=====================");
        await sock.sendMessage(jid, {
          text: tr("schat.failed", { err: err.message || tr("schat.renderError") }),
        }, { quoted: msg });
      }

      return;
    }

    // =====================
    // !togif  -> stiker ANIMASI jadi "GIF" (dikirim sbg video+gifPlayback,
    // karena WhatsApp memang selalu begitu buat GIF).
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!togif") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "togif", lang);
        return;
      }

      if (!source.content.stickerMessage.isAnimated) {
        await sock.sendMessage(jid, {
          text: tr("togif.notAnimated"),
        });
        return;
      }

      try {
        await sock.sendMessage(jid, { text: tr("gif.making") });

        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const gifVideoBuffer = await animatedStickerToGifVideo(stickerBuffer);

        await sock.sendMessage(jid, {
          video: gifVideoBuffer,
          gifPlayback: true,
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("togif.failed", { err: err.message || "" }),
        });
      }

      return;
    }

    // =====================
    // !toimg  -> stiker (biasa/statis, atau animasi -> ambil frame
    // pertamanya) jadi gambar biasa.
    // Bisa dari caption langsung di stikernya, atau reply ke stikernya.
    // =====================
    if (text === "!toimg") {
      const source = findStickerOnlySource(msg);

      if (!source) {
        await sendCommandDetail(sock, jid, "toimg", lang);
        return;
      }

      try {
        const stickerBuffer = await downloadGifBuffer(
          source.content,
          source.refKey,
        );
        const imageBuffer = await stickerToImageBuffer(stickerBuffer);

        await sock.sendMessage(jid, { image: imageBuffer });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("toimg.failed", { err: err.message || "" }),
        });
      }

      return;
    }

    // =====================
    // !img <tag>
    // =====================
    if (text === "!img" || text.startsWith("!img ")) {
      // Jumlah gambar opsional di akhir: "!img special week #8"
      const parsedImg = parseCountArg(text.slice(4));
      let tag = parsedImg.rest;
      const imgCount = parsedImg.count;

      if (!tag) {
        await sendCommandDetail(sock, jid, "img", lang);
        return;
      }

      if (parsedImg.clamped) {
        await sock.sendMessage(jid, {
          text: tr("batch.clamped", { max: imgCount }),
        });
      }

      // Input bukan gaya tag Safebooru (mis. "special week silence suzuka")
      // -> pakai alur fleksibel: cari tag yang cocok, tampilkan pilihan.
      if (!isAllExplicit(tag)) {
        try {
          const built = await buildSlots(tag);

          if (!built.ok) {
            await sock.sendMessage(jid, {
              text: built.tooMany
                ? tr("img.tooManyWords")
                : tr("img.wordNotFound", { word: built.failedWord }),
            });
            return;
          }

          await runTagFlow({
            slots: built.slots,
            picked: [],
            asked: 0,
            askTotal: countAskable(built.slots),
            count: imgCount,
          });
        } catch (err) {
          console.log(err);
          await sock.sendMessage(jid, {
            text: errorReplyText(err, lang),
          });
        }
        return;
      }

      // Alur lama (semua sudah berupa tag asli): koma gak dipakai di Safebooru.
      tag = tag.replace(/,/g, " ").replace(/\s+/g, " ").trim();

      try {
        const directSession = newCandidateSession(tag);
        const hasDirectHit = await loadMoreCandidates(directSession);

        if (hasDirectHit) {
          await sendImageBatch(
            sock,
            jid,
            sessionKey,
            tag,
            directSession,
            lang,
            imgCount,
          );
          return;
        }

        // Tag persis tidak ketemu -> cari tag-tag serupa untuk dipilih
        const matches = await fetchMatchingTags(tag);

        if (matches.length === 0) {
          await sock.sendMessage(jid, {
            text: tr("img.notFound"),
          });
          return;
        }

        if (matches.length === 1) {
          // cuma ada 1 kandidat, langsung pakai tanpa nanya
          const onlySession = newCandidateSession(matches[0].name);
          const hasOnly = await loadMoreCandidates(onlySession);

          if (!hasOnly) {
            await sock.sendMessage(jid, {
              text: tr("img.notFound"),
            });
            return;
          }

          await sendImageBatch(
            sock,
            jid,
            sessionKey,
            matches[0].name,
            onlySession,
            lang,
            imgCount,
          );
          return;
        }

        const pendingSession = touchSession({
          pendingTagChoices: matches,
          pendingCount: imgCount,
        });
        sessions.set(sessionKey, pendingSession);

        const sentMsg = await sock.sendMessage(jid, {
          text: buildTagChoiceList(matches, lang),
        });
        // Simpan ID pesan daftar tag ini, dipakai buat mastiin nanti angka
        // balasan BENERAN nge-reply pesan ini (bukan sekadar ketik angka
        // polos) -- lihat pengecekan `ctx.stanzaId` di handler balasan
        // angka. Ini yang bikin gak bentrok sama kode sesi (!next pakai
        // angka juga, tapi tanpa reply).
        pendingSession.promptMsgId = sentMsg?.key?.id || null;
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err, lang),
        });
      }

      return;
    }

    // =====================
    // !gif <keyword>  -> cari GIF (Tenor diutamakan, fallback GIPHY) berdasarkan
    // keyword, lalu kirim 1 hasil RANDOM ke chat sbg video+gifPlayback
    // (WhatsApp gak pernah kirim file .gif mentah, selalu video mp4 + flag
    // ini -- sama kayak !togif, lihat juga catatan panjang soal ini di
    // src/features/gif/gifService.js).
    //
    // SEKARANG numpang sama mekanisme session/"!next"/kode-sesi yang
    // dipakai !img/!pin (lihat searchAndSendImage, refillPool, &
    // newGifSession/loadMoreGifCandidates di gifService.js) -- bedanya
    // cuma sumber datanya & cara download hasil akhirnya (video, bukan
    // image). Kode sesinya tetap di-scope PER-PENGIRIM (sessionKey =
    // getSessionKey(msg), sama kayak !img/!pin) untuk pemiliknya, dan
    // PER-CHAT (chatCodeSessions) untuk siapa pun di grup yang mau lanjut
    // pakai kodenya.
    //
    // Regex dipakai (bukan text.slice() polos kayak !pin) supaya
    // case-insensitive (poin 11 spesifikasi: "!GIF Special Week Uma"
    // tetap harus jalan) tanpa perlu bikin SELURUH command lain di file
    // ini jadi case-insensitive juga.
    // =====================
    const gifMatch = /^!gif(?:\s+(.*))?$/i.exec(text);
    if (gifMatch) {
      const keyword = (gifMatch[1] || "").trim().replace(/\s+/g, " ");

      if (!keyword) {
        await sendCommandDetail(sock, jid, "gif", lang);
        return;
      }

      try {
        const gifSession = newGifSession(keyword);
        const hasHit = await loadMoreGifCandidates(gifSession);

        if (!hasHit) {
          await sock.sendMessage(jid, {
            text: tr("gif.notFound"),
          });
          return;
        }

        await searchAndSendImage(sock, jid, sessionKey, keyword, gifSession, lang);
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text:
            err instanceof NoGifFoundError
              ? tr(err.i18nKey || "gif.providerFail")
              : errorReplyText(err, lang),
        });
      }

      return;
    }

    // =====================
    // !pin <keyword>  -> cari gambar di Pinterest berdasarkan keyword.
    // Numpang sama mekanisme session/"!next"/kode-sesi yang dipakai !img
    // (lihat searchAndSendImage & sessionLabel) -- bedanya cuma sumber
    // datanya (lihat komentar panjang di newPinterestSession/
    // fetchPinterestPage soal caranya).
    // =====================
    if (text === "!pin" || text.startsWith("!pin ")) {
      // Jumlah gambar opsional di akhir: "!pin special week #8"
      const parsedPin = parseCountArg(text.slice(4));
      const keyword = parsedPin.rest;

      if (!keyword) {
        await sendCommandDetail(sock, jid, "pin", lang);
        return;
      }

      if (parsedPin.clamped) {
        await sock.sendMessage(jid, {
          text: tr("batch.clamped", { max: parsedPin.count }),
        });
      }

      try {
        const pinSession = newPinterestSession(keyword);
        const hasHit = await loadMorePinterestCandidates(pinSession);

        if (!hasHit) {
          await sock.sendMessage(jid, {
            text: tr("pin.notFound"),
          });
          return;
        }

        await sendImageBatch(
          sock,
          jid,
          sessionKey,
          keyword,
          pinSession,
          lang,
          parsedPin.count,
        );
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err, lang),
        });
      }

      return;
    }

    // =====================
    // !pixiv <keyword> [#jumlah]  -> cari ilustrasi di Pixiv (MODE AMAN).
    // Sama persis polanya dengan !pin: numpang session/"!next"/kode-sesi
    // dan mendukung multi result lewat "#N" di akhir (maks IMG_BATCH_MAX).
    // Regex dipakai biar case-insensitive ("!Pixiv ..." tetap jalan).
    // Konten dewasa disaring berlapis -- lihat features/pixiv/pixiv.js.
    // =====================
    const pixivMatch = /^!pixiv(?:\s+([\s\S]*))?$/i.exec(text);
    if (pixivMatch) {
      const parsedPixiv = parseCountArg(pixivMatch[1] || "");
      const keyword = parsedPixiv.rest.replace(/\s+/g, " ").trim();

      if (!keyword) {
        await sendCommandDetail(sock, jid, "pixiv", lang);
        return;
      }

      if (isPixivQueryBlocked(keyword)) {
        await sock.sendMessage(jid, { text: tr("pixiv.blocked") });
        return;
      }

      if (parsedPixiv.clamped) {
        await sock.sendMessage(jid, {
          text: tr("batch.clamped", { max: parsedPixiv.count }),
        });
      }

      try {
        const pixivSession = newPixivSession(keyword);
        const hasHit = await loadMorePixivCandidates(pixivSession);

        if (!hasHit) {
          await sock.sendMessage(jid, { text: tr("pixiv.notFound") });
          return;
        }

        await sendImageBatch(
          sock,
          jid,
          sessionKey,
          keyword,
          pixivSession,
          lang,
          parsedPixiv.count,
        );
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err, lang),
        });
      }

      return;
    }

    // =====================
    // !next
    // =====================
    if (text === "!next") {
      const session = sessions.get(sessionKey);

      // Kalau pengirim baru saja buka daftar !semua (dan sesi gambarnya lebih
      // lama / tidak ada), !next = halaman berikutnya daftar kripto itu.
      if (await handleKriptoNext(sock, msg, { jid, lang, otherSessionAt: session?.lastUsed || 0 })) return;

      if (!session) {
        await sendCommandDetail(sock, jid, "next", lang);
        return;
      }

      touchSession(session);

      try {
        const ok = await refillPool(session);

        if (!ok) {
          await sock.sendMessage(jid, {
            text: tr("tag.noMore"),
          });
          return;
        }

        if (session.source === "gif") {
          // Otomatis coba item LAIN di pool kalau yang kepilih random
          // gagal diproses (lihat komentar panjang di downloadGifFromPool,
          // gifService.js) -- jadi pick + download digabung, bukan
          // pickRandom() lalu downloadGifPost() 1x kayak sebelumnya.
          const { buffer, post } = await downloadGifFromPool(
            session,
            pickRandom,
          );
          session.lastId = post.id;

          const karakterLabel = sessionLabel(session);
          const caption = buildCaption(post, karakterLabel, {
            lang,
            isNext: true,
            code: session.code,
            source: session.source,
          });

          await sock.sendMessage(jid, { video: buffer, gifPlayback: true, caption });
        } else {
          const post = pickRandom(session);
          session.lastId = post.id;

          const karakterLabel = sessionLabel(session);
          const caption = buildCaption(post, karakterLabel, {
            lang,
            isNext: true,
            code: session.code,
            source: session.source,
          });

          const buffer = await downloadImage(post.file_url);
          await sock.sendMessage(jid, { image: buffer, caption });
        }
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: errorReplyText(err, lang),
        });
      }

      return;
    }

    // =====================
    // !id <kode>
    // =====================
    if (text === "!id" || text.startsWith("!id ")) {
      const id = text.slice(3).trim();

      if (!id || !/^\d+$/.test(id)) {
        await sendCommandDetail(sock, jid, "id", lang);
        return;
      }

      try {
        const post = await fetchById(id);

        if (!post) {
          await sock.sendMessage(jid, {
            text: tr("id.notFound"),
          });
          return;
        }

        const buffer = await downloadImage(post.file_url);

        await sock.sendMessage(jid, {
          image: buffer,
          caption: buildCaption(post, "-", { lang }),
        });
      } catch (err) {
        console.log(err);
        await sock.sendMessage(jid, {
          text: tr("common.error"),
        });
      }

      return;
    }

    // =====================
    // !dlstatus -- cek status backoff rate-limit YouTube langsung dari
    // WhatsApp, gak perlu buka Railway Logs buat tau kondisinya.
    // =====================
    if (text === "!dlstatus") {
      const remainingMs = getYtdlpBackoffRemainingMs();
      if (remainingMs > 0) {
        await sock.sendMessage(jid, {
          text: tr("dlstatus.backoff", { time: formatDurationId(remainingMs, lang) }),
        });
      } else {
        await sock.sendMessage(jid, {
          text: tr("dlstatus.ok"),
        });
      }
      return;
    }

    // =====================
    // !dl <link> [mp3|mp4|144p|...|2160p] [doc|video]
    // =====================
    if (text === "!dl" || text.startsWith("!dl ")) {
      const rest = text.slice(3).trim();
      const target = resolveDlTarget(msg, rest);

      if (!target.url) {
        if (target.noLinkInReply) {
          await sock.sendMessage(jid, { text: tr("dl.noLinkInReply") }, { quoted: msg });
        } else {
          await sendCommandDetail(sock, jid, "dl", lang);
        }
        return;
      }

      let url = target.url;
      // Sisa teks setelah link (kalau ada) dipakai buat override format,
      // mis. "!dl <link> mp3" atau "!dl <link> 480p" -- biar gak perlu
      // balas angka lagi. Kalau link diambil dari reply, seluruh teks
      // setelah "!dl" yang jadi hint.
      let hint = target.hint;

      // Pilihan cara kirim: "doc"/"dokumen"/"file" -> paksa dokumen,
      // "video"/"vid" -> paksa video biasa. Tanpa keduanya = "auto"
      // (video biasa, otomatis dokumen kalau > ~90MB). Kata ini dibuang
      // dari hint supaya parsing mp3/resolusi/thread di bawah tidak berubah,
      // jadi urutannya bebas: "1080p doc" atau "doc 1080p" sama saja.
      let sendAs = "auto";
      {
        const kept = [];
        for (const tok of hint.split(/\s+/).filter(Boolean)) {
          if (/^(doc|document|dokumen|file)$/.test(tok)) sendAs = "doc";
          else if (/^(video|vid)$/.test(tok)) sendAs = "video";
          else kept.push(tok);
        }
        hint = kept.join(" ");
      }

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: tr("dl.invalidLink") });
        return;
      }

      // Link "Bagikan" Threads (/share/XXXX) diubah dulu ke link post asli.
      url = await resolveThreadsShareUrl(url);

      // "144p"/"240"/"360p"/dst -- angka "p"-nya opsional. Cuma dipakai
      // buat mode video; kalau hint-nya "mp3"/"audio" itu ditangani
      // terpisah di bawah dan maxHeight-nya diabaikan (gak relevan buat
      // audio).
      const heightMatch = hint.match(/^(\d{2,4})p?$/);
      const requestedHeight = heightMatch ? Number(heightMatch[1]) : null;
      const maxHeight = DL_ALLOWED_HEIGHTS.includes(requestedHeight)
        ? requestedHeight
        : undefined;

      // Link YouTube ikut alur sama seperti situs lain -- argumen khusus
      // (client rotation, force-ipv4, dst) ditangani otomatis di dalam
      // downloadMediaFromUrl(), gak perlu logic tambahan di sini.
      const mode = hint === "mp3" || hint === "audio" ? "audio" : "video";

      // Thread: "!dl <link> thread" (X/Twitter, dst) atau link Threads
      // (threads.net / threads.com) otomatis -- ambil semua teks + media
      // satu thread, lihat features/download/thread.js.
      if (hint === "thread" || (isThreadsUrl(url) && mode === "video")) {
        await handleDlThread(sock, jid, url, msg, lang);
        return;
      }

      if (heightMatch && !maxHeight) {
        await sock.sendMessage(jid, {
          text: tr("dl.badHeight", {
            hint,
            list: DL_ALLOWED_HEIGHTS.join("p, ") + "p",
          }),
        });
      }

      await handleDlDownload(sock, jid, url, mode, maxHeight, msg, lang, sendAs);
      return;
    }

    // =====================
    // !dlt <link> -- download thread (teks + semua media), alias
    // "!dl <link> thread".
    // =====================
    if (text === "!dlt" || text.startsWith("!dlt ")) {
      const rest = text.slice(4).trim();
      const target = resolveDlTarget(msg, rest);

      if (!target.url) {
        if (target.noLinkInReply) {
          await sock.sendMessage(jid, { text: tr("dl.noLinkInReply") }, { quoted: msg });
        } else {
          await sendCommandDetail(sock, jid, "dlt", lang);
        }
        return;
      }

      let url = target.url;

      try {
        new URL(url);
      } catch {
        await sock.sendMessage(jid, { text: tr("dl.invalidLink") });
        return;
      }

      url = await resolveThreadsShareUrl(url);
      await handleDlThread(sock, jid, url, msg, lang);
      return;
    }

    // =====================
    // !dlr <link> -- khusus foto/carousel/slideshow (Instagram carousel,
    // TikTok mode foto+musik). Beda dari "!dl": langsung ambil jalur foto
    // tanpa nyoba video dulu.
    // =====================
    if (text === "!dlr" || text.startsWith("!dlr ")) {
      const rest = text.slice(4).trim();
      const target = resolveDlTarget(msg, rest);

      if (!target.url) {
        if (target.noLinkInReply) {
          await sock.sendMessage(jid, { text: tr("dl.noLinkInReply") }, { quoted: msg });
        } else {
          await sendCommandDetail(sock, jid, "dlr", lang);
        }
        return;
      }

      let url = target.url;

      try {
        new URL(url); // validasi cepat, lempar kalau bukan URL valid
      } catch {
        await sock.sendMessage(jid, { text: tr("dl.invalidLink") });
        return;
      }

      url = await resolveThreadsShareUrl(url);
      await handleDlrDownload(sock, jid, url, msg, lang);
      return;
    }

    // =====================
    // AgemasenBot -- Chat AI Tsundere (Groq)
    //
    // Semua logic-nya ada di agemasenTsundere.js. handleTsundereChat sendiri
    // yang ngecek apakah bot di-tag & teksnya bukan command "!..." --
    // return true kalau pesan ini sudah ditangani (berarti kita return di
    // sini juga), false kalau tidak relevan (lanjut ke pengecekan bawah).
    // =====================
    if (await handleTsundereChat(sock, msg, { jid, text, sessionKey: tsundereSessionKey, lang })) {
      return;
    }

    // =====================
    // Command tidak dikenal (mis. salah ketik "!ing", "!imgg", dst).
    // Cuma dicek kalau memang diawali "!" -- teks biasa (bukan niat jadi
    // command) dibiarkan lewat tanpa respons.
    // =====================
    if (text.startsWith("!")) {
      await sock.sendMessage(jid, {
        text: tr("common.unknownCommand"),
      });
    }
}

module.exports = { handleMessagesUpsert };
// gggggggg