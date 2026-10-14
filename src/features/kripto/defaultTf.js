"use strict";

/**
 * Default timeframe per pengguna untuk !chart / !level.
 * Awal: 4H. Command !tf (belum ada) tinggal memanggil setDefaultTf();
 * disimpan di memori, hilang saat bot restart.
 */

const FALLBACK_TF = "4H";
const store = new Map(); // senderId -> "15M" | "1H" | "4H" | "1D"

const getDefaultTf = (senderId) => store.get(senderId) || FALLBACK_TF;
const setDefaultTf = (senderId, tf) => store.set(senderId, tf);

module.exports = { FALLBACK_TF, getDefaultTf, setDefaultTf };
