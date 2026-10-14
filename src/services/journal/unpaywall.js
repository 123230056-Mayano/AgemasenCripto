"use strict";

/**
 * Unpaywall -- versi Open Access LEGAL berdasarkan DOI. Wajib pakai email
 * (OPEN_ACCESS_CONTACT_EMAIL). Unpaywall menolak email @example.com, jadi
 * ganti nilai default-nya dengan email asli.
 */

const { getJson, cached, HOUR, CONTACT_EMAIL } = require("./http");

const SERVICE = "Unpaywall";

/**
 * @returns {Promise<null | {isOa:boolean, pdfUrl:string|null, landingUrl:string|null, hostType:string|null}>}
 *   null = DOI gak dikenal Unpaywall (status PDF jadi "belum pasti").
 *   isOa=false = Unpaywall sudah memeriksa dan tidak ada versi OA.
 */
function check(doi) {
  return cached(`unpaywall:${doi}`, 24 * HOUR, async () => {
    const data = await getJson(SERVICE, `https://api.unpaywall.org/v2/${encodeURIComponent(doi).replace(/%2F/gi, "/")}`, {
      params: { email: CONTACT_EMAIL },
    });
    if (!data) return null;
    const best = data.best_oa_location;
    if (data.is_oa !== true || !best) {
      return { isOa: false, pdfUrl: null, landingUrl: null, hostType: null };
    }
    return {
      isOa: true,
      pdfUrl: best.url_for_pdf || null,
      landingUrl: best.url_for_landing_page || best.url || null,
      hostType: best.host_type || null,
    };
  });
}

module.exports = { check };
