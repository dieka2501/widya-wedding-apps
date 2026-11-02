# Undangan Pernikahan Widya & Andi
## Wedding Invitation Web App

### Teknologi
- Node.js + Express (backend)
- Vanilla HTML/CSS/JS (frontend)
- Google Apps Script (RSVP ke Google Sheets)
- Token-based access control

---

## Struktur Proyek

```
wedding-invitation/
├── server.js           # Express server utama
├── package.json
├── guests.json         # Data tamu & token (auto-generated)
├── rsvp.json           # Data RSVP (auto-generated)
├── public/
│   ├── index.html      # Halaman undangan
│   └── admin.html      # Panel admin
└── README.md
```

---

## Setup & Instalasi

### 1. Install dependencies
```bash
npm install
```

### 2. Buat file .env
```bash
cp .env.example .env
```
Edit `.env`:
```
PORT=3000
ADMIN_KEY=password-rahasia-anda
GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
BASE_URL=https://domain-anda.com
```

### 3. Setup Google Apps Script (untuk RSVP ke Google Sheets)
1. Buka Google Sheets baru → beri nama bebas
2. Buka **Extensions > Apps Script**
3. Copy-paste isi file `google-apps-script.txt` ke editor
4. Klik **Deploy > New Deployment**
5. Pilih type: **Web App**
6. Set "Who has access": **Anyone**
7. Copy URL deployment → paste ke `GOOGLE_SCRIPT_URL` di `.env`

### 4. Jalankan server
```bash
npm start
# atau untuk development:
npm run dev
```

---

## Cara Pakai

### Panel Admin
Buka: `http://localhost:3000/admin.html`

Masukkan ADMIN_KEY yang sudah diatur di `.env`

Fitur admin:
- Generate link undangan per tamu
- Set apakah tamu bisa lihat info akad
- Lihat statistik RSVP real-time
- Salin link undangan

### Format Link Undangan
```
https://domain-anda.com/?token=ABC123&akad=true
https://domain-anda.com/?token=XYZ456&akad=false
```

- `token` = unik per tamu, validasi di server
- `akad=true` → tampilkan info lokasi akad + pilihan RSVP lengkap
- `akad=false` → hanya info resepsi + RSVP hadir/tidak hadir

---

## API Endpoints

| Method | Endpoint | Keterangan |
|--------|----------|------------|
| GET | `/api/validate?token=XXX` | Validasi token tamu |
| POST | `/api/rsvp` | Submit RSVP |
| POST | `/api/admin/generate-token` | Buat token baru (auth: x-admin-key) |
| GET | `/api/admin/guests` | Daftar semua tamu (auth: x-admin-key) |
| GET | `/api/admin/rsvp` | Semua data RSVP (auth: x-admin-key) |

---

## Deployment (Railway / Render)

### Railway
1. Push ke GitHub
2. Connect repo di railway.app
3. Add environment variables di dashboard
4. Deploy otomatis

### Render
1. Push ke GitHub
2. New Web Service di render.com
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables

---

## Catatan Penting
- `guests.json` dan `rsvp.json` tersimpan di server lokal. Untuk production, pertimbangkan menggunakan database (PostgreSQL / MongoDB).
- Pada platform seperti Railway/Render, file storage bersifat ephemeral — data akan hilang jika server restart. Gunakan external DB atau tetap andalkan Google Sheets sebagai storage utama.
- Untuk production dengan banyak tamu (100+), tambahkan rate limiting.

---

## Info Acara
- **Akad Nikah & Pemberkatan**: Kampoeng Percik, Sabtu 1 Mei 2026, 14:00–15:30 WIB
- **Resepsi**: Hotel Wahid Prime, Sabtu 1 Mei 2026, 16:30 WIB
