#!/usr/bin/env node
"use strict";

/**
 * Impor sekali jalan: crypto_watch.json lama -> Supabase.
 *
 * Biasanya TIDAK perlu dijalankan manual: saat bot start, kalau tabel Supabase masih
 * kosong (atau file masih format lama), isi file otomatis diimpor. Skrip ini untuk
 * kasus lain, mis. mengimpor dari file di lokasi lain atau memaksa menimpa.
 *
 *   node scripts/import-crypto-to-supabase.js            # gabung: data Supabase yang sudah ada tetap menang
 *   node scripts/import-crypto-to-supabase.js --force    # timpa baris yang sama dengan isi file
 *   CRYPTO_STATE_FILE=/path/crypto_watch.json node scripts/import-crypto-to-supabase.js
 *
 * Butuh env: SUPABASE_URL, SUPABASE_SERVICE_KEY (dan BOT_ID kalau bukan "bot1").
 * Tabel harus sudah dibuat dari supabase/crypto_alerts.sql.
 */

const fs = require("fs");
const store = require("../src/state/cryptoStore");
const { BOT_ID } = require("../src/config/env");

async function main() {
  if (!store.isCryptoStoreEnabled()) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY belum di-set.");
    process.exit(1);
  }
  const file = process.env.CRYPTO_STATE_FILE || "(default: data/crypto_watch.json)";
  console.log(`Bot: ${BOT_ID} | File: ${file}`);

  const force = process.argv.includes("--force");
  if (force) {
    const ok = await store.pushAll();
    if (!ok) throw new Error("Gagal menulis ke Supabase (lihat log di atas).");
  } else {
    store.initCryptoStore();
    // initCryptoStore memuat + menggabung di latar belakang; flush() menunggu sampai selesai.
    const ok = await store.flush();
    if (!ok) throw new Error("Gagal menulis ke Supabase (lihat log di atas).");
  }
  const st = store.syncStatus();
  console.log(`Selesai. Terhubung: ${st.loaded ? "ya" : "tidak"}, pending: ${st.pending}.`);
  if (fs.existsSync(process.env.CRYPTO_STATE_FILE || "")) console.log("File JSON dibiarkan sebagai cadangan lokal.");
}

main().catch((e) => {
  console.error("GAGAL:", e.message);
  process.exit(1);
});
