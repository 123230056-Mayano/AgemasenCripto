const os = require("os");
const axios = require("axios");
const { jidNormalizedUser } = require("@whiskeysockets/baileys");
const { isBotDisabledFor } = require("../../state/botState");
const { getCachedName } = require("../../state/nameCache");
const { getKnownUsers } = require("../../state/userState");
const { t } = require("../../i18n");

const BOT_STARTED_AT = Date.now();

// Batas jumlah anggota yang di-subscribe presence-nya sekaligus. Subscribe
// ratusan nomor beruntun itu pola yang mirip spam ke server WhatsApp dan
// berisiko bikin akun bot kena limit/ban, jadi dibatasi.
const ONLINE_MAX_MEMBERS = 100;
const ONLINE_WAIT_MS = 8000;
const ONLINE_COOLDOWN_MS = 60 * 1000;
const lastOnlineCheck = new Map(); // jid grup -> timestamp

function fmtDuration(ms, lang) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(t(lang, "dur.d", { n: d }));
  if (h) parts.push(t(lang, "dur.h", { n: h }));
  parts.push(t(lang, "dur.m", { n: m }));
  return parts.join(" ");
}

function fmtDate(unixSeconds, lang) {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleDateString(lang === "en" ? "en-GB" : "id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });
}

function safeNormalize(jid) {
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

// Nama tampilan: pushName dari cache kalau ada, kalau nggak nomornya.
// Peserta berbentuk @lid tidak punya nomor yang bisa ditampilkan.
function displayName(p, lang) {
  const pn = p.phoneNumber || (p.id.endsWith("@s.whatsapp.net") ? p.id : null);
  const cached = getCachedName(safeNormalize(p.id)) || (pn && getCachedName(safeNormalize(pn)));
  if (cached) return cached;
  if (pn) return "+" + pn.split("@")[0];
  return t(lang, "common.hiddenMember");
}

// ---------------------------------------------------------------
// !groupinfo -- nama, jumlah anggota, admin, dst. Hanya di grup.
// ---------------------------------------------------------------
async function handleGroupInfoCommand(sock, msg, { jid, text, lang }) {
  const cmd = text.trim().toLowerCase();
  if (cmd !== "!groupinfo" && cmd !== "!infogrup") return false;

  if (!jid.endsWith("@g.us")) {
    await sock.sendMessage(jid, { text: t(lang, "common.onlyInGroup") });
    return true;
  }

  try {
    const meta = await sock.groupMetadata(jid);
    const participants = meta.participants || [];
    const admins = participants.filter((p) => p.admin === "admin" || p.admin === "superadmin");
    const superadmin = participants.find((p) => p.admin === "superadmin");

    const lines = [
      t(lang, "groupinfo.title"),
      ``,
      t(lang, "groupinfo.name", { v: meta.subject || t(lang, "common.noName") }),
      t(lang, "groupinfo.members", { v: participants.length }),
      t(lang, "groupinfo.admins", { v: admins.length }),
      t(lang, "groupinfo.creator", { v: superadmin ? displayName(superadmin, lang) : "-" }),
      t(lang, "groupinfo.created", { v: fmtDate(meta.creation, lang) }),
      t(lang, "groupinfo.whoCanSend", {
        v: t(lang, meta.announce ? "groupinfo.adminsOnly" : "groupinfo.everyone"),
      }),
      t(lang, "groupinfo.botHere", {
        v: t(lang, isBotDisabledFor(jid) ? "common.off" : "common.on"),
      }),
    ];
    if (meta.desc) {
      const desc = meta.desc.length > 300 ? meta.desc.slice(0, 300) + "…" : meta.desc;
      lines.push(``, t(lang, "groupinfo.desc"), desc);
    }

    const caption = lines.join("\n");

    // Foto profil grup. Bisa gagal/kosong (grup tanpa foto, atau WA menolak)
    // -> itu wajar, jatuh ke teks biasa.
    let photo = null;
    try {
      const url = await sock.profilePictureUrl(jid, "image");
      if (url) {
        const res = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
        photo = Buffer.from(res.data);
      }
    } catch {
      photo = null;
    }

    if (photo) {
      // Batas caption WhatsApp 1024 karakter -> kalau lebih, kirim terpisah.
      if (caption.length <= 1000) {
        await sock.sendMessage(jid, { image: photo, caption });
      } else {
        await sock.sendMessage(jid, { image: photo });
        await sock.sendMessage(jid, { text: caption });
      }
    } else {
      await sock.sendMessage(jid, { text: caption });
    }
  } catch (err) {
    console.error("Gagal ambil info grup:", err);
    await sock.sendMessage(jid, { text: t(lang, "groupinfo.fail") });
  }
  return true;
}

// ---------------------------------------------------------------
// !online -- cek siapa yang lagi online di grup.
//
// Batasan dari WhatsApp (bukan dari bot):
//  - Baileys cuma bisa nanya presence per-orang (presenceSubscribe), tidak
//    ada API "siapa online di grup".
//  - Orang yang menyembunyikan "Terakhir dilihat & online" di privasinya
//    TIDAK akan terdeteksi, walau sebenarnya online.
//  - Hasilnya snapshot beberapa detik, jadi bukan daftar yang 100% akurat.
// ---------------------------------------------------------------
async function handleOnlineCommand(sock, msg, { jid, text, lang }) {
  const cmd = text.trim().toLowerCase();
  if (cmd !== "!online") return false;

  if (!jid.endsWith("@g.us")) {
    await sock.sendMessage(jid, { text: t(lang, "common.onlyInGroup") });
    return true;
  }

  const now = Date.now();
  const last = lastOnlineCheck.get(jid) || 0;
  if (now - last < ONLINE_COOLDOWN_MS) {
    const sisa = Math.ceil((ONLINE_COOLDOWN_MS - (now - last)) / 1000);
    await sock.sendMessage(jid, { text: t(lang, "online.cooldown", { sec: sisa }) });
    return true;
  }

  try {
    const meta = await sock.groupMetadata(jid);
    const botJid = safeNormalize(sock.user?.id || "");
    const members = (meta.participants || []).filter((p) => safeNormalize(p.id) !== botJid);

    if (members.length > ONLINE_MAX_MEMBERS) {
      await sock.sendMessage(jid, {
        text: t(lang, "online.tooMany", { n: members.length, max: ONLINE_MAX_MEMBERS }),
      });
      return true;
    }

    lastOnlineCheck.set(jid, now);
    await sock.sendMessage(jid, {
      text: t(lang, "online.checking", {
        n: members.length,
        sec: Math.round(ONLINE_WAIT_MS / 1000),
      }),
    });

    // Peta jid anggota (dalam semua bentuk) -> objek peserta
    const byJid = new Map();
    for (const p of members) {
      byJid.set(safeNormalize(p.id), p);
      if (p.phoneNumber) byJid.set(safeNormalize(p.phoneNumber), p);
    }

    // State terakhir per anggota (bukan Set yang cuma bertambah): kalau
    // seseorang sempat "available" lalu "unavailable" dalam jendela tunggu,
    // dia harus dihitung OFFLINE. Inilah yang bikin hasil lama membengkak.
    const state = new Map(); // peserta -> true/false
    const onPresence = ({ id, presences }) => {
      if (process.env.DEBUG_ONLINE) console.log("[online] presence.update", id, JSON.stringify(presences));
      for (const [pJid, data] of Object.entries(presences || {})) {
        const p = byJid.get(safeNormalize(pJid));
        if (!p) continue;
        const pres = data?.lastKnownPresence;
        if (pres === "available" || pres === "composing" || pres === "recording") state.set(p, true);
        else if (pres === "unavailable") state.set(p, false);
        // "paused" = berhenti ngetik tapi masih online -> state tidak diubah
      }
    };
    sock.ev.on("presence.update", onPresence);

    try {
      // PENTING: WhatsApp tidak mengirim presence orang lain ke sesi yang
      // berstatus offline. Bot dibuat dengan markOnlineOnConnect:false, jadi
      // tanpa baris ini banyak presence tidak pernah sampai -> hitungan kurang.
      await sock.sendPresenceUpdate("available");

      for (const p of members) {
        try {
          await sock.presenceSubscribe(p.phoneNumber || p.id);
        } catch {
          // satu nomor gagal jangan hentikan yang lain
        }
        await new Promise((r) => setTimeout(r, 120)); // jeda kecil antar subscribe
      }
      await new Promise((r) => setTimeout(r, ONLINE_WAIT_MS));
    } finally {
      sock.ev.off("presence.update", onPresence);
      // Balikin ke status semula (bot tidak tampil online terus-menerus)
      try {
        await sock.sendPresenceUpdate("unavailable");
      } catch {}
    }

    const online = new Set([...state].filter(([, v]) => v).map(([p]) => p));
    const list = [...online];
    const body = list.length
      ? list.map((p, i) => `${i + 1}. ${displayName(p, lang)}`).join("\n")
      : t(lang, "online.none");

    await sock.sendMessage(jid, {
      text: t(lang, "online.result", {
        group: meta.subject,
        online: list.length,
        total: members.length,
        body,
        note: t(lang, "online.note"),
      }),
    });
  } catch (err) {
    console.error("Gagal cek online:", err);
    await sock.sendMessage(jid, { text: t(lang, "online.fail") });
  }
  return true;
}

// ---------------------------------------------------------------
// !botstatus -- uptime, memori, jumlah grup, dst.
// ---------------------------------------------------------------
async function handleBotStatusCommand(sock, msg, { jid, text, lang }) {
  const cmd = text.trim().toLowerCase();
  if (cmd !== "!botstatus" && cmd !== "!statusbot") return false;

  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupEntries = Object.values(groups || {});
    const disabledCount = groupEntries.filter((g) => isBotDisabledFor(g.id)).length;
    const mem = process.memoryUsage();

    const lines = [
      t(lang, "botstatus.title"),
      ``,
      t(lang, "botstatus.connection"),
      t(lang, "botstatus.uptime", { v: fmtDuration(Date.now() - BOT_STARTED_AT, lang) }),
      t(lang, "botstatus.groups", {
        total: groupEntries.length,
        active: groupEntries.length - disabledCount,
        disabled: disabledCount,
      }),
      t(lang, "botstatus.dmUsers", { v: getKnownUsers().size }),
      t(lang, "botstatus.memory", { v: (mem.rss / 1024 / 1024).toFixed(0) }),
      t(lang, "botstatus.node", { v: process.version }),
      t(lang, "botstatus.server", { v: `${os.platform()} ${os.arch()}` }),
    ];
    if (jid.endsWith("@g.us")) {
      lines.push(
        t(lang, "botstatus.thisGroup", {
          v: t(lang, isBotDisabledFor(jid) ? "common.off" : "common.on"),
        }),
      );
    }
    await sock.sendMessage(jid, { text: lines.join("\n") });
  } catch (err) {
    console.error("Gagal ambil status bot:", err);
    await sock.sendMessage(jid, { text: t(lang, "botstatus.fail") });
  }
  return true;
}

module.exports = {
  handleGroupInfoCommand,
  handleOnlineCommand,
  handleBotStatusCommand,
};
// ya