'use strict';
process.env.ADMIN_PASSWORD = 'rahsia';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, minutesBetween } = require('../server');
const { openDb } = require('../db');

const sample = () => ({
  nama: 'Ali bin Abu', no_ic: '900101-01-1234', telefon: '0123456789', jawatan: 'Pembantu Kedai',
  bank: 'Maybank', no_akaun: '1122334455', tempoh_mula: '2026-11-01', tempoh_tamat: '2026-11-07',
  kadar_sejam: 10, elaun: 20, potongan: 5, pengakuan: true,
  kehadiran: [
    { tarikh: '2026-11-01', masa_mula: '09:00', masa_tamat: '17:00', rehat_minit: 60 },
    { tarikh: '2026-11-02', masa_mula: '22:00', masa_tamat: '02:00', rehat_minit: 0 },
  ],
});

let server, base;
test.before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const j = (path, opts = {}) => fetch(base + path, {
  ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

test('minutesBetween handles overnight shifts', () => {
  assert.strictEqual(minutesBetween('09:00', '17:30'), 510);
  assert.strictEqual(minutesBetween('22:00', '02:00'), 240);
  assert.strictEqual(minutesBetween('25:00', '02:00'), null);
});

test('full flow: submit, check, approve, pay', async () => {
  const r = await j('/api/tuntutan', { method: 'POST', body: sample() });
  assert.strictEqual(r.status, 201);
  const { no_rujukan, jumlah_bersih } = await r.json();
  assert.match(no_rujukan, /^PT-\d{6}-0001$/);
  // 7h + 4h = 11h * 10 = 110 + 20 - 5 = 125
  assert.strictEqual(jumlah_bersih, 125);

  const bad = await j(`/api/semak?rujukan=${no_rujukan}&ic4=0000`);
  assert.strictEqual(bad.status, 404);
  const ok = await j(`/api/semak?rujukan=${no_rujukan}&ic4=1234`);
  assert.strictEqual((await ok.json()).status, 'DIHANTAR');

  assert.strictEqual((await j('/api/admin/tuntutan')).status, 401);
  assert.strictEqual((await j('/api/admin/login', { method: 'POST', body: { password: 'salah' } })).status, 401);
  const login = await j('/api/admin/login', { method: 'POST', body: { password: 'rahsia' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const H = { Cookie: cookie };

  const list = await (await j('/api/admin/tuntutan', { headers: H })).json();
  assert.strictEqual(list.items.length, 1);
  const id = list.items[0].id;

  // cannot pay before approval
  let s = await j(`/api/admin/tuntutan/${id}/status`, { method: 'PATCH', headers: H, body: { status: 'DIBAYAR' } });
  assert.strictEqual(s.status, 400);
  // reject requires a reason
  s = await j(`/api/admin/tuntutan/${id}/status`, { method: 'PATCH', headers: H, body: { status: 'DITOLAK' } });
  assert.strictEqual(s.status, 400);

  s = await j(`/api/admin/tuntutan/${id}/status`, { method: 'PATCH', headers: H, body: { status: 'DILULUSKAN' } });
  assert.strictEqual((await s.json()).status, 'DILULUSKAN');
  s = await j(`/api/admin/tuntutan/${id}/status`, { method: 'PATCH', headers: H,
    body: { status: 'DIBAYAR', tarikh_bayar: '2026-11-08', rujukan_bayaran: 'IBG123' } });
  const paid = await s.json();
  assert.strictEqual(paid.status, 'DIBAYAR');
  assert.strictEqual(paid.log.length, 3);

  const csv = await (await j('/api/admin/eksport.csv', { headers: H })).text();
  assert.match(csv, /IBG123/);
});

test('server recalculates and rejects invalid data', async () => {
  const body = sample();
  body.no_ic = '123';
  body.kehadiran = [{ tarikh: '2026-12-01', masa_mula: '09:00', masa_tamat: '10:00' }];
  body.pengakuan = false;
  const r = await j('/api/tuntutan', { method: 'POST', body });
  assert.strictEqual(r.status, 400);
  const { errors } = await r.json();
  assert.ok(errors.some((e) => e.includes('12 digit')));
  assert.ok(errors.some((e) => e.includes('luar tempoh')));
  assert.ok(errors.some((e) => e.includes('pengakuan')));
});

test('CSV escapes formula injection', async () => {
  const body = sample();
  body.nama = '=HYPERLINK("x")';
  await j('/api/tuntutan', { method: 'POST', body });
  const login = await j('/api/admin/login', { method: 'POST', body: { password: 'rahsia' } });
  const csv = await (await j('/api/admin/eksport.csv', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })).text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
