// Fungsi bantuan dikongsi antara halaman
const RM = (n) => 'RM ' + Number(n || 0).toLocaleString('ms-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const STATUS_LABEL = {
  DIHANTAR: 'Dihantar',
  DILULUSKAN: 'Diluluskan',
  DITOLAK: 'Ditolak',
  DIBAYAR: 'Dibayar',
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (data.errors && data.errors.join(' ')) || 'Ralat');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadSettings() {
  try {
    const s = await api('/api/tetapan');
    document.querySelectorAll('[data-company]').forEach((el) => { el.textContent = s.nama_syarikat; });
    return s;
  } catch { return { nama_syarikat: '', kadar_lalai: 10 }; }
}
