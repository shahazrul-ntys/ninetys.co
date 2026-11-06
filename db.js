'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tuntutan (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  no_rujukan      TEXT UNIQUE NOT NULL,
  nama            TEXT NOT NULL,
  no_ic           TEXT NOT NULL,
  telefon         TEXT NOT NULL,
  emel            TEXT,
  jawatan         TEXT NOT NULL,
  jabatan         TEXT,
  bank            TEXT NOT NULL,
  no_akaun        TEXT NOT NULL,
  nama_pemegang   TEXT NOT NULL,
  tempoh_mula     TEXT NOT NULL,
  tempoh_tamat    TEXT NOT NULL,
  kadar_sejam     REAL NOT NULL,
  jumlah_jam      REAL NOT NULL,
  gaji_kasar      REAL NOT NULL,
  elaun           REAL NOT NULL DEFAULT 0,
  potongan        REAL NOT NULL DEFAULT 0,
  jumlah_bersih   REAL NOT NULL,
  catatan         TEXT,
  status          TEXT NOT NULL DEFAULT 'DIHANTAR',
  ulasan_admin    TEXT,
  tarikh_bayar    TEXT,
  rujukan_bayaran TEXT,
  dihantar_pada   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  dikemaskini_pada TEXT
);
CREATE TABLE IF NOT EXISTS kehadiran (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tuntutan_id  INTEGER NOT NULL REFERENCES tuntutan(id) ON DELETE CASCADE,
  tarikh       TEXT NOT NULL,
  masa_mula    TEXT NOT NULL,
  masa_tamat   TEXT NOT NULL,
  rehat_minit  INTEGER NOT NULL DEFAULT 0,
  jam          REAL NOT NULL,
  tugas        TEXT
);
CREATE TABLE IF NOT EXISTS log_status (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tuntutan_id  INTEGER NOT NULL REFERENCES tuntutan(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  ulasan       TEXT,
  pada         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS tetapan (
  kunci TEXT PRIMARY KEY,
  nilai TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tuntutan_status ON tuntutan(status);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO tetapan (kunci, nilai) VALUES ('nama_syarikat', 'Ninetys'), ('kadar_lalai', '10')").run();

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  function nextRef() {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    const prefix = `PT-${ym}-`;
    const row = db.prepare('SELECT no_rujukan FROM tuntutan WHERE no_rujukan LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}%`);
    const n = row ? Number(row.no_rujukan.slice(prefix.length)) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  }

  return {
    raw: db,

    getSettings() {
      const rows = db.prepare('SELECT kunci, nilai FROM tetapan').all();
      const s = Object.fromEntries(rows.map((r) => [r.kunci, r.nilai]));
      return { nama_syarikat: s.nama_syarikat, kadar_lalai: Number(s.kadar_lalai) };
    },

    saveSettings({ nama_syarikat, kadar_lalai }) {
      const st = db.prepare('INSERT INTO tetapan (kunci, nilai) VALUES (?, ?) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai');
      tx(() => { st.run('nama_syarikat', nama_syarikat); st.run('kadar_lalai', String(kadar_lalai)); });
    },

    createClaim(c, rows) {
      return tx(() => {
        const no_rujukan = nextRef();
        const info = db.prepare(`INSERT INTO tuntutan
          (no_rujukan, nama, no_ic, telefon, emel, jawatan, jabatan, bank, no_akaun, nama_pemegang,
           tempoh_mula, tempoh_tamat, kadar_sejam, jumlah_jam, gaji_kasar, elaun, potongan, jumlah_bersih, catatan)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          no_rujukan, c.nama, c.no_ic, c.telefon, c.emel || null, c.jawatan, c.jabatan || null, c.bank,
          c.no_akaun, c.nama_pemegang, c.tempoh_mula, c.tempoh_tamat, c.kadar_sejam, c.jumlah_jam,
          c.gaji_kasar, c.elaun, c.potongan, c.jumlah_bersih, c.catatan || null);
        const id = Number(info.lastInsertRowid);
        const ins = db.prepare('INSERT INTO kehadiran (tuntutan_id, tarikh, masa_mula, masa_tamat, rehat_minit, jam, tugas) VALUES (?,?,?,?,?,?,?)');
        for (const r of rows) ins.run(id, r.tarikh, r.masa_mula, r.masa_tamat, r.rehat_minit, r.jam, r.tugas || null);
        db.prepare("INSERT INTO log_status (tuntutan_id, status, ulasan) VALUES (?, 'DIHANTAR', 'Tuntutan dihantar oleh pekerja')").run(id);
        return { id, no_rujukan };
      });
    },

    getClaim(id) {
      const c = db.prepare('SELECT * FROM tuntutan WHERE id = ?').get(id);
      if (!c) return null;
      c.kehadiran = db.prepare('SELECT tarikh, masa_mula, masa_tamat, rehat_minit, jam, tugas FROM kehadiran WHERE tuntutan_id = ? ORDER BY tarikh, masa_mula').all(id);
      c.log = db.prepare('SELECT status, ulasan, pada FROM log_status WHERE tuntutan_id = ? ORDER BY id').all(id);
      return { ...c };
    },

    getClaimByRef(ref) {
      const c = db.prepare('SELECT * FROM tuntutan WHERE no_rujukan = ?').get(ref);
      return c ? { ...c } : null;
    },

    listClaims({ status, q }) {
      const where = [];
      const args = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (q) {
        where.push('(nama LIKE ? OR no_rujukan LIKE ? OR no_ic LIKE ? OR jawatan LIKE ?)');
        const like = `%${q}%`;
        args.push(like, like, like, like);
      }
      const sql = `SELECT id, no_rujukan, nama, no_ic, telefon, emel, jawatan, jabatan, bank, no_akaun, nama_pemegang,
        tempoh_mula, tempoh_tamat, kadar_sejam, jumlah_jam, gaji_kasar, elaun, potongan, jumlah_bersih,
        status, dihantar_pada, tarikh_bayar, rujukan_bayaran
        FROM tuntutan ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`;
      return db.prepare(sql).all(...args).map((r) => ({ ...r }));
    },

    summary() {
      const rows = db.prepare('SELECT status, COUNT(*) AS bil, COALESCE(SUM(jumlah_bersih),0) AS jumlah FROM tuntutan GROUP BY status').all();
      const out = {};
      for (const s of ['DIHANTAR', 'DILULUSKAN', 'DITOLAK', 'DIBAYAR']) out[s] = { bil: 0, jumlah: 0 };
      for (const r of rows) out[r.status] = { bil: r.bil, jumlah: Math.round(r.jumlah * 100) / 100 };
      return out;
    },

    updateStatus(id, { status, ulasan, tarikh_bayar, rujukan_bayaran }) {
      tx(() => {
        db.prepare(`UPDATE tuntutan SET status = ?, ulasan_admin = ?, tarikh_bayar = ?, rujukan_bayaran = ?,
          dikemaskini_pada = datetime('now', 'localtime') WHERE id = ?`)
          .run(status, ulasan || null, tarikh_bayar, rujukan_bayaran, id);
        db.prepare('INSERT INTO log_status (tuntutan_id, status, ulasan) VALUES (?, ?, ?)')
          .run(id, status, ulasan || (status === 'DIBAYAR' ? `Dibayar: ${rujukan_bayaran}` : null));
      });
    },
  };
}

module.exports = { openDb };
