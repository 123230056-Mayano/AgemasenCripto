"use strict";

/**
 * features/forex/newsHealth.js
 * ------------------------------------------------------------------
 * Pelacak kesehatan sumber data (berita / kalender). Dipakai supaya sumber yang gagal TIDAK dipukul
 * terus-menerus: setelah gagal masuk masa tunggu (cooldown) yang melebar eksponensial, sementara sumber
 * lain tetap jalan. Begitu satu panggilan berhasil, status langsung pulih.
 *
 * Status:
 *   idle     belum pernah dicoba
 *   ok       panggilan terakhir berhasil
 *   cooldown gagal dan masih dalam masa tunggu
 *   retry    gagal, masa tunggu habis (akan dicoba lagi pada siklus berikutnya)
 */

const BASE_MS = 30_000; // gagal pertama: tunggu 30 dtk
const MAX_MS = 10 * 60_000; // batas atas 10 menit
const HARD_MS = 5 * 60_000; // 401/403/429: jangan coba lagi sebelum 5 menit (rate limit / key salah)

function createHealth() {
  return { fails: 0, okAt: 0, errAt: 0, lastError: null, nextTryAt: 0, lastPollAt: 0, lastUrl: null, lastCount: 0, lastItems: null, okTotal: 0, failTotal: 0 };
}

function errMessage(err) {
  if (err?.code === "SOURCE_FAILED") return String(err.message).slice(0, 200); // ringkasan semua mirror
  const status = err?.response?.status;
  if (status) return `HTTP ${status}`;
  if (err?.code) return String(err.code);
  return String(err?.message || err || "error").slice(0, 120);
}

function markOk(h, now, { url = null, count = 0 } = {}) {
  h.fails = 0;
  h.okAt = now;
  h.lastError = null;
  h.nextTryAt = 0;
  h.lastPollAt = now;
  h.lastUrl = url;
  h.lastCount = count;
  h.okTotal++;
}

function markFail(h, now, err) {
  h.fails++;
  h.failTotal++;
  h.errAt = now;
  h.lastError = errMessage(err);
  let delay = Math.min(MAX_MS, BASE_MS * 2 ** (h.fails - 1));
  const status = err?.response?.status;
  if (status === 401 || status === 403 || status === 429 || /HTTP (401|403|429)/.test(String(err?.message || ""))) delay = Math.max(delay, HARD_MS);
  h.nextTryAt = now + delay;
}

const canTry = (h, now) => now >= h.nextTryAt;

function statusOf(h, now) {
  if (h.fails > 0) return now < h.nextTryAt ? "cooldown" : "retry";
  return h.okAt ? "ok" : "idle";
}

module.exports = { createHealth, markOk, markFail, canTry, statusOf, errMessage };
