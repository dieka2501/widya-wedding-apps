require('dotenv').config();

const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const { google } = require('googleapis');

// Tulis credential.json dari env variable (untuk Railway/production)
if (process.env.GOOGLE_CREDENTIALS && !fs.existsSync('./credential.json')) {
  fs.writeFileSync('./credential.json', process.env.GOOGLE_CREDENTIALS);
  console.log('[Startup] credential.json ditulis dari GOOGLE_CREDENTIALS env');
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const CREDENTIAL_PATH = path.join(__dirname, 'credential.json');
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID || '';
const SHEET_RSVP      = process.env.SHEET_NAME    || 'RSVP';
const SHEET_TAMU      = process.env.SHEET_TAMU    || 'tamu';
const BASE_URL        = process.env.BASE_URL    || `http://localhost:${PORT}`;
const TOKEN_SECRET    = process.env.TOKEN_SECRET || 'ganti-dengan-secret-yang-kuat';

if (TOKEN_SECRET === 'ganti-dengan-secret-yang-kuat') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_SECRET wajib disetel dengan nilai acak yang kuat di production.');
  }
  console.warn('⚠   TOKEN_SECRET belum diset di .env — gunakan nilai acak yang kuat!');
}

// ─── Sheet column mapping (A=0, B=1, C=2, D=3, E=4) ─────────────────────────
// A = Nama
// B = is_akad (TRUE/FALSE)
// C = No WA
// D = Token
// E = Link

// ─── HMAC Token ───────────────────────────────────────────────────────────────
function makeToken(akad) {
  const nonce    = crypto.randomBytes(12).toString('hex');
  const akadFlag = akad ? '1' : '0';
  const payload  = nonce + akadFlag;
  const sig      = crypto.createHmac('sha256', TOKEN_SECRET)
                         .update(payload).digest('hex');
  return payload + sig; // 89 chars
}

function verifyToken(token) {
  if (!token || (token.length !== 33 && token.length !== 89)) return { valid: false };
  const payload  = token.substring(0, 25);
  const sig      = token.substring(25);
  const fullSig  = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const expected = token.length === 33 ? fullSig.substring(0, 8) : fullSig;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { valid: false };
  return { valid: true, akad: token[24] === '1' };
}

function makeUrl(token) {
  return `${BASE_URL}/?token=${token}`;
}

// ─── Local File Store ─────────────────────────────────────────────────────────
const guestsFile  = path.join(__dirname, 'guests.json');
const rsvpFile    = path.join(__dirname, 'rsvp.json');
const commentsFile = path.join(__dirname, 'comments.json');
const load = f      => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ─── Google Sheets Client ─────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIAL_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

function canSync() {
  if (!SPREADSHEET_ID) { console.warn('[Sheets] Skip: SPREADSHEET_ID kosong'); return false; }
  if (!fs.existsSync(CREDENTIAL_PATH)) { console.warn('[Sheets] Skip: credential.json tidak ditemukan'); return false; }
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtResp(v) {
  return ({
    'hadir':           'Hadir di Taman Arunika (Resepsi)',
    'hadir-kampoeng':  'Hadir di Taman Arunika (Prosesi)',
    'hadir-hotel':     'Hadir di Taman Arunika (Resepsi)',
    'hadir-keduanya':  'Hadir di Kedua Acara',
    'tidak-hadir':     'Tidak Dapat Hadir',
  })[v] || v;
}

// ─── Sync RSVP → sheet RSVP ──────────────────────────────────────────────────
async function syncRsvpToSheets(data) {
  if (!canSync()) return;
  try {
    const sheets = await getSheetsClient();
    const hdr = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A1:I1`,
    });
    const headerCols = hdr.data.values?.[0] || [];
    const hasHeader  = headerCols[0] === 'Token';
    // Tulis/update header jika belum ada atau format lama (< 9 kolom / belum ada kolom akad-resepsi)
    const needsHeaderUpdate = !hasHeader || headerCols.length < 9 || !headerCols[6]?.includes('Akad');
    if (needsHeaderUpdate) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Token','Nama','Akad','Respons','WhatsApp','Pesan','Jumlah Hadirin Akad','Jumlah Hadirin Resepsi','Waktu Submit']] },
      });
    }
    const col    = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A:A` });
    const tokens = col.data.values || [];
    let rowIdx   = -1;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i]?.[0] === data.token) { rowIdx = i + 1; break; }
    }
    const cAkad    = data.count_akad    != null ? String(data.count_akad)    : '0';
    const cResepsi = data.count_resepsi != null ? String(data.count_resepsi) : '0';
    const row = [
      data.token, data.name, data.akad ? 'Ya' : 'Tidak',
      fmtResp(data.response), data.whatsapp || '', data.message || '',
      cAkad, cResepsi,
      new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    ];
    if (rowIdx > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A${rowIdx}`,
        valueInputOption: 'RAW', requestBody: { values: [row] },
      });
      console.log(`[Sheets] RSVP updated (baris ${rowIdx}): ${data.name}`);
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RSVP}!A1`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
      console.log(`[Sheets] RSVP appended: ${data.name}`);
    }
  } catch (e) {
    console.error(`[Sheets] RSVP sync GAGAL untuk ${data.name}:`, e.message);
    if (e.errors) console.error('[Sheets] Detail:', JSON.stringify(e.errors));
  }
}

// ─── Sync tamu baru → sheet tamu (kolom D=token, E=link) ─────────────────────
async function syncTamuToSheets(token, name, akad, wa, url) {
  if (!canSync()) return;
  try {
    const sheets = await getSheetsClient();
    // Cek apakah token sudah ada di kolom D
    const col    = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAMU}!D:D`,
    });
    const tknCol = col.data.values || [];
    for (let i = 0; i < tknCol.length; i++) {
      if (tknCol[i]?.[0] === token) {
        console.log(`[Sheets] Tamu sudah ada di sheet col D, skip: ${name}`);
        return;
      }
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAMU}!A1`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[name, akad ? 'TRUE' : 'FALSE', wa, token, url]] },
    });
    console.log(`[Sheets] Tamu baru ditambahkan: ${name}`);
  } catch (e) {
    console.error(`[Sheets] Sync tamu GAGAL untuk ${name}:`, e.message);
  }
}

// ─── Import bulk dari sheet tamu ──────────────────────────────────────────────
// Kolom: A=Nama, B=is_akad, C=No WA, D=Token, E=Link
//
// Logic per baris:
//   - Tidak ada nama             → skip
//   - Tidak ada token & link     → BARU
//       - Generate token + link, tulis D+E (WA opsional)
//   - Ada token, tidak ada link  → UPDATE
//       - Pertahankan token, update data, isi link di E
//   - Ada token & link           → EXISTING → refresh cache
async function importFromTamuSheet() {
  const sheets = await getSheetsClient();
  const res    = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAMU}!A2:E`,
  });

  const rows   = res.data.values || [];
  const guests = load(guestsFile);
  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const name    = (rows[i][0] || '').trim();
    const akadRaw = (rows[i][1] || '').trim().toUpperCase();
    const akad    = akadRaw === 'TRUE' || akadRaw === 'YA' || akadRaw === '1';
    const wa      = (rows[i][2] || '').trim();
    const exToken = (rows[i][3] || '').trim();
    const exLink  = (rows[i][4] || '').trim();
    const rowNum  = i + 2;

    if (!name) continue;

    const hasWa = !!wa;

    if (!exToken && !exLink) {
      // BARU — token dan link tidak bergantung pada nomor WhatsApp
      const token = makeToken(akad);
      const url   = makeUrl(token);
      guests[token] = { name, akad, wa };
      updates.push({ rowNum, token, url, status: 'new', hasWa, writeD: true, writeE: true });

    } else if (exToken && !exLink) {
      // UPDATE — pertahankan token dan pastikan link tersedia
      const url = makeUrl(exToken);
      guests[exToken] = { name, akad, wa };
      updates.push({ rowNum, token: exToken, url, status: 'updated', hasWa, writeD: false, writeE: true });

    } else if (exToken && exLink) {
      // EXISTING — refresh cache saja
      guests[exToken] = { name, akad, wa };
      updates.push({ rowNum, token: exToken, url: exLink, status: 'existing', hasWa, writeD: false, writeE: false });
    }
  }

  save(guestsFile, guests);

  // Tulis balik ke Sheets — AWAIT agar tidak race condition dengan import berikutnya
  const toWrite = updates.filter(u => u.writeD || u.writeE);
  let writeBackOk = true;
  if (toWrite.length > 0) {
    const batchData = [];
    toWrite.forEach(u => {
      if (u.writeD && u.writeE) {
        batchData.push({ range: `${SHEET_TAMU}!D${u.rowNum}:E${u.rowNum}`, values: [[u.token, u.url]] });
      } else if (u.writeD) {
        batchData.push({ range: `${SHEET_TAMU}!D${u.rowNum}`, values: [[u.token]] });
      } else if (u.writeE) {
        batchData.push({ range: `${SHEET_TAMU}!E${u.rowNum}`, values: [[u.url]] });
      }
    });

    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: batchData },
      });
      console.log(`[Sheets] Tulis balik ${toWrite.length} baris selesai`);
    } catch (e) {
      writeBackOk = false;
      console.error('[Sheets] Tulis balik GAGAL:', e.message);
    }
  }

  const newCount      = updates.filter(u => u.status === 'new').length;
  const updatedCount  = updates.filter(u => u.status === 'updated').length;
  const existingCount = updates.filter(u => u.status === 'existing').length;
  const noWaCount     = updates.filter(u => !u.hasWa).length;

  return {
    total: updates.length,
    new: newCount, updated: updatedCount, existing: existingCount, noWa: noWaCount,
    writeBackOk,
    guests: updates.map(u => ({
      token: u.token, url: u.url, status: u.status, hasWa: u.hasWa,
      name: guests[u.token]?.name,
      akad: guests[u.token]?.akad,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Ambil data undangan personal berdasarkan token ────────────────────────────
app.get('/api/pre-validate', async (req, res) => {
  const { token } = req.query;

  // 1. Cek HMAC
  const result = verifyToken(token);
  if (!result.valid) return res.status(403).json({ valid: false });

  // 2. Cari di guests.json
  let guest = load(guestsFile)[token];

  // 3. Fallback ke Sheets jika tidak ada di cache
  if (!guest && canSync()) {
    try {
      const sheets = await getSheetsClient();
      const col    = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_TAMU}!A:D`,
      });
      const rows = col.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        if ((rows[i][3] || '').trim() === token) {
          const name    = (rows[i][0] || '').trim();
          const wa      = (rows[i][2] || '').trim();
          const akadRaw = (rows[i][1] || '').trim().toUpperCase();
          const akad    = akadRaw === 'TRUE' || akadRaw === 'YA' || akadRaw === '1';
          if (name) {
            // Cache meskipun WA kosong — agar tidak selalu hit Sheets
            const guests  = load(guestsFile);
            guests[token] = { name, akad, wa };
            save(guestsFile, guests);
            guest = guests[token];
          }
          break;
        }
      }
    } catch(e) {
      console.error('[PreValidate] Sheets fallback gagal:', e.message);
    }
  }

  if (!guest) return res.status(403).json({ valid: false });

  // Token pada URL menjadi identitas personal; kode WhatsApp tidak lagi diminta.
  res.json({ valid: true, name: guest.name, akad: guest.akad });
});

// ── Public guestbook comments ────────────────────────────────────────────────
const COMMENT_PAGE_SIZE = 8;

app.get('/api/comments', (req, res) => {
  const comments = load(commentsFile);
  const sorted = (Array.isArray(comments) ? comments : [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = sorted.length;
  const totalPages = Math.ceil(total / COMMENT_PAGE_SIZE);
  const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const start = (page - 1) * COMMENT_PAGE_SIZE;

  res.json({
    comments: sorted.slice(start, start + COMMENT_PAGE_SIZE),
    page,
    pageSize: COMMENT_PAGE_SIZE,
    total,
    totalPages
  });
});

app.post('/api/comments', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!name || !message) {
    return res.status(400).json({ success: false, message: 'Nama dan ucapan wajib diisi.' });
  }
  if (name.length > 80 || message.length > 500) {
    return res.status(400).json({ success: false, message: 'Nama maksimal 80 karakter dan ucapan maksimal 500 karakter.' });
  }

  const comments = load(commentsFile);
  const entry = {
    id: crypto.randomBytes(16).toString('hex'),
    name,
    message,
    createdAt: new Date().toISOString()
  };
  const list = Array.isArray(comments) ? comments : [];
  list.push(entry);
  save(commentsFile, list);

  res.status(201).json({ success: true, comment: entry });
});

// ── Cek status RSVP tamu (sudah submit atau belum) ───────────────────────────
app.get('/api/rsvp-status', (req, res) => {
  const { token } = req.query;
  const result = verifyToken(token);
  if (!result.valid) return res.status(403).json({ valid: false });
  const rsvp = load(rsvpFile);
  const entry = rsvp[token];
  if (entry) {
    res.json({ submitted: true, response: entry.response });
  } else {
    res.json({ submitted: false });
  }
});

// ── Submit RSVP ───────────────────────────────────────────────────────────────
app.post('/api/rsvp', async (req, res) => {
  const { token, response, message, whatsapp, count, count_akad, count_resepsi } = req.body;
  if (!token || !response) return res.status(400).json({ success: false, message: 'Missing fields' });

  const result = verifyToken(token);
  if (!result.valid) return res.status(403).json({ success: false, message: 'Invalid token' });

  const guests = load(guestsFile);
  const name   = guests[token]?.name || 'Tamu Undangan';
  // Akad dari guests.json agar perubahan di sheet (via import) langsung berlaku
  const akad   = guests[token]?.akad ?? result.akad;

  // Dukung format lama (count) dan format baru (count_akad + count_resepsi)
  const cAkad    = parseInt(count_akad)    || 0;
  const cResepsi = parseInt(count_resepsi) || 0;
  const cTotal   = cAkad + cResepsi || parseInt(count) || 0;

  const rsvp  = load(rsvpFile);
  rsvp[token] = {
    name, akad, response,
    message: message || '', whatsapp: whatsapp || '',
    count_akad: cAkad, count_resepsi: cResepsi, count: cTotal,
    submittedAt: new Date().toISOString()
  };
  save(rsvpFile, rsvp);

  syncRsvpToSheets({ token, name, akad, response, message, whatsapp, count_akad: cAkad, count_resepsi: cResepsi, count: cTotal })
    .catch(e => console.error('[RSVP] Unhandled sync error:', e.message));

  res.json({ success: true });
});

// ── Admin auth middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ error: 'ADMIN_KEY belum dikonfigurasi' });
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Generate token manual ─────────────────────────────────────────────────────
app.post('/api/admin/generate-token', adminAuth, async (req, res) => {
  const { name, akad, wa } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const isAkad  = akad === true || akad === 'true';
  const token   = makeToken(isAkad);
  const guests  = load(guestsFile);
  guests[token] = { name, akad: isAkad, wa: wa || '' };
  save(guestsFile, guests);
  const url = makeUrl(token);

  syncTamuToSheets(token, name, isAkad, wa || '', url)
    .catch(e => console.error('[Generate] Sync error:', e.message));

  res.json({ token, url, name, akad: isAkad, wa: wa || '' });
});

// ── Update guest (semua field, token sebagai primary key) ─────────────────────
app.put('/api/admin/guest/:token', adminAuth, async (req, res) => {
  const { token } = req.params;
  const { name, akad, wa } = req.body;

  const result = verifyToken(token);
  if (!result.valid) return res.status(400).json({ error: 'Token tidak valid' });

  const guests = load(guestsFile);
  if (!guests[token]) return res.status(404).json({ error: 'Token tidak ditemukan di guests.json' });

  const prevWa = guests[token].wa || '';

  if (name !== undefined) guests[token].name = name;
  if (akad !== undefined) guests[token].akad = akad === true || akad === 'true';
  if (wa   !== undefined) guests[token].wa   = wa;

  save(guestsFile, guests);

  // Sync ke Sheets — baca D+E sekaligus untuk tahu apakah link perlu ditulis
  if (canSync()) {
    try {
      const sheets = await getSheetsClient();
      const col    = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAMU}!D:E`,
      });
      const rows   = col.data.values || [];
      let rowIdx   = -1;
      let exLink   = '';
      for (let i = 1; i < rows.length; i++) {
        if ((rows[i]?.[0] || '') === token) {
          rowIdx = i + 1;
          exLink = (rows[i]?.[1] || '').trim();
          break;
        }
      }
      if (rowIdx > 0) {
        const g           = guests[token];
        const newWa       = g.wa || '';
        // Tulis link jika WA baru ada dan (link belum ada ATAU WA berubah)
        const writeLink   = !exLink || prevWa !== newWa;
        const url         = writeLink ? makeUrl(token) : exLink;
        const range       = writeLink ? `${SHEET_TAMU}!A${rowIdx}:E${rowIdx}` : `${SHEET_TAMU}!A${rowIdx}:C${rowIdx}`;
        const values      = writeLink
          ? [[g.name, g.akad ? 'TRUE' : 'FALSE', g.wa, token, url]]
          : [[g.name, g.akad ? 'TRUE' : 'FALSE', g.wa]];

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values },
        });
        console.log(`[Update] Baris ${rowIdx}: ${g.name}${writeLink ? ' + link digenerate' : ''}`);
        return res.json({ success: true, token, url: url || '', ...g });
      }
    } catch(e) {
      console.error('[Update] Sync ke Sheets gagal:', e.message);
    }
  }

  const finalUrl = makeUrl(token);
  res.json({ success: true, token, url: finalUrl, ...guests[token] });
});

// ── Import bulk dari sheet tamu ───────────────────────────────────────────────
app.post('/api/admin/import-tamu', adminAuth, async (req, res) => {
  if (!SPREADSHEET_ID) return res.status(400).json({ error: 'SPREADSHEET_ID not set' });
  try {
    const result = await importFromTamuSheet();
    console.log(`[Import] Baru: ${result.new}, Update: ${result.updated}, Existing: ${result.existing}, No WA: ${result.noWa}`);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[Import] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Daftar tamu ───────────────────────────────────────────────────────────────
app.get('/api/admin/guests', adminAuth, (req, res) => {
  const guests = load(guestsFile);
  const rsvp   = load(rsvpFile);
  res.json(Object.entries(guests).map(([t, g]) => ({
    token: t, ...g, rsvp: rsvp[t] || null,
  })));
});

// ── Sync semua RSVP lokal ke Sheets ──────────────────────────────────────────
app.post('/api/admin/sync-sheets', adminAuth, async (req, res) => {
  const rsvp = load(rsvpFile);
  let synced = 0;
  for (const [token, data] of Object.entries(rsvp)) {
    await syncRsvpToSheets({ token, ...data });
    synced++;
  }
  res.json({ success: true, synced });
});

// ── Reset data lokal ──────────────────────────────────────────────────────────
app.post('/api/admin/reset', adminAuth, (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Kirim { "confirm": "RESET" } untuk konfirmasi' });
  const guestCount = Object.keys(load(guestsFile)).length;
  const rsvpCount  = Object.keys(load(rsvpFile)).length;
  save(guestsFile, {});
  save(rsvpFile, {});
  console.log(`[Reset] ${guestCount} tamu dan ${rsvpCount} RSVP direset`);
  res.json({ success: true, message: `Reset selesai. ${guestCount} tamu dan ${rsvpCount} RSVP dihapus.` });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🌸  http://localhost:${PORT}`);
  console.log(`    Admin → http://localhost:${PORT}/admin.html\n`);
  if (!SPREADSHEET_ID)                 console.warn('⚠   SPREADSHEET_ID belum diset');
  if (!fs.existsSync(CREDENTIAL_PATH)) console.warn('⚠   credential.json tidak ditemukan');
});
