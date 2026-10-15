"use strict";

/**
 * Default timeframe per pengguna untuk command kripto ([tf] boleh dikosongkan).
 * Awal: 4H. Diatur lewat !tf (utilitas.js) dan disimpan di state/cryptoStore.js
 * (data/crypto_watch.json), jadi tetap ada setelah bot restart.
 */

const cryptoStore = require("../../state/cryptoStore");

const FALLBACK_TF = "4H";

const getDefaultTf = (senderId) => cryptoStore.getTf(senderId) || FALLBACK_TF;
const setDefaultTf = (senderId, tf) => cryptoStore.setTf(senderId, tf);

module.exports = { FALLBACK_TF, getDefaultTf, setDefaultTf };
