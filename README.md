# Sistem Borang Bayaran Pekerja Part-Time

Sistem web ringkas untuk pekerja separuh masa menghantar tuntutan bayaran, dan untuk pentadbir menyemak, meluluskan serta merekod pembayaran.

## Ciri-ciri

**Pekerja** (`/`)
- Borang maklumat diri, akaun bank dan rekod kehadiran harian (masa masuk/keluar, rehat, tugas)
- Jam dan jumlah bayaran dikira automatik (syif melepasi tengah malam disokong)
- Elaun dan potongan
- Dapat no. rujukan (cth. `PT-202611-0001`) selepas hantar
- Semak status di `/semak.html` dengan no. rujukan + 4 digit akhir IC

**Pentadbir** (`/admin.html`)
- Log masuk dengan kata laluan
- Ringkasan mengikut status, carian dan tapisan
- Aliran kerja: **Dihantar → Diluluskan → Dibayar** (atau **Ditolak** dengan sebab)
- Rekod tarikh bayaran dan no. rujukan transaksi (DuitNow / IBG)
- Sejarah perubahan status bagi setiap tuntutan
- Cetak baucar bayaran (A4) dengan ruang tandatangan
- Eksport CSV (boleh dibuka dalam Excel)
- Tetapan nama syarikat dan kadar sejam lalai

Semua kiraan disahkan semula di pelayan — angka dari pelayar tidak dipercayai.

## Menjalankan

Perlu Node.js 22.5 ke atas (guna SQLite terbina dalam Node).

```bash
npm install
ADMIN_PASSWORD='kata-laluan-kuat' SESSION_SECRET='rentetan-rawak-panjang' npm start
```

Buka http://localhost:3000

| Pemboleh ubah     | Lalai                | Keterangan                                      |
|-------------------|----------------------|-------------------------------------------------|
| `PORT`            | `3000`               | Port pelayan                                    |
| `ADMIN_PASSWORD`  | `admin123`           | **Wajib ditukar** untuk penggunaan sebenar      |
| `SESSION_SECRET`  | rawak setiap mula    | Tetapkan supaya sesi kekal selepas restart      |
| `DB_PATH`         | `data/bayaran.db`    | Lokasi fail pangkalan data SQLite               |

## Ujian

```bash
npm test
```

## Struktur

```
server.js        API Express, pengesahan & pengiraan
db.js            Skema dan pertanyaan SQLite
public/          Halaman borang, semak status, pentadbir, baucar
test/            Ujian API
```
