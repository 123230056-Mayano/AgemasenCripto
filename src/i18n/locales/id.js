// =====================================================
// Bahasa Indonesia -- bahasa asli bot ini (semua teks lama ada di sini).
// Placeholder {nama} diganti lewat t(lang, key, { nama: ... }).
// Kalau nambah key di sini, TAMBAHKAN JUGA di en.js (cek: npm run check:i18n).
// =====================================================
module.exports = {
  ...require("./id.menu"),

  // ---------- !lang ----------
  "lang.scope.group": "grup ini",
  "lang.scope.user": "nomor kamu",
  "lang.source.set": "dipilih manual",
  "lang.source.default": "bawaan bot",
  "lang.current":
    "🌐 *Bahasa bot*\n\nUntuk {scope}: *{language}* ({source})\n\nGanti bahasa:\n{list}\n\n_Di grup, cuma admin grup yang boleh mengganti._",
  "lang.invalid": "❓ Bahasa \"{input}\" gak dikenal. Pilih salah satu:\n{list}",
  "lang.notConfigured":
    "⚠️ Gak bisa nyimpen pengaturan: SUPABASE_URL / SUPABASE_SERVICE_KEY belum diisi di bot.",
  "lang.adminCheckFailed": "⚠️ Gagal ngecek apakah kamu admin grup. Coba lagi bentar ya.",
  "lang.adminOnly": "🚫 Cuma admin grup yang boleh ganti bahasa bot di sini, dasar.",
  "lang.already": "ℹ️ Bahasanya udah *{language}* kok.",
  "lang.saveFailed": "⚠️ Gagal nyimpen bahasa ke database. Coba lagi bentar ya.",
  "lang.changed": "✅ Oke, bahasa untuk {scope} sekarang: *{language}*.",

  // ---------- umum ----------
  "common.error": "Terjadi kesalahan.",
  "common.timeout": "⏱️ Server gambar lambat merespons. Coba lagi ya.",
  "common.onlyInGroup": "ℹ️ Command ini cuma bisa dipakai di dalam grup.",
  "common.noName": "(tanpa nama)",
  "common.hiddenMember": "(anggota tersembunyi)",
  "common.on": "✅ AKTIF",
  "common.off": "📴 NONAKTIF",
  "common.unknownCommand":
    "❓ Command tidak dikenal.\nKetik *!menu* buat lihat daftar command yang ada.",

  // ---------- chat AI ----------
  "forget.had":
    "Hmph, oke... sudah aku lupain semua obrolan kita. Mulai dari nol lagi ya. 😤",
  "forget.none":
    "Lho, kita kan belum pernah ngobrol apa-apa. Gak ada yang perlu dilupain, dasar. 🙄",

  // ---------- !ringkas ----------
  "ringkas.reading": "Hmph, tunggu bentar, aku bacain dulu dokumennya... 📄",
  "ringkas.long":
    "Dokumennya lumayan panjang (kira-kira {chunks} bagian yang aku baca satu-satu), jadi agak lama dikit ya, sabar! Bukan berarti aku males, cuma... yah, gitu deh. 😤",
  "ringkas.tip":
    "💡 Kalau mau nanya-nanya lebih detail soal isi dokumen ini, tinggal tag aku (@AgemasenBot) atau reply pesanku -- masih inget isinya kok, sekitar {hours} jam ke depan. ...B-bukan berarti aku niat bantuin lama-lama, ya!",
  "ringkas.noGroq": "Hmph, aku belum dikasih GROQ_API_KEY sama pemilikku. Bukan salahku ya! 😤",
  "ringkas.fail":
    "Duh, aku gagal bacain/ringkas dokumennya. Coba cek lagi filenya bener PDF & gak rusak, terus coba lagi. 💢",

  // ---------- !hd ----------
  "hd.badScale": "❌ Scale tidak tersedia.\n\nGunakan:\n!hd\n!hd 2x\n!hd 4x",
  "hd.needImage":
    "📷 Kirim atau reply gambar yang ingin dibuat lebih HD.\nContoh:\n!hd\n!hd 2x\n!hd 4x",
  "hd.queued": "⏳ Server sedang memproses gambar lain.\n\nPermintaanmu masuk antrean.",
  "hd.engineAi": "🤖 AI Super Resolution",
  "hd.engineSharp": "✨ Upscale + Penajaman",
  "hd.processing": "⏳ Memproses gambar...\n\n{engine}\n📐 Scale: {scale}x",
  "hd.successAi": "✨ Gambar berhasil di-upscale menggunakan AI.",
  "hd.successSharp": "✨ Gambar berhasil di-upscale & dipertajam.",
  "hd.done": "✅ Berhasil!\n\n{line}\n📐 Scale: {scale}x",
  "hd.fail": "❌ Gagal memproses gambar.\n\nSilakan coba lagi dengan gambar lain.",

  // ---------- pencarian gambar / GIF / sesi ----------
  "refill.gif":
    "🔁 Semua GIF untuk tag/keyword ini sudah pernah ditampilkan. Mulai ulang dari awal ya.",
  "refill.img":
    "🔁 Semua gambar untuk tag/keyword ini sudah pernah ditampilkan. Mulai ulang dari awal ya.",
  "tag.invalidNumber": "⚠️ Nomor tidak valid. Pilih 1-{max}.",
  "tag.noImages": "❌ Gambar untuk karakter ini tidak ditemukan.",
  "tag.noMore": "❌ Tidak ada gambar lain untuk tag ini.",
  "tag.pending":
    "⚠️ Masih ada daftar karakter yang belum dipilih.\n\n➡️ Buat *pilih karakter*: reply pesan daftarnya, lalu ketik nomor urutnya.\n➡️ Buat *lanjut sesi lain* pakai kode: ketik kodenya langsung tanpa reply.",
  "img.notFound": "❌ Gambar tidak ditemukan.",
  "gif.notFound": "❌ GIF tidak ditemukan untuk keyword ini.",
  "gif.providerFail": "GIF nggak ketemu atau providernya lagi ngambek.",
  "gif.noApiKey":
    "⚙️ GIPHY_API_KEY belum di-set (Tenor tetap dicoba duluan, tapi gagal/kosong juga barusan). Set env var GIPHY_API_KEY buat fallback yang lebih lengkap.",
  "pin.notFound": "❌ Gambar tidak ditemukan di Pinterest untuk keyword ini.",
  "pixiv.notFound": "❌ Ilustrasi aman tidak ditemukan di Pixiv untuk keyword ini.",
  "pixiv.blocked": "🚫 Keyword ini diblokir oleh filter konten dewasa. !pixiv cuma boleh buat konten umum.",
  "batch.partial": "ℹ️ Cuma ketemu {found} dari {requested} gambar yang diminta -- hasilnya memang sudah habis.",
  "batch.clamped": "ℹ️ Maksimal {max} gambar sekali cari, jadi aku kirim {max} aja.",
  "batch.idList": "🆔 *Daftar ID ({n} gambar):*",
  "id.notFound": "❌ Kode gambar tidak ditemukan.",

  "cap.mediaImage": "Gambar",
  "cap.mediaGif": "GIF",
  "cap.moreImage": "gambar",
  "cap.moreGif": "GIF",
  "cap.result": "Hasil {media}",
  "cap.continued": " (lanjutan)",
  "cap.character": "Karakter",
  "cap.keyword": "Keyword",
  "cap.sessionCode": "Kode Sesi",
  "cap.mediaCode": "Kode {media}",
  "cap.link": "Link",
  "cap.title": "Judul",
  "cap.artist": "Seniman",
  "cap.nextWithCode":
    "➡️ Ketik *{code}* (siapa saja boleh) atau *!next* untuk {media} lain dari pencarian ini",
  "cap.next": "➡️ Ketik *!next* untuk {media} lain dari pencarian ini",
  "cap.idLine": "🔁 Ketik *!id {id}* untuk lihat gambar ini lagi kapan saja",
  "tagList.title": "*KARAKTER DITEMUKAN*",
  "tagList.hint": "_Reply pesan ini dengan nomor urut karakter untuk melihat gambar_",
  "tagList.step": "*PILIH TAG ({n}/{total}): {words}*",
  "tagList.more": "_Menampilkan {shown} dari {total} hasil. Tulis kata kunci lebih spesifik untuk mempersempit._",
  "img.wordNotFound": "❌ Tidak ada tag yang cocok untuk \"{word}\". Coba cek ejaannya.",
  "img.tooManyWords": "❌ Kata kuncinya kebanyakan (maks. 8 kata).",

  // ---------- stiker ----------
  "sticker.making": "⏳ Membuat stiker...",
  "sticker.failed": "❌ Gagal membuat stiker.\n{err}",
  "gif.making": "⏳ Membuat GIF...",
  "togif.failed": "❌ Gagal membuat GIF.\n{err}",
  "togif.notAnimated":
    "⚠️ Itu stiker biasa (bukan animasi), jadi gak ada apa-apanya buat dijadiin GIF.\nMau dijadiin gambar? Pakai *!toimg*.",
  "toimg.failed": "❌ Gagal membuat gambar.\n{err}",
  "sbrat.tooLong":
    "⚠️ Teksnya kepanjangan ({len} karakter, maksimal {max}) biar prosesnya gak lama dan gak bikin bot lag. Coba dipersingkat lagi ya.",
  "sbrat.failed": "❌ Gagal membuat stiker BRAT.\n{err}",
  "sbrat.renderError": "Terjadi kesalahan saat merender teks, coba lagi ya.",
  "gifbrat.tooLong":
    "⚠️ Teksnya kepanjangan ({len} karakter, maks {max}) biar GIF-nya cepat jadi dan bot gak ngelag. Coba dipersingkat.",
  "gifbrat.tooManyWords":
    "⚠️ Kata-katanya kebanyakan ({count} kata, maks {max}) karena tiap kata jadi 1 frame animasi. Coba dipersingkat.",
  "gifbrat.failed": "❌ Gagal membuat GIF BRAT.\n{err}",
  "schat.nameTooLong": "⚠️ Nama pengirimnya kepanjangan (maksimal {max} karakter).",
  "schat.msgTooLong":
    "⚠️ Pesannya kepanjangan ({len} karakter, maksimal {max}) biar layout stikernya tetap rapi & prosesnya gak lama.",
  "schat.failed": "❌ Gagal membuat stiker chat.\n{err}",
  "schat.renderError": "Terjadi kesalahan saat merender, coba lagi ya.",

  // ---------- download ----------
  "dl.invalidLink": "❌ Link tidak valid.",
  "dl.noLinkInReply": "❌ Pesan yang kamu reply tidak mengandung link. Reply pesan yang berisi link (YouTube, TikTok, Instagram, X, dll) lalu ketik !dl, !dlr, atau !dlt.",
  "dl.badHeight":
    "⚠️ Resolusi \"{hint}\" gak dikenal, pakai salah satu: {list}. Lanjut download pakai kualitas default dulu ya...",
  "dlstatus.backoff":
    "⏳ Lagi backoff (kena rate-limit YouTube). Sisa waktu tunggu: ~{time}.\nBot bakal otomatis coba lagi setelah waktu itu lewat -- !dl YouTube bakal ditolak dulu sementara ini biar gak nambah beban ke IP-nya.",
  "dlstatus.ok":
    "✅ Gak lagi kena backoff. !dl YouTube seharusnya bisa dicoba normal.\n(Catatan: ini status TERAKHIR YANG TERCATAT dari percobaan sebelumnya -- kalau dari deploy terakhir belum ada yang pernah nyoba !dl sama sekali, status ini belum tentu mencerminkan kondisi IP yang sebenarnya.)",

  // ---------- owner / ngambek ----------
  "ngambek.1": "Hmph! Aku lagi gak mau aktif, dasar. 😤",
  "ngambek.2": "Males ah, aku lagi dimatiin. Gak mau kerja dulu sekarang. 🙄",
  "ngambek.3": "Ish, jangan suruh-suruh aku, aku lagi nonaktif tau!",
  "ngambek.contact": "Kalau mau aku aktif lagi, hubungin @{owner} ya, bukan aku yang nentuin. 💢",
  "owner.denied.bot": "🚫 Cuma owner yang boleh atur aktif/nonaktifin aku, dasar.",
  "owner.denied.listgrup": "🚫 Cuma owner yang boleh liat daftar grup, dasar.",
  "owner.denied.user": "🚫 Cuma owner yang boleh atur blokir per nomor, dasar.",
  "owner.denied.listuser": "🚫 Cuma owner yang boleh liat daftar nomor, dasar.",
  "owner.denied.sub":
    "🚫 Cuma owner yang boleh atur langganan, dasar. (Cek sisa langganan: *!langganan*)",

  // ---------- langganan ----------
  "sub.notEnabled": "ℹ️ Fitur langganan belum diaktifkan.",
  "sub.label.group": "Grup ini",
  "sub.label.user": "Nomor kamu",
  "sub.status.active": "Langganan: ✅ AKTIF",
  "sub.remaining": "Sisa: *{time}*",
  "sub.endsAt": "Berakhir: {date}",
  "sub.status.expired": "Langganan: ⏳ HABIS",
  "sub.expiredSince": "Berakhir sejak: {date}",
  "sub.status.none": "Langganan: 🔒 belum berlangganan",
  "sub.blocked.expired.group": "⏳ Langganan grup ini sudah habis sejak {date}.",
  "sub.blocked.expired.user": "⏳ Langganan nomor kamu sudah habis sejak {date}.",
  "sub.blocked.none.group": "🔒 Grup ini belum berlangganan.",
  "sub.blocked.none.user": "🔒 Nomor kamu belum berlangganan.",
  "sub.contactOwner": "Mau lanjut pakai aku? Hubungi @{owner} buat perpanjang ya. 💢",
  "time.expired": "habis",
  "time.dhm.days": "{d} hari {h} jam",
  "time.dhm.hours": "{h} jam {m} menit",
  "time.dhm.minutes": "{m} menit",

  // ---------- info grup / online / status bot ----------
  "groupinfo.title": "📋 *Info Grup*",
  "groupinfo.name": "*Nama:* {v}",
  "groupinfo.members": "*Jumlah anggota:* {v}",
  "groupinfo.admins": "*Admin:* {v}",
  "groupinfo.creator": "*Pembuat:* {v}",
  "groupinfo.created": "*Dibuat:* {v}",
  "groupinfo.whoCanSend": "*Yang boleh kirim pesan:* {v}",
  "groupinfo.adminsOnly": "hanya admin",
  "groupinfo.everyone": "semua anggota",
  "groupinfo.botHere": "*Bot di grup ini:* {v}",
  "groupinfo.desc": "*Deskripsi:*",
  "groupinfo.adminList": "*Daftar admin:*",
  "groupinfo.fail": "⚠️ Gagal ambil info grup. Coba lagi bentar ya.",
  "online.cooldown": "⏳ Sabar, tunggu {sec} detik lagi baru bisa cek online.",
  "online.tooMany":
    "⚠️ Grup ini {n} anggota, terlalu banyak buat dicek (maks {max}) biar akun bot gak kena limit dari WhatsApp.",
  "online.checking": "🔎 Ngecek {n} anggota, tunggu ±{sec} detik...",
  "online.none": "_Gak ada yang terdeteksi online._",
  "online.result": "🟢 *Online di {group}* ({online}/{total})\n\n{body}\n\n{note}",
  "online.note":
    "_Catatan: yang menyembunyikan status online di privasi WhatsApp-nya gak akan kelihatan._",
  "online.fail": "⚠️ Gagal cek yang online. Coba lagi bentar ya.",
  "botstatus.title": "🤖 *Status Bot*",
  "botstatus.connection": "*Koneksi:* ✅ terhubung",
  "botstatus.uptime": "*Uptime:* {v}",
  "botstatus.groups": "*Jumlah grup:* {total} (aktif {active}, nonaktif {disabled})",
  "botstatus.dmUsers": "*Pengguna DM tercatat:* {v}",
  "botstatus.memory": "*Memori bot:* {v} MB",
  "botstatus.node": "*Node.js:* {v}",
  "botstatus.server": "*Server:* {v}",
  "botstatus.thisGroup": "*Di grup ini:* {v}",
  "botstatus.fail": "⚠️ Gagal ambil status bot. Coba lagi bentar ya.",
  "dur.d": "{n} hari",
  "dur.h": "{n} jam",
  "dur.m": "{n} menit",

  // ---------- chat AI (error & label) ----------
  "ai.fail": "H-hmph! Otakku lagi ngambek gara-gara lagi malas mikir. Coba tag aku lagi nanti. 💢",
  "ai.tagOnly": "(cuma nge-tag doang, gak nulis apa-apa)",
  "ai.sources": "Sumber:",

  // ---------- !trainer (Uma Musume) ----------
  "trainer.notFound": "❌ Trainer \"{q}\" tidak ditemukan.",
  "trainer.tooLong": "⚠️ Keyword terlalu panjang (maks. 40 karakter).",
  "trainer.listTitle": "*TRAINER DITEMUKAN* ({count})\nKeyword: _{q}_",
  "trainer.listHint": "_Reply pesan ini dengan nomor urut trainer untuk melihat kartunya_",
  "trainer.listPage": "Halaman {page}/{pages}",
  "trainer.listNav": "_Reply *next* / *prev* / *hal 5* untuk pindah halaman_",
  "trainer.invalidPage": "⚠️ Halaman tidak valid. Pilih 1-{max}.",
  "trainer.invalidNumber": "⚠️ Nomor tidak valid. Pilih 1-{max}.",
  "trainer.caption": "*{name}*\n🆔 {id}",
  "trainer.cardFail": "⚠️ Kartu gagal dibuat, ini info singkatnya:",
  "trainer.noKey": "⚙️ UMA_API_KEY belum di-set di server bot.",
  "trainer.auth": "⚙️ API key uma.moe ditolak. Cek UMA_API_KEY di server bot.",
  "trainer.rate": "⏳ uma.moe lagi membatasi request. Coba lagi sebentar.",
  "trainer.fail": "❌ Gagal mengambil data dari uma.moe. Coba lagi nanti.",
  // ---------- !club / !threshold / !leaderboard (Uma Musume circle) ----------
  "club.tooLong": "⚠️ Keyword terlalu panjang (maks. 40 karakter).",
  "club.notFound": "❌ Club \"{q}\" tidak ditemukan.",
  "club.gone": "❌ Club dengan ID {id} tidak ditemukan.",
  "club.listTitle": "*CLUB DITEMUKAN* ({count})\nKeyword: _{q}_",
  "club.listHint": "_Reply pesan ini dengan nomor urut club untuk melihat kartunya_",
  "club.invalidNumber": "⚠️ Nomor tidak valid. Pilih 1-{max}.",
  "club.caption": "*{name}*\n🆔 {id} · Tier {tier}\n👑 Leader: {leader}",
  "circle.cardFail": "⚠️ Kartu gagal dibuat, ini info singkatnya:",
  "threshold.caption": "*RANK THRESHOLD CIRCLE*\nTier SS → D",
  "leaderboard.caption": "*LEADERBOARD CIRCLE*\nRank 1-{n}",

  // ---------- !artikel ----------
  "art.busy": "Proses *!artikel* kamu yang sebelumnya belum selesai, tunggu dulu ya.",
  "art.cooldown": "Tunggu {sec} detik lagi sebelum pakai *!artikel* lagi ya.",
  "art.usage": "❗ Format:\n• *!artikel <kata kunci>* -> cari publikasi\n• *!artikel doi <DOI>* -> cek DOI, sitasi & PDF\n• *!artikel arxiv <kata kunci>* -> cari preprint di arXiv\n• *!artikel <URL>* -> ambil dokumen dari link publik\n\nContoh:\n!artikel drone racing\n!artikel doi 10.1000/xyz123\n!artikel arxiv autonomous navigation",
  "art.invalidDoi": "❌ DOI tidak valid. Contoh: *!artikel doi 10.1000/xyz123*",
  "art.searching": "🔎 Mencari publikasi di OpenAlex...",
  "art.searchingArxiv": "🔎 Mencari preprint di arXiv...",
  "art.lookingUpDoi": "🔎 Memeriksa DOI di OpenAlex & Crossref...",
  "art.enriching": "🔗 Mencocokkan DOI (Crossref), cek PDF legal (Unpaywall) & versi arXiv...",
  "art.jr.header": "📚 *Hasil pencarian:* {query}\nMenampilkan {count} publikasi teratas.",
  "art.jr.headerArxiv": "📚 *Hasil arXiv:* {query}\nMenampilkan {count} preprint teratas.",
  "art.jr.headerDoi": "🔖 *Metadata DOI:* {doi}",
  "art.jr.etAl": "dkk.",
  "art.jr.authors": "👤 {authors}",
  "art.jr.year": "📅 Tahun: {year}",
  "art.jr.venue": "📖 Sumber: {venue}",
  "art.jr.doi": "🔖 DOI: {doi}",
  "art.jr.link": "🔗 Penerbit: {url}",
  "art.jr.cites": "📊 Sitasi: {count} ({source})",
  "art.jr.citesNA": "📊 Sitasi: tidak tersedia",
  "art.jr.pdfAvailable": "📥 PDF: ✅ Tersedia ({source})",
  "art.jr.pdfPage": "📥 Akses terbuka: ✅ Tersedia lewat halaman ({source})",
  "art.jr.pdfNotFound": "📥 PDF: ❌ Belum ditemukan versi gratis",
  "art.jr.pdfUnknown": "📥 PDF: ❓ Belum dapat dipastikan",
  "art.jr.arxiv": "📄 arXiv: {url}",
  "art.jr.partial": "⚠️ Sebagian layanan tidak merespons: {services}. Hasil bisa kurang lengkap.",
  "art.jr.footer": "ℹ️ Status PDF hanya berdasar sumber yang dicek (Unpaywall, arXiv, OpenAlex). \"Belum ditemukan\" bukan berarti pasti tidak ada versi gratis. Data sitasi tiap penyedia bisa berbeda.",
  "art.jr.allFailed": "❌ Layanan pencarian jurnal sedang tidak merespons atau kena batas permintaan. Coba lagi beberapa saat lagi ya.",
  "art.jr.empty": "❌ Tidak ada publikasi yang cocok dengan \"{query}\". Coba kata kunci lain.",
  "art.jr.doiNotFound": "❌ DOI {doi} tidak ditemukan di OpenAlex maupun Crossref.",
  "art.processing": "⏳ Sedang memproses artikel...",
  "art.detecting": "🔍 Mendeteksi sumber...",
  "art.findingPdf": "📄 Mencari file PDF publik...",
  "art.findingOA": "🔎 Mencari versi Open Access resmi...",
  "art.untitled": "Tanpa judul",
  "art.found": "✅ Artikel ditemukan\n\n📄 Judul: {title}\n🌐 Sumber: {provider}\n\n📥 Sedang mengirim dokumen...",
  "art.caption": "📄 {title}\n🔗 Sumber asli: {url}",
  "art.oaFound": "✅ Versi Open Access ditemukan\n\n📄 Judul: {title}\n🔗 PDF: {url}",
  "art.invalid": "❌ URL tidak valid.",
  "art.notFound": "❌ File PDF publik tidak tersedia.\n\n🔗 Kamu bisa membuka artikel asli di:\n{url}",
  "art.error": "❌ Terjadi kesalahan saat memproses artikel. Coba lagi nanti ya.",

  // ---------- !dl / !dlr (status & error) ----------
  "dl.photoDetected": "🖼️ Sepertinya ini postingan foto, bukan video. Coba download fotonya...",
  "dl.photoWait": "⏳ Download foto/carousel, tunggu ya...",
  "dl.photoNone": "❌ Gagal download foto.\n\nGak ada foto yang bisa diambil dari link ini -- pastikan ini beneran link carousel/slideshow foto (kalau ini video, pakai !dl saja).",
  "dl.photoFail": "❌ Gagal download foto.\n\nSilakan coba lagi atau cek link-nya.",
  "dl.threadWait": "⏳ Download thread (teks + media), tunggu ya...",
  "dl.threadFail": "❌ Gagal download thread.\n\nPastikan link-nya benar & postingannya publik (X/Twitter kadang butuh cookies, lihat GALLERYDL_COOKIES_FILE), lalu coba lagi.\n\nDetail: {detail}",
  "dl.threadTruncated": "ℹ️ Thread ini punya {total} media, yang dikirim cuma {sent} pertama biar gak kebanyakan.",
  "dl.queued": "🕒 Lagi antre di server download (posisi {pos}). Sabar ya, gak usah kirim ulang.",
  "dl.failed": "❌ Gagal download.\n{error}",
  "dl.fallback": "⚠️ Server download utama lagi bermasalah, coba cara cadangan dulu ya...",
  "dl.waitAudioSilence": "⏳ Download audio (MP3) lewat server download, tunggu ya...",
  "dl.waitVideoSilence": "⏳ Download video{height} lewat server download, tunggu ya...",
  "dl.waitAudio": "⏳ Download audio (MP3), tunggu ya...",
  "dl.waitVideo": "⏳ Download video, tunggu ya...",
  "dl.maxHeight": " (maks {height}p)",
  "dl.err.geo": "🌍 Video ini dibatasi wilayah (geo-restricted) oleh platform aslinya -- server bot tidak bisa akses dari lokasinya. Coba video/link lain.",
  "dl.err.private": "🔒 Videonya bersifat privat, gak bisa diakses tanpa login.",
  "dl.err.bot": "🤖 YouTube mendeteksi server bot ini sebagai traffic mencurigakan (umum terjadi di IP cloud/datacenter kayak Railway/AWS/GCP) -- ini BUKAN soal video dibatasi umur. Coba lagi beberapa saat, atau aktifin PO Token server (env var YTDLP_POT_BASE_URL) buat solusi lebih permanen.",
  "dl.err.age": "🔞 Video ini dibatasi umur oleh platformnya dan butuh login -- bot ini gak bisa login akun.",
  "dl.err.pot": "⚙️ POT provider (bgutil) gak bisa dihubungi dari server -- cek apakah service-nya masih jalan & YTDLP_POT_BASE_URL sudah benar.",
  "dl.err.gone": "❌ Video/postingannya sudah tidak tersedia (mungkin dihapus atau link-nya salah).",
  "dl.err.unsupported": "❌ Link ini belum didukung buat didownload.",
  "dl.err.generic": "Terjadi kesalahan saat download.",
  "dl.rateLimited": "⏳ Lagi kena rate-limit YouTube (server ini kebanyakan request beberapa saat lalu). Coba lagi dalam ~{time}, bot bakal otomatis nyoba lagi setelah itu -- gak perlu diapa-apain, tinggal kirim !dl lagi nanti.",

  // ---------- !analisis ----------
  "analisis.noUrl": "⚙️ ANALYST_URL belum di-set di server bot, jadi !analisis belum bisa dipakai.",
  "analisis.busy": "Proses *!analisis* kamu yang sebelumnya belum selesai, tunggu dulu ya.",
  "analisis.cooldown": "Tunggu {sec} detik lagi sebelum pakai *!analisis* lagi ya.",
  "analisis.working": "📈 Menganalisis *{coin}* ({tf}) dan menyiapkan PDF... bisa 10-40 detik.",
  "analisis.caption": "📈 *{coin} {tf}* - {trend}\nHarga: {price}\n_Analisis edukatif, bukan sinyal trading._",
  "analisis.unsupported": "❌ Koin *{coin}* atau timeframe *{tf}* tidak didukung. Contoh: *!analisis sol 4h* (timeframe: 1H, 4H, 1D).",
  "analisis.timeout": "⏱️ Server analisis lambat merespons. Coba lagi sebentar ya.",
  "analisis.fail": "❌ Gagal membuat analisis. Coba lagi nanti.",
  "analisis.failDetail": "❌ Gagal membuat analisis: {detail}",
};
