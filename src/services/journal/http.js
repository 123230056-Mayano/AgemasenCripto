"use strict";

/**
 * journal/http.js
 * ------------------------------------------------------------------
 * Helper HTTP + cache + throttle bersama untuk semua service jurnal
 * (OpenAlex, Crossref, Unpaywall, arXiv).
 *
 *  - getJson/getText : GET dengan timeout, User-Agent sopan, dan error
 *    yang diklasifikasi (timeout / rate_limited / http_error / network)
 *    lewat ServiceError, supaya orchestrator bisa tahu layanan mana
 *    yang gagal tanpa harus parsing pesan error axios.
 *  - cached          : cache in-memory ber-TTL (+ dedup request identik
 *    yang sedang jalan). Error TIDAK pernah di-cache.
 */

const axios = require("axios");

const CONTACT_EMAIL =
  process.env.OPEN_ACCESS_CONTACT_EMAIL || "bot-contact@example.com";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = `AgemasenBot/1.0 (mailto:${CONTACT_EMAIL})`;

class ServiceError extends Error {
  /**
   * @param {string} service - nama layanan, mis. "OpenAlex".
   * @param {"timeout"|"rate_limited"|"http_error"|"network"|"bad_response"} kind
   */
  constructor(service, kind, message) {
    super(message || `${service}: ${kind}`);
    this.name = "ServiceError";
    this.service = service;
    this.kind = kind;
  }
}

function classify(service, err) {
  if (err instanceof ServiceError) return err;
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return new ServiceError(service, "timeout", `${service}: timeout`);
  }
  const status = err.response?.status;
  if (status === 429) {
    return new ServiceError(service, "rate_limited", `${service}: 429 rate limit`);
  }
  if (status) {
    return new ServiceError(service, "http_error", `${service}: HTTP ${status}`);
  }
  return new ServiceError(service, "network", `${service}: ${err.message}`);
}

/**
 * GET dan return body. Status di `allow404` (default: 404) mengembalikan
 * null, bukan melempar -- dipakai buat "DOI gak ada di layanan ini".
 */
async function request(service, url, { params, headers, timeout, responseType, allow404 = true } = {}) {
  try {
    const res = await axios.get(url, {
      params,
      headers: { "User-Agent": USER_AGENT, ...(headers || {}) },
      timeout: timeout || REQUEST_TIMEOUT_MS,
      responseType,
      validateStatus: (s) => (s >= 200 && s < 300) || (allow404 && s === 404),
    });
    if (res.status === 404) return null;
    return res.data;
  } catch (err) {
    throw classify(service, err);
  }
}

const getJson = (service, url, opts) => request(service, url, { ...opts, responseType: "json" });
const getText = (service, url, opts) => request(service, url, { ...opts, responseType: "text" });

// -------------------- cache --------------------
const CACHE_MAX = 500;
const store = new Map(); // key -> { value, expires }
const pending = new Map(); // key -> Promise (dedup)

async function cached(key, ttlMs, loader) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) store.delete(key);

  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      if (store.size >= CACHE_MAX) store.delete(store.keys().next().value);
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

function clearCache() {
  store.clear();
  pending.clear();
}

const HOUR = 60 * 60 * 1000;

module.exports = {
  CONTACT_EMAIL,
  REQUEST_TIMEOUT_MS,
  ServiceError,
  getJson,
  getText,
  cached,
  clearCache,
  HOUR,
};
