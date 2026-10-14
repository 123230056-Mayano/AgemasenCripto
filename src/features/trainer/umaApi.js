const axios = require("axios");

const UMA_BASE = (process.env.UMA_API_BASE || "https://uma.moe").replace(/\/+$/, "");
const TIMEOUT_MS = 15000;

class UmaApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // NO_KEY | AUTH | RATE | HTTP | NETWORK
  }
}

async function umaGet(path, params) {
  const key = process.env.UMA_API_KEY;
  if (!key) throw new UmaApiError("NO_KEY", "UMA_API_KEY belum di-set");
  try {
    const res = await axios.get(`${UMA_BASE}${path}`, {
      params,
      headers: { "X-API-Key": key, Accept: "application/json" },
      timeout: TIMEOUT_MS,
    });
    return res.data || {};
  } catch (err) {
    const s = err.response?.status;
    if (s === 401 || s === 403) throw new UmaApiError("AUTH", `HTTP ${s}`);
    if (s === 429) throw new UmaApiError("RATE", "HTTP 429");
    if (s) throw new UmaApiError("HTTP", `HTTP ${s}`);
    throw new UmaApiError("NETWORK", err.message);
  }
}

// GET /api/v3/search (sama dengan tab "Cari trainer" di UMA-API-TESTER).
const umaSearch = (params) => umaGet("/api/v3/search", params);

// GET /api/v4/user/profile/{account_id} -> berisi team_stadium
const umaProfile = (accountId) => umaGet(`/api/v4/user/profile/${encodeURIComponent(accountId)}`);

// ---- circle / club (sama dengan tab Circle rank, Detail club, Rank thresholds di UMA-API-TESTER) ----
// GET /api/v4/circles?circle_id=...  (detail + members[])
const umaCircle = (circleId, extra = {}) => umaGet("/api/v4/circles", { circle_id: circleId, ...extra });
// GET /api/v4/circles/list  (page mulai dari 0)
const umaCircleList = (params) => umaGet("/api/v4/circles/list", params);
// GET /api/v4/circles/rank-thresholds
const umaThresholds = () => umaGet("/api/v4/circles/rank-thresholds");

module.exports = { UmaApiError, umaGet, umaSearch, umaProfile, umaCircle, umaCircleList, umaThresholds };
