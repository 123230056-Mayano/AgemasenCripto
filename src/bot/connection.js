const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const P = require("pino");

const { handleMessagesUpsert } = require("./router");
const { installHumanizer } = require("../utils/humanize");
const { setSocket, startStatsServer } = require("../features/stats/stats");
const { setAlertSocket } = require("../features/kripto/alertMonitor");
const { initSubscriptions } = require("../state/subscriptionStore");
const { initLanguageStore } = require("../state/languageStore");
const session = require("../state/sessionState");
const {
  startChatRegistry,
  scheduleSync,
  botInParticipants,
} = require("../state/chatRegistry");

// Folder sesi login WhatsApp. Di Railway biasanya di-mount sebagai Volume.
const AUTH_DIR = process.env.AUTH_DIR || "auth_info";

// QR tetap dicetak ke terminal HANYA kalau dashboard web tidak aktif
// (STATS_TOKEN kosong) atau dipaksa lewat QR_TERMINAL=1.
const PRINT_QR_IN_TERMINAL = !process.env.STATS_TOKEN || process.env.QR_TERMINAL === "1";

// Backoff reconnect: 3s -> 6s -> 12s ... maks 60s (+ jitter acak), reset saat tersambung.
let reconnectAttempts = 0;

// Socket yang AKTIF saat ini. Event dari socket lama (yang sudah diganti saat
// restart/reset sesi) diabaikan supaya tidak membuat koneksi ganda.
let currentSock = null;
let reconnectTimer = null;

function scheduleStart(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    startBot().catch((err) => {
      console.error("[bot] startBot gagal:", err);
      scheduleStart(10_000);
    });
  }, delayMs);
}

// Hapus ISI folder sesi (bukan foldernya) -- kalau folder ini Volume Railway,
// folder mount-nya sendiri tidak bisa dihapus.
function wipeAuthDir() {
  try {
    for (const name of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[session] gagal hapus sesi:", err.message);
  }
}

// Dipanggil dari dashboard web (POST /session).
//   wipe=false -> sambungkan ulang memakai sesi yang ada
//   wipe=true  -> hapus sesi login & minta QR baru (ganti nomor / relogin)
async function restartSession({ wipe = false } = {}) {
  clearTimeout(reconnectTimer);
  const old = currentSock;
  currentSock = null; // event close dari socket lama jadi diabaikan
  try { old?.end(undefined); } catch { /* sudah tertutup */ }
  await new Promise((r) => setTimeout(r, 800));
  if (wipe) wipeAuthDir();
  reconnectAttempts = 0;
  session.setStarting();
  scheduleStart(200);
}

async function startBot() {
  console.log("Starting bot...");
  session.setStarting();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Always negotiate the latest supported WA Web version.
  // Skipping this is one of the most common causes of bots that
  // connect then immediately close with a 405/restartRequired loop.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    // level "warn" supaya error dekripsi pesan (message gagal didecrypt
    // sehingga tidak pernah sampai ke bot) kelihatan di log.
    logger: P({ level: process.env.BAILEYS_LOG_LEVEL || "warn" }),
    browser: ["Ubuntu", "Chrome", "20.04.4"],
    printQRInTerminal: false,
    // Jangan tampil "online" terus-menerus & jangan tarik riwayat penuh:
    // lebih mirip klien biasa dan mengurangi beban/permintaan ke server WA.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  currentSock = sock;

  // Semua sendMessage lewat antrean + jeda acak + typing indicator + batas per menit.
  installHumanizer(sock);

  setSocket(sock);
  setAlertSocket(sock); // alert harga/level & ringkasan harian (kripto Bagian 5)
  initSubscriptions();
  initLanguageStore();
  startChatRegistry(sock);
  startStatsServer();

  sock.ev.on("creds.update", () => {
    // Socket lama tidak boleh menimpa sesi yang baru saja dihapus/diganti.
    if (sock === currentSock) saveCreds();
  });

  sock.ev.on("connection.update", (update) => {
    if (sock !== currentSock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Simpan untuk dashboard web; QR berganti otomatis tiap ~20 detik.
      session.setQr(qr);
      if (PRINT_QR_IN_TERMINAL) {
        const qrcode = require("qrcode-terminal");
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === "connecting") session.setConnecting();

    if (connection === "open") {
      console.log("✅ Bot Connected!");
      reconnectAttempts = 0;
      const id = String(sock.user?.id || "");
      session.setConnected(id ? id.split(":")[0].split("@")[0] : null);
      // Tarik semua grup tempat bot berada -> simpan ke Supabase.
      scheduleSync(3000);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Sesi dicabut (mis. "Log out" dari Perangkat Tertaut di HP): hapus sesi
      // lama & mulai lagi supaya QR baru langsung muncul di dashboard web,
      // tanpa perlu menjalankan ulang `node index.js`.
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("Logged out dari WhatsApp. Sesi dihapus, membuat QR baru...");
        session.setLoggedOut();
        wipeAuthDir();
        reconnectAttempts = 0;
        scheduleStart(2000);
        return;
      }

      // connectionReplaced (440) = ada sesi lain memakai akun ini. Reconnect
      // berulang di kasus ini mencurigakan -> berhenti; bisa dimulai lagi
      // manual lewat tombol di dashboard.
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log("Connection replaced (440). Tidak reconnect otomatis.");
        session.setReplaced();
        return;
      }

      session.setClosed(statusCode ?? "unknown");

      // Belum pernah login (masih tahap scan QR): QR kedaluwarsa (408) itu
      // normal -> buat QR baru cepat, jangan pakai backoff panjang.
      const waitingForScan = !state.creds?.registered;
      let delay;
      if (waitingForScan) {
        delay = 1500;
      } else {
        delay =
          Math.min(60000, 3000 * 2 ** reconnectAttempts) +
          Math.floor(Math.random() * 2000);
        reconnectAttempts++;
      }
      console.log(
        `Connection closed (code: ${statusCode ?? "unknown"}). Reconnect dalam ${Math.round(delay / 1000)}s` +
          (waitingForScan ? " (menunggu scan QR)" : ` (percobaan ke-${reconnectAttempts})`),
      );
      scheduleStart(delay);
    }
  });

  // Sinkron daftar grup ke Supabase saat bot masuk/keluar grup atau nama
  // grup berubah. Di-debounce, dan event anggota hanya dihitung kalau yang
  // masuk/keluar adalah bot sendiri (bukan tiap anggota biasa).
  sock.ev.on("groups.upsert", () => scheduleSync());
  sock.ev.on("groups.update", () => scheduleSync(30 * 1000));
  sock.ev.on("group-participants.update", (ev) => {
    if (
      (ev.action === "add" || ev.action === "remove") &&
      botInParticipants(sock, ev.participants)
    ) {
      scheduleSync();
    }
  });

  // PENTING: bungkus dengan .catch(). handleMessagesUpsert itu async function --
  // kalau ada error yang gak ketangkep try/catch di dalam salah satu command
  // (router.js/features/*), promise-nya bakal reject. Tanpa .catch() di sini,
  // itu jadi "unhandled rejection" yang bisa MEMATIKAN SELURUH PROSES bot
  // (default Node.js sejak v15) -- efeknya command user lain yang lagi
  // diproses BARENGAN ikut keputus tanpa sempat kekirim balasannya, padahal
  // command dia sendiri gak ada masalah. Dengan .catch() di sini, error dari
  // satu pesan cuma di-log dan gak ganggu pemrosesan pesan/user lain.
  sock.ev.on("messages.upsert", (payload) => {
    handleMessagesUpsert(sock, payload).catch((err) => {
      console.error("[messages.upsert] Unhandled error saat proses pesan:", err);
    });
  });
}

module.exports = { startBot, restartSession };
