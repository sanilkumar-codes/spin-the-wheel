require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { google } = require('googleapis');
const sheets = require("./sheets");
const app = express();
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
// Postgres pool
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});
// Ensure table exists
(async () => {
try {
await pool.query(`
CREATE TABLE IF NOT EXISTS spins (
id SERIAL PRIMARY KEY,
name TEXT,
contact TEXT,
prize TEXT,
timestamp TIMESTAMPTZ DEFAULT NOW()
)
`);
console.log('DB ready');
} catch (e) {
console.error('DB init error', e);
}
})();
// Google Sheets setup: load credentials.json from backend folder
let sheetsClient = null;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
(async () => {
try {
if (process.env.GOOGLE_CREDENTIALS) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  console.log('Google Sheets client ready (via ENV)');
} else {
  console.warn('No Google credentials found. Sheets integration disabled.');
}

} catch (e) {
console.error('Google Sheets init error', e);
}
})();
// ----- Routes -----
// check if current user already played (cookie-based)
app.get('/checkUser', async (req, res) => {
try {
if (!req.cookies.userId) return res.json({ alreadyPlayed: false });
const id = parseInt(req.cookies.userId, 10);
const result = await pool.query('SELECT * FROM spins WHERE id=$1', [id]);
if (result.rows.length) {
return res.json({ alreadyPlayed: true, prize: result.rows[0].prize });
}
res.json({ alreadyPlayed: false });
} catch (e) {
console.error('/checkUser error', e);
res.status(500).json({ error: 'Server error' });
}
});
// register user (store name+contact, create a row and set cookie to id)
app.post('/register', async (req, res) => {
try {
const { name, contact } = req.body;
const insert = await pool.query(
'INSERT INTO spins (name, contact) VALUES ($1, $2) RETURNING id',
[name, contact]
);
const id = insert.rows[0].id;
res.cookie('userId', id, { httpOnly: true });
res.json({ success: true });
} catch (e) {
console.error('/register error', e);
res.status(500).json({ error: 'Server error' });
}
});
// save spin result and append to Google Sheet
app.post('/saveResult', async (req, res) => {
try {
const { prize } = req.body;
const id = parseInt(req.cookies.userId, 10);
if (!id) return res.status(400).json({ error: 'No userId cookie' });
const update = await pool.query(
'UPDATE spins SET prize=$1, timestamp=NOW() WHERE id=$2 RETURNING *',
[prize, id]
);
const row = update.rows[0];
// Append to Google Sheet if client available
if (sheetsClient && SPREADSHEET_ID) {
try {
await sheetsClient.spreadsheets.values.append({
spreadsheetId: SPREADSHEET_ID,
range: 'Sheet1!A:D',
valueInputOption: 'RAW',
requestBody: { values: [[row.name, row.contact, row.prize,
row.timestamp]] }
});
} catch (e) {
console.error('Sheets append error', e);
}
}
res.json({ success: true, prize: row.prize });
} catch (e) {
console.error('/saveResult error', e);
res.status(500).json({ error: 'Server error' });
}
});
// Serve admin page (exists in project root)
app.get('/admin', (req, res) => {
res.sendFile(path.join(__dirname, 'admin.html'));
});
// Admin login
app.post('/admin/login', (req, res) => {
const password = req.body.password;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'supersecret123';
if (password === ADMIN_PASSWORD) {
res.cookie('admin', 'true', { httpOnly: true });
res.json({ success: true });
} else {
res.json({ success: false });
}
});
// Admin data (requires cookie admin=true)
app.get('/admin/data', async (req, res) => {
if (req.cookies.admin !== 'true') return res.status(403).json({ error:
'Unauthorized' });
try {
const result = await pool.query('SELECT * FROM spins ORDER BY id DESC');
res.json(result.rows);
} catch (e) {
console.error('/admin/data error', e);
res.status(500).json({ error: 'Server error' });
}
});
// Admin export CSV
app.get('/admin/export', async (req, res) => {
if (req.cookies.admin !== 'true') return res.status(403).send('Unauthorized');
try {
const result = await pool.query('SELECT * FROM spins ORDER BY id DESC');
let csv = 'Name,Contact,Prize,Timestamp\n';
result.rows.forEach(r => {
// basic csv escaping (commas will break CSV if present in fields)
const esc = v => (v === null || v === undefined) ? '' :
String(v).replace(/\"/g, '""');
csv += `"${esc(r.name)}","${esc(r.contact)}","${esc(r.prize)}","$
{r.timestamp}"\n`;
});
res.header('Content-Type', 'text/csv');
res.attachment('spins.csv');
res.send(csv);
} catch (e) {
console.error('/admin/export error', e);
res.status(500).send('Server error');
}
});
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
