require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();

// ✅ Allow frontend (Netlify) to call backend (Render)
app.use(cors({
  origin: "*" // 👉 replace * with "https://your-site.netlify.app" for security
}));

app.use(bodyParser.json());
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
        contact TEXT UNIQUE,
        prize TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('DB ready');
  } catch (e) {
    console.error('DB init error', e);
  }
})();

// Google Sheets setup
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
      console.log('Google Sheets client ready');
    }
  } catch (e) {
    console.error('Google Sheets init error', e);
  }
})();

// ----- Routes -----

// ✅ Health check for Netlify splash screen
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Check if user already played
app.get('/checkUser', async (req, res) => {
  try {
    const { contact } = req.query;
    if (!contact) return res.json({ alreadyPlayed: false });
    const result = await pool.query('SELECT * FROM spins WHERE contact=$1', [contact]);
    if (result.rows.length) return res.json({ alreadyPlayed: true, prize: result.rows[0].prize });
    res.json({ alreadyPlayed: false });
  } catch (e) {
    console.error('/checkUser error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Register user
app.post('/register', async (req, res) => {
  try {
    const { name, contact } = req.body;
    const existing = await pool.query('SELECT * FROM spins WHERE contact=$1', [contact]);
    if (existing.rows.length) return res.json({ alreadyPlayed: true, prize: existing.rows[0].prize });
    await pool.query('INSERT INTO spins (name, contact) VALUES ($1, $2)', [name, contact]);
    res.json({ success: true });
  } catch (e) {
    console.error('/register error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save spin result
app.post('/saveResult', async (req, res) => {
  try {
    const { contact, prize } = req.body;
    if (!contact) return res.status(400).json({ error: 'No contact provided' });

    const update = await pool.query(
      'UPDATE spins SET prize=$1, timestamp=NOW() WHERE contact=$2 RETURNING *',
      [prize, contact]
    );
    const row = update.rows[0];

    if (sheetsClient && SPREADSHEET_ID) {
      try {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Sheet1!A:D',
          valueInputOption: 'RAW',
          requestBody: { values: [[row.name, row.contact, row.prize, row.timestamp]] }
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

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
