// Status koneksi WhatsApp + QR login TERBARU, disimpan di memori supaya bisa
// ditampilkan di dashboard web (lewat GET /qr di stats server).
//
// status:
//   starting   -> proses baru jalan / sedang membuat socket
//   qr         -> menunggu QR discan (field `qr` berisi string QR terbaru)
//   connecting -> QR sudah discan / sedang menyambung
//   connected  -> bot sudah login & online
//   closed     -> koneksi putus, menunggu reconnect otomatis
//   logged_out -> sesi dicabut dari HP; sesi dihapus & QR baru akan dibuat
//   replaced   -> akun dipakai sesi lain (440); reconnect otomatis dimatikan
const state = {
  status: "starting",
  qr: null,
  qrAt: null,
  number: null,
  reason: null,
  updatedAt: Date.now(),
};

function set(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
}

const setStarting = () => set({ status: "starting", qr: null, qrAt: null, reason: null });
const setQr = (qr) => set({ status: "qr", qr, qrAt: Date.now(), reason: null });
const setConnecting = () => set({ status: "connecting", qr: null, qrAt: null });
const setConnected = (number) => set({ status: "connected", qr: null, qrAt: null, number: number || null, reason: null });
const setClosed = (reason) => set({ status: "closed", qr: null, qrAt: null, reason: reason ?? null });
const setLoggedOut = () => set({ status: "logged_out", qr: null, qrAt: null, number: null, reason: "loggedOut" });
const setReplaced = () => set({ status: "replaced", qr: null, qrAt: null, reason: "connectionReplaced" });

const getSession = () => ({ ...state });

module.exports = {
  setStarting, setQr, setConnecting, setConnected, setClosed, setLoggedOut, setReplaced, getSession,
};
