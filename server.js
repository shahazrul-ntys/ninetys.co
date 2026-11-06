'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bayaran.db');

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[AMARAN] ADMIN_PASSWORD tidak ditetapkan. Kata laluan lalai "admin123" digunakan — tukar sebelum guna sebenar.');
}

const STATUSES = ['DIHANTAR', 'DILULUSKAN', 'DITOLAK', 'DIBAYAR'];

// ---------- Helpers ----------

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function minutesBetween(start, end) {
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const a = re.exec(start);
  const b = re.exec(end);
  if (!a || !b) return null;
  let s = Number(a[1]) * 60 + Number(a[2]);
  let e = Number(b[1]) * 60 + Number(b[2]);
  if (e <= s) e += 24 * 60; // syif melepasi tengah malam
  return e - s;
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Sahkan & kira semula tuntutan di pelayan (jangan percaya kiraan pelayar). */
function validateClaim(body) {
  const errors = [];
  const c = {
    nama: str(body.nama, 120),
    no_ic: str(body.no_ic, 20).replace(/[^0-9]/g, ''),
    telefon: str(body.telefon, 20),
    emel: str(body.emel, 120),
    jawatan: str(body.jawatan, 80),
    jabatan: str(body.jabatan, 80),
    bank: str(body.bank, 60),
    no_akaun: str(body.no_akaun, 30).replace(/[^0-9]/g, ''),
    nama_pemegang: str(body.nama_pemegang, 120),
    tempoh_mula: str(body.tempoh_mula, 10),
    tempoh_tamat: str(body.tempoh_tamat, 10),
    kadar_sejam: num(body.kadar_sejam),
    elaun: body.elaun === '' || body.elaun == null ? 0 : num(body.elaun),
    potongan: body.potongan === '' || body.potongan == null ? 0 : num(body.potongan),
    catatan: str(body.catatan, 1000),
    pengakuan: body.pengakuan === true || body.pengakuan === 'on' || body.pengakuan === 'true',
  };

  if (c.nama.length < 3) errors.push('Nama penuh diperlukan.');
  if (c.no_ic.length !== 12) errors.push('No. Kad Pengenalan mesti 12 digit.');
  if (!/^[0-9+\-\s]{9,15}$/.test(c.telefon)) errors.push('No. telefon tidak sah.');
  if (c.emel && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.emel)) errors.push('Alamat emel tidak sah.');
  if (!c.jawatan) errors.push('Jawatan / tugas diperlukan.');
  if (!c.bank) errors.push('Nama bank diperlukan.');
  if (c.no_akaun.length < 8) errors.push('No. akaun bank tidak sah.');
  if (!c.nama_pemegang) c.nama_pemegang = c.nama;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(c.tempoh_mula) || !dateRe.test(c.tempoh_tamat)) errors.push('Tempoh tuntutan diperlukan.');
  else if (c.tempoh_tamat < c.tempoh_mula) errors.push('Tarikh tamat tempoh mesti selepas tarikh mula.');
  if (!(c.kadar_sejam > 0 && c.kadar_sejam <= 1000)) errors.push('Kadar sejam tidak sah.');
  if (!(c.elaun >= 0 && c.elaun <= 100000)) errors.push('Elaun tidak sah.');
  if (!(c.potongan >= 0 && c.potongan <= 100000)) errors.push('Potongan tidak sah.');
  if (!c.pengakuan) errors.push('Sila tandakan pengakuan.');

  const rawRows = Array.isArray(body.kehadiran) ? body.kehadiran : [];
  if (rawRows.length === 0) errors.push('Sekurang-kurangnya satu rekod kehadiran diperlukan.');
  if (rawRows.length > 62) errors.push('Terlalu banyak rekod kehadiran (maks 62).');

  const rows = [];
  rawRows.slice(0, 62).forEach((r, i) => {
    const n = i + 1;
    const tarikh = str(r && r.tarikh, 10);
    const masa_mula = str(r && r.masa_mula, 5);
    const masa_tamat = str(r && r.masa_tamat, 5);
    const rehat = r && r.rehat_minit !== '' && r.rehat_minit != null ? num(r.rehat_minit) : 0;
    const tugas = str(r && r.tugas, 200);
    if (!dateRe.test(tarikh)) { errors.push(`Baris ${n}: tarikh tidak sah.`); return; }
    if (dateRe.test(c.tempoh_mula) && dateRe.test(c.tempoh_tamat) &&
        (tarikh < c.tempoh_mula || tarikh > c.tempoh_tamat)) {
      errors.push(`Baris ${n}: tarikh di luar tempoh tuntutan.`);
    }
    const mins = minutesBetween(masa_mula, masa_tamat);
    if (mins == null) { errors.push(`Baris ${n}: masa tidak sah.`); return; }
    if (!(rehat >= 0 && rehat < mins)) { errors.push(`Baris ${n}: minit rehat tidak sah.`); return; }
    const jam = round2((mins - rehat) / 60);
    if (jam > 16) errors.push(`Baris ${n}: melebihi 16 jam sehari.`);
    rows.push({ tarikh, masa_mula, masa_tamat, rehat_minit: rehat, jam, tugas });
  });

  const jumlah_jam = round2(rows.reduce((s, r) => s + r.jam, 0));
  const gaji_kasar = round2(jumlah_jam * (c.kadar_sejam || 0));
  const jumlah_bersih = round2(gaji_kasar + (c.elaun || 0) - (c.potongan || 0));
  if (rows.length && jumlah_bersih < 0) errors.push('Jumlah bersih tidak boleh negatif.');

  return { errors, claim: { ...c, jumlah_jam, gaji_kasar, jumlah_bersih }, rows };
}

// ---------- Admin session (cookie bertandatangan HMAC) ----------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function makeToken() {
  const exp = Date.now() + 8 * 60 * 60 * 1000; // 8 jam
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return Number(parts[1]) > Date.now();
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function requireAdmin(req, res, next) {
  if (verifyToken(getCookie(req, 'admin_session'))) return next();
  res.status(401).json({ error: 'Sila log masuk sebagai pentadbir.' });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- App ----------

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Tetapan awam (kadar lalai, nama syarikat)
  app.get('/api/tetapan', (req, res) => {
    res.json(db.getSettings());
  });

  // Pekerja hantar tuntutan
  app.post('/api/tuntutan', (req, res) => {
    const { errors, claim, rows } = validateClaim(req.body || {});
    if (errors.length) return res.status(400).json({ errors });
    const saved = db.createClaim(claim, rows);
    res.status(201).json({ no_rujukan: saved.no_rujukan, jumlah_bersih: claim.jumlah_bersih });
  });

  // Pekerja semak status (perlu no. rujukan + 4 digit akhir IC)
  app.get('/api/semak', (req, res) => {
    const ref = str(req.query.rujukan, 30).toUpperCase();
    const ic4 = str(req.query.ic4, 4);
    const c = ref ? db.getClaimByRef(ref) : null;
    if (!c || !/^\d{4}$/.test(ic4) || c.no_ic.slice(-4) !== ic4) {
      return res.status(404).json({ error: 'Tuntutan tidak dijumpai. Semak no. rujukan dan 4 digit akhir IC.' });
    }
    res.json({
      no_rujukan: c.no_rujukan, nama: c.nama, status: c.status,
      tempoh_mula: c.tempoh_mula, tempoh_tamat: c.tempoh_tamat,
      jumlah_jam: c.jumlah_jam, jumlah_bersih: c.jumlah_bersih,
      dihantar_pada: c.dihantar_pada, ulasan_admin: c.ulasan_admin,
      tarikh_bayar: c.tarikh_bayar, rujukan_bayaran: c.rujukan_bayaran,
    });
  });

  // ----- Admin -----
  app.post('/api/admin/login', (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (!safeEqual(pw, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Kata laluan salah.' });
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.set('Set-Cookie',
      `admin_session=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.set('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

  app.get('/api/admin/tuntutan', requireAdmin, (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const q = str(req.query.q, 100);
    res.json({ items: db.listClaims({ status, q }), ringkasan: db.summary() });
  });

  app.get('/api/admin/tuntutan/:id', requireAdmin, (req, res) => {
    const c = db.getClaim(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Tidak dijumpai.' });
    res.json(c);
  });

  app.patch('/api/admin/tuntutan/:id/status', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const c = db.getClaim(id);
    if (!c) return res.status(404).json({ error: 'Tidak dijumpai.' });
    const status = req.body && req.body.status;
    const allowed = {
      DIHANTAR: ['DILULUSKAN', 'DITOLAK'],
      DILULUSKAN: ['DIBAYAR', 'DITOLAK', 'DIHANTAR'],
      DITOLAK: ['DIHANTAR'],
      DIBAYAR: [],
    };
    if (!allowed[c.status].includes(status)) {
      return res.status(400).json({ error: `Status tidak boleh ditukar dari ${c.status} ke ${status}.` });
    }
    const ulasan = str(req.body.ulasan, 500);
    if (status === 'DITOLAK' && !ulasan) return res.status(400).json({ error: 'Sila nyatakan sebab penolakan.' });
    let tarikh_bayar = null;
    let rujukan_bayaran = null;
    if (status === 'DIBAYAR') {
      tarikh_bayar = str(req.body.tarikh_bayar, 10);
      rujukan_bayaran = str(req.body.rujukan_bayaran, 60);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tarikh_bayar)) return res.status(400).json({ error: 'Tarikh bayaran diperlukan.' });
      if (!rujukan_bayaran) return res.status(400).json({ error: 'No. rujukan bayaran / transaksi diperlukan.' });
    }
    db.updateStatus(id, { status, ulasan, tarikh_bayar, rujukan_bayaran });
    res.json(db.getClaim(id));
  });

  app.put('/api/admin/tetapan', requireAdmin, (req, res) => {
    const nama_syarikat = str(req.body && req.body.nama_syarikat, 120);
    const kadar_lalai = num(req.body && req.body.kadar_lalai);
    if (!nama_syarikat) return res.status(400).json({ error: 'Nama syarikat diperlukan.' });
    if (!(kadar_lalai > 0 && kadar_lalai <= 1000)) return res.status(400).json({ error: 'Kadar lalai tidak sah.' });
    db.saveSettings({ nama_syarikat, kadar_lalai: round2(kadar_lalai) });
    res.json(db.getSettings());
  });

  app.get('/api/admin/eksport.csv', requireAdmin, (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const items = db.listClaims({ status, q: '' });
    const cols = ['no_rujukan', 'nama', 'no_ic', 'telefon', 'jawatan', 'jabatan', 'bank', 'no_akaun',
      'nama_pemegang', 'tempoh_mula', 'tempoh_tamat', 'jumlah_jam', 'kadar_sejam', 'gaji_kasar',
      'elaun', 'potongan', 'jumlah_bersih', 'status', 'dihantar_pada', 'tarikh_bayar', 'rujukan_bayaran'];
    const esc = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // elak suntikan formula
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(','), ...items.map((it) => cols.map((k) => esc(it[k])).join(','))];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tuntutan-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Tidak dijumpai.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Data tidak sah.' });
    console.error(err);
    res.status(500).json({ error: 'Ralat pelayan.' });
  });

  return app;
}

if (require.main === module) {
  const db = openDb(DB_PATH);
  createApp(db).listen(PORT, () => {
    console.log(`Sistem Borang Bayaran Part-Time berjalan di http://localhost:${PORT}`);
    console.log(`  Borang pekerja : http://localhost:${PORT}/`);
    console.log(`  Semak status   : http://localhost:${PORT}/semak.html`);
    console.log(`  Pentadbir      : http://localhost:${PORT}/admin.html`);
  });
}

module.exports = { createApp, validateClaim, minutesBetween };
