// Command langganan:
//
//   OWNER (grup):
//     !sub add <hari> [nama grup]   tambah hari (sisa tidak hangus)
//     !sub set <hari> [nama grup]   mulai ulang dari sekarang N hari
//     !sub stop [nama grup]         hentikan sekarang
//     !sub cek [nama grup]          lihat status & sisa waktu
//     !sub list                     semua grup berlangganan, yang paling
//                                   cepat habis di atas
//     (tanpa nama grup = grup tempat command diketik)
//
//   OWNER (DM / nomor pribadi):
//     !subuser add <hari> <nomor>
//     !subuser set <hari> <nomor>
//     !subuser stop <nomor>
//     !subuser cek <nomor>
//     !subuser list
//
//   SIAPA SAJA:
//     !langganan   cek sisa langganan grup ini (atau nomor kamu kalau di DM)
const { OWNER_NUMBER, OWNER_JID } = require("../../config/env");
const { isOwnerMsg } = require("../../utils/whatsapp");
const { resolveGroupByName } = require("./ownerCommands");
const {
  MAX_DAYS,
  isSubscriptionEnabled,
  checkSubscription,
  listSubscriptions,
  addDays,
  setDays,
  expireNow,
  formatRemaining,
  formatDateWIB,
} = require("../../state/subscriptionStore");

const { t } = require("../../i18n");

const NOT_CONFIGURED =
  "⚠️ Fitur langganan belum aktif: SUPABASE_URL / SUPABASE_SERVICE_KEY belum diisi di bot.";

function statusLines(label, sub, lang) {
  if (sub.state === "active") {
    return [
      `📋 *${label}*`,
      t(lang, "sub.status.active"),
      t(lang, "sub.remaining", { time: formatRemaining(sub.remainingMs, lang) }),
      t(lang, "sub.endsAt", { date: formatDateWIB(sub.expiresAt, lang) }),
    ];
  }
  if (sub.state === "expired") {
    return [
      `📋 *${label}*`,
      t(lang, "sub.status.expired"),
      t(lang, "sub.expiredSince", { date: formatDateWIB(sub.expiresAt, lang) }),
    ];
  }
  return [`📋 *${label}*`, t(lang, "sub.status.none")];
}

// ---------------------------------------------------------------
// Balasan saat bot memblokir karena langganan habis / belum ada.
// Dengan cooldown supaya tidak spam tiap ada yang coba command.
// ---------------------------------------------------------------
const BLOCK_COOLDOWN_MS = 30 * 1000;
// Untuk DM yang ngetik bebas (bukan command): cukup diingatkan sesekali.
const BLOCK_COOLDOWN_CHAT_MS = 60 * 60 * 1000;
const lastBlockReply = new Map(); // jid chat -> timestamp

async function sendSubscriptionBlockedReply(
  sock,
  jid,
  kind,
  sub,
  { freeChat = false, lang } = {},
) {
  const now = Date.now();
  const cooldown = freeChat ? BLOCK_COOLDOWN_CHAT_MS : BLOCK_COOLDOWN_MS;
  if (now - (lastBlockReply.get(jid) || 0) < cooldown) return;
  lastBlockReply.set(jid, now);

  const head =
    sub.state === "expired"
      ? t(lang, `sub.blocked.expired.${kind}`, {
          date: formatDateWIB(sub.expiresAt, lang),
        })
      : t(lang, `sub.blocked.none.${kind}`);

  if (!OWNER_JID) {
    await sock.sendMessage(jid, { text: head });
    return;
  }
  await sock.sendMessage(jid, {
    text: `${head}\n\n${t(lang, "sub.contactOwner", { owner: OWNER_NUMBER })}`,
    mentions: [OWNER_JID],
  });
}

// ---------------------------------------------------------------
// !langganan -- siapa saja boleh cek.
// ---------------------------------------------------------------
async function handleMySubscriptionCommand(sock, msg, { jid, text, senderJid, lang }) {
  if (text.trim().toLowerCase() !== "!langganan") return false;

  if (!isSubscriptionEnabled()) {
    await sock.sendMessage(jid, { text: t(lang, "sub.notEnabled") });
    return true;
  }

  const isGroup = jid.endsWith("@g.us");
  const kind = isGroup ? "group" : "user";
  const id = isGroup ? jid : senderJid;
  if (!id) return true;

  const sub = checkSubscription(kind, id);
  const label = t(lang, isGroup ? "sub.label.group" : "sub.label.user");
  await sock.sendMessage(jid, { text: statusLines(label, sub, lang).join("\n") });
  return true;
}

// ---------------------------------------------------------------
// Utilitas parsing
// ---------------------------------------------------------------
function parseDays(raw) {
  const m = /^(\d{1,4})(?:\s+(.+))?$/.exec((raw || "").trim());
  if (!m) return null;
  const days = Number(m[1]);
  if (days < 1 || days > MAX_DAYS) return null;
  return { days, rest: (m[2] || "").trim() };
}

function formatListLines(entries, nameOf) {
  const lines = entries.slice(0, 40).map((s, i) => {
    const left = s.expiresAt - Date.now();
    const state = left > 0 ? `⏳ ${formatRemaining(left)}` : "❌ habis";
    return `${i + 1}. ${nameOf(s)} -- ${state}`;
  });
  if (entries.length > 40) lines.push(`…dan ${entries.length - 40} lainnya.`);
  return lines;
}

// ---------------------------------------------------------------
// !sub ... (grup)
// ---------------------------------------------------------------
async function handleSubCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^!sub(?:\s+(add|set|stop|cek|list))?(?:\s+(.+))?\s*$/i);
  if (!m) return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: t(lang, "owner.denied.sub"),
    });
    return true;
  }
  if (!isSubscriptionEnabled()) {
    await sock.sendMessage(jid, { text: NOT_CONFIGURED });
    return true;
  }

  const sub = (m[1] || "").toLowerCase();
  const arg = (m[2] || "").trim();

  if (!sub) {
    await sock.sendMessage(jid, {
      text:
        "❓ Format:\n" +
        "!sub add <hari> [nama grup]\n" +
        "!sub set <hari> [nama grup]\n" +
        "!sub stop [nama grup]\n" +
        "!sub cek [nama grup]\n" +
        "!sub list\n\n" +
        "_Tanpa nama grup = grup tempat kamu mengetik._",
    });
    return true;
  }

  if (sub === "list") {
    const entries = listSubscriptions("group");
    if (!entries.length) {
      await sock.sendMessage(jid, { text: "ℹ️ Belum ada grup yang berlangganan." });
      return true;
    }
    const lines = formatListLines(entries, (s) => s.name || s.jid);
    await sock.sendMessage(jid, {
      text: `📋 *Langganan grup (${entries.length}):*\n\n${lines.join("\n")}`,
    });
    return true;
  }

  // add/set butuh <hari>; stop/cek: seluruh argumen = nama grup (opsional).
  let days = null;
  let nameArg = arg;
  if (sub === "add" || sub === "set") {
    const parsed = parseDays(arg);
    if (!parsed) {
      await sock.sendMessage(jid, {
        text: `❓ Jumlah hari harus angka 1-${MAX_DAYS}.\nContoh: *!sub ${sub} 30* atau *!sub ${sub} 30 nama grup*`,
      });
      return true;
    }
    days = parsed.days;
    nameArg = parsed.rest;
  }

  // Tentukan grup target.
  let target;
  if (nameArg) {
    let resolved;
    try {
      resolved = await resolveGroupByName(sock, nameArg);
    } catch (err) {
      console.error("Gagal cari grup by nama:", err);
      await sock.sendMessage(jid, {
        text: "⚠️ Gagal ambil daftar grup buat dicariin namanya. Coba lagi bentar ya.",
      });
      return true;
    }
    if (resolved.type === "none") {
      await sock.sendMessage(jid, {
        text: `❓ Gak nemu grup dengan nama mengandung "${nameArg}". Cek pakai *!listgrup*.`,
      });
      return true;
    }
    if (resolved.type === "ambiguous") {
      const list = resolved.matches
        .map((g, i) => `${i + 1}. ${g.subject || "(tanpa nama)"}`)
        .join("\n");
      await sock.sendMessage(jid, {
        text: `❓ Ada ${resolved.matches.length} grup yang cocok, sebutin nama lebih spesifik:\n\n${list}`,
      });
      return true;
    }
    target = { id: resolved.group.id, name: resolved.group.subject || "(tanpa nama)" };
  } else if (jid.endsWith("@g.us")) {
    let name = null;
    try {
      name = (await sock.groupMetadata(jid)).subject;
    } catch {
      // nama cuma buat tampilan, abaikan kalau gagal
    }
    target = { id: jid, name: name || jid };
  } else {
    await sock.sendMessage(jid, {
      text: "ℹ️ Dari DM, sebutin nama grupnya: *!sub add 30 <nama grup>*. Atau ketik di dalam grup yang mau diatur.",
    });
    return true;
  }

  try {
    if (sub === "cek") {
      const s = checkSubscription("group", target.id);
      await sock.sendMessage(jid, { text: statusLines(target.name, s).join("\n") });
      return true;
    }

    let saved;
    let verb;
    if (sub === "add") {
      saved = await addDays("group", target.id, days, target.name);
      verb = `diperpanjang +${days} hari`;
    } else if (sub === "set") {
      saved = await setDays("group", target.id, days, target.name);
      verb = `diatur ulang ${days} hari dari sekarang`;
    } else {
      saved = await expireNow("group", target.id, target.name);
      await sock.sendMessage(jid, {
        text: `🛑 Langganan *${target.name}* dihentikan. Bot berhenti merespons anggota grup itu.`,
      });
      return true;
    }

    await sock.sendMessage(jid, {
      text:
        `✅ Langganan *${target.name}* ${verb}.\n` +
        `Berakhir: ${formatDateWIB(saved.expiresAt)}\n` +
        `Sisa: *${formatRemaining(saved.expiresAt - Date.now())}*`,
    });
  } catch (err) {
    console.error("[langganan] gagal simpan:", err);
    await sock.sendMessage(jid, {
      text: `⚠️ Gagal menyimpan ke Supabase: ${err.message}`,
    });
  }
  return true;
}

// ---------------------------------------------------------------
// !subuser ... (nomor pribadi)
// ---------------------------------------------------------------
const numberToJid = (raw) => {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length >= 5 ? `${digits}@s.whatsapp.net` : null;
};

async function handleSubUserCommand(sock, msg, { jid, text, lang }) {
  const m = text.match(/^!subuser(?:\s+(add|set|stop|cek|list))?(?:\s+(.+))?\s*$/i);
  if (!m) return false;

  if (!isOwnerMsg(msg)) {
    await sock.sendMessage(jid, {
      text: t(lang, "owner.denied.sub"),
    });
    return true;
  }
  if (!isSubscriptionEnabled()) {
    await sock.sendMessage(jid, { text: NOT_CONFIGURED });
    return true;
  }

  const sub = (m[1] || "").toLowerCase();
  const arg = (m[2] || "").trim();

  if (!sub) {
    await sock.sendMessage(jid, {
      text:
        "❓ Format:\n" +
        "!subuser add <hari> <nomor>\n" +
        "!subuser set <hari> <nomor>\n" +
        "!subuser stop <nomor>\n" +
        "!subuser cek <nomor>\n" +
        "!subuser list",
    });
    return true;
  }

  if (sub === "list") {
    const entries = listSubscriptions("user");
    if (!entries.length) {
      await sock.sendMessage(jid, { text: "ℹ️ Belum ada nomor yang berlangganan." });
      return true;
    }
    const lines = formatListLines(entries, (s) =>
      s.name ? `${s.jid.split("@")[0]} (${s.name})` : s.jid.split("@")[0],
    );
    await sock.sendMessage(jid, {
      text: `📋 *Langganan nomor (${entries.length}):*\n\n${lines.join("\n")}`,
    });
    return true;
  }

  let days = null;
  let numberArg = arg;
  if (sub === "add" || sub === "set") {
    const parsed = parseDays(arg);
    if (!parsed || !parsed.rest) {
      await sock.sendMessage(jid, {
        text: `❓ Format: *!subuser ${sub} <hari 1-${MAX_DAYS}> <nomor>*\nContoh: *!subuser ${sub} 30 6281234567890*`,
      });
      return true;
    }
    days = parsed.days;
    numberArg = parsed.rest;
  }

  const targetJid = numberToJid(numberArg);
  if (!targetJid) {
    await sock.sendMessage(jid, {
      text: "❓ Nomornya gak valid. Contoh: *6281234567890*",
    });
    return true;
  }
  const display = targetJid.split("@")[0];

  try {
    if (sub === "cek") {
      const s = checkSubscription("user", targetJid);
      await sock.sendMessage(jid, { text: statusLines(display, s).join("\n") });
      return true;
    }
    if (sub === "stop") {
      await expireNow("user", targetJid);
      await sock.sendMessage(jid, {
        text: `🛑 Langganan nomor *${display}* dihentikan.`,
      });
      return true;
    }

    const saved =
      sub === "add"
        ? await addDays("user", targetJid, days)
        : await setDays("user", targetJid, days);
    const verb =
      sub === "add" ? `diperpanjang +${days} hari` : `diatur ${days} hari dari sekarang`;
    await sock.sendMessage(jid, {
      text:
        `✅ Langganan nomor *${display}* ${verb}.\n` +
        `Berakhir: ${formatDateWIB(saved.expiresAt)}\n` +
        `Sisa: *${formatRemaining(saved.expiresAt - Date.now())}*`,
    });
  } catch (err) {
    console.error("[langganan] gagal simpan:", err);
    await sock.sendMessage(jid, {
      text: `⚠️ Gagal menyimpan ke Supabase: ${err.message}`,
    });
  }
  return true;
}

module.exports = {
  handleSubCommand,
  handleSubUserCommand,
  handleMySubscriptionCommand,
  sendSubscriptionBlockedReply,
};
