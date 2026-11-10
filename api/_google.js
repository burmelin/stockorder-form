// Shared helpers for the Sheets API. Files starting with "_" are not exposed as routes on Vercel.
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID || '1UG4WQG3vOiytArJT1U03CdQPwjPlMb9-3wy1OGzoLmw';
const MOCK = !process.env.GOOGLE_PRIVATE_KEY || !(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || /client_email/.test(process.env.GOOGLE_PRIVATE_KEY));

// Tolerate the common ways a private key gets mangled when pasted into a host's
// env-var UI: wrapping quotes, escaped "\n" instead of real newlines, stray CRs,
// extra text around the key. The whole service-account JSON file can also be pasted
// as GOOGLE_PRIVATE_KEY (open the file, Ctrl+A, Ctrl+C): its private_key is used.
function parseServiceAccountJson(raw) {
  const t = (raw || '').trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function normalizePrivateKey(raw) {
  const json = parseServiceAccountJson(raw);
  let k = (json && json.private_key ? json.private_key : raw || '').trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  k = k.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  const pem = k.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/);
  return pem ? pem[0] + '\n' : k;
}

// The service account email: GOOGLE_SERVICE_ACCOUNT_EMAIL, or client_email from a pasted JSON file
function serviceAccountEmail() {
  const json = parseServiceAccountJson(process.env.GOOGLE_PRIVATE_KEY);
  return (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || (json && json.client_email) || '').trim();
}

function getSheetsClient() {
  const key = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY looks malformed. Easiest fix: open the key .json file, select all (Ctrl+A), copy, and paste the whole file as GOOGLE_PRIVATE_KEY.');
  }
  const auth = new google.auth.JWT(
    serviceAccountEmail(),
    null,
    key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// The old finance PIN (finance sheet, Lists!K2, or APP_PIN). No longer used to let anyone in:
// Finance is owner-login only. Kept so nothing that still reads it breaks.
async function currentPin() {
  if (!MOCK) {
    const resp = await getSheetsClient().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Lists'!K2" });
    const fromSheet = String(((resp.data.values || [])[0] || [])[0] ?? '').trim();
    if (fromSheet) return fromSheet;
  }
  return String(process.env.APP_PIN || '').trim();
}

// Signed in through the staff app's admin login ("Settings" = Owner)? The staff app keeps a
// signed 30-day token from its Apps Script server in localStorage; the finance page, on the
// same site, sends it as x-owner-token. Only the Apps Script server can check that token, so
// we ask it with the same verifyOwner call its own login uses: a shop's token carries that
// shop's password, which verifyOwner refuses. A yes is remembered for a few minutes so each
// screen doesn't wait on Apps Script; a changed Settings password signs phones out within that.
const OWNER_CHECK_URL = process.env.OWNER_CHECK_URL
  || 'https://script.google.com/macros/s/AKfycby-5YfvPpePbg1ni36sL5AI-DelH_I5qHgm1mkmAKqBSsopJPn-YWi24kXDMPMFkD-v/exec';
const OWNER_OK_MS = 5 * 60 * 1000;
const ownerOkUntil = new Map();

const ownerChecking = new Map();   // token -> the check already on its way (a page asks several things at once)

async function isOwnerRequest(req) {
  const token = String(req.headers['x-owner-token'] || '').trim();
  if (!token || token.length > 2000) return false;
  const until = ownerOkUntil.get(token);
  if (until && until > Date.now()) return true;
  if (!ownerChecking.has(token)) {
    ownerChecking.set(token, askOwner(token).finally(() => ownerChecking.delete(token)));
  }
  return ownerChecking.get(token);
}

async function askOwner(token) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(OWNER_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'verifyOwner', token }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (!data || data.success !== true) return false;
  } catch (err) {
    console.error('Owner check failed:', err.message);
    return false;
  }
  if (ownerOkUntil.size > 200) ownerOkUntil.clear();
  ownerOkUntil.set(token, Date.now() + OWNER_OK_MS);
  return true;
}

// Gate for every finance request: only the owner, signed in through the staff app's admin
// login (above). There is no PIN any more: a PIN had no limit on guesses. In sample mode (no
// Google key, on a computer) the gate is open so the app can be tried out.
// (Still named checkPin so every route keeps the same one-line check.)
async function checkPin(req, res) {
  if (MOCK) return true;
  if (await isOwnerRequest(req)) return true;
  res.status(401).json({ error: 'Owner login required', needOwner: true });
  return false;
}

// Google Sheets serial date -> JS Date (sheet epoch is 1899-12-30)
function serialToDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return isFinite(n) ? n : 0;
}

// Reads Master Entry once and returns the parsed rows, the first empty row (after the
// last used one, judged by column A) and the sheet's last row — enough to append and
// to check for duplicates without a second request.
async function readMasterEntry(sheets) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "'Master Entry'!A2:L",
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  // An open-ended range comes back as e.g. 'Master Entry'!A2:L5000 — the sheet's size.
  const lastRow = parseInt(String(resp.data.range || '').match(/(\d+)$/)?.[1], 10) || Infinity;
  const rows = [];
  let lastUsed = 0;
  (resp.data.values || []).forEach((r, i) => {
    if (r[0] === undefined || r[0] === '') return;
    lastUsed = i + 1;
    rows.push({
      row: i + 2,
      date: typeof r[0] === 'number' ? serialToDate(r[0]).toISOString().slice(0, 10) : String(r[0]),
      shop: String(r[1] || ''),
      customer: String(r[2] || ''),
      category: String(r[3] || ''),
      cashIn: num(r[5]),
      bankIn: num(r[6]),
      cashOut: num(r[7]),
      bankOut: num(r[8]),
      credit: num(r[9]),
      enteredBy: String(r[10] || ''),
      notes: String(r[11] || ''),
    });
  });
  return { rows, nextRow: 2 + lastUsed, lastRow };
}

// Credit rows belong to the customer's shop: Palladium, unless Lists column F names
// another one. "Nana Card (Neighbour)" is Nana's — card sales rung up on the neighbour
// shop's machine, which the neighbour later pays back in cash at Nana.
const MOCK_CUSTOMER_SHOPS = { 'Nana Card (Neighbour)': 'Nana' };

function customerShopMap(listRows) {
  const map = {};
  for (const r of listRows) if (r[0]) map[String(r[0])] = String(r[1] || '').trim() || 'Palladium';
  return map;
}

// Checks each { customer, shop } credit entry against its customer's shop.
// Returns an error message, or null when they all match.
async function creditShopError(entries) {
  if (!entries.length) return null;
  let shops = MOCK_CUSTOMER_SHOPS;
  if (!MOCK) {
    const resp = await getSheetsClient().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Lists'!E2:F30" });
    shops = customerShopMap(resp.data.values || []);
  }
  for (const e of entries) {
    const home = shops[e.customer] || 'Palladium';
    if (e.shop !== home) return `Credit rows for ${e.customer} must use Shop = ${home}`;
  }
  return null;
}

// ---- safe writes to Master Entry ----
// Editing or deleting goes by row number. If rows were deleted in the sheet after the app
// loaded its list, that number can point at a different entry, so the app sends the entry
// as it showed it and we check the row still holds it before touching anything.
const round2 = (n) => Math.round(num(n) * 100) / 100;
async function rowMismatch(sheets, row, original) {
  if (!original || typeof original !== 'object') return 'Finance needs a reload before it can change entries. Pull down or tap ↻, then try again.';
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `'Master Entry'!A${row}:J${row}`,
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const r = (resp.data.values || [])[0] || [];
  const now = {
    date: typeof r[0] === 'number' ? serialToDate(r[0]).toISOString().slice(0, 10) : String(r[0] ?? ''),
    shop: String(r[1] || ''), customer: String(r[2] || ''), category: String(r[3] || ''),
    cashIn: round2(r[5]), bankIn: round2(r[6]), cashOut: round2(r[7]), bankOut: round2(r[8]), creditAmount: round2(r[9]),
  };
  const same = ['date', 'shop', 'customer', 'category'].every((k) => now[k] === String(original[k] ?? ''))
    && ['cashIn', 'bankIn', 'cashOut', 'bankOut', 'creditAmount'].every((k) => now[k] === round2(original[k]));
  if (same) return null;
  const what = now.category ? `${now.category}, ${now.shop}, ${now.date}` : 'nothing';
  return `Row ${row} of the sheet changed since Finance loaded it (it now holds ${what}). Nothing was changed. Tap ↻ to reload, then try again.`;
}

// After adding rows: read them back. If another save landed on the same rows at the same
// moment, ours were overwritten; say so instead of reporting a save that isn't there.
// (Columns B, D, K: shop, category, entered by. Notes are left out: the sheet may turn a
// note such as "1,500" into a number, which would look like a clash when there is none.)
async function verifyWritten(sheets, startRow, rows) {
  await new Promise((r) => setTimeout(r, 700));
  const endRow = startRow + rows.length - 1;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'Master Entry'!A${startRow}:K${endRow}` });
  const got = resp.data.values || [];
  const bad = rows.findIndex((w, i) => [1, 3, 10].some((c) => String((got[i] || [])[c] ?? '') !== String(w[c] ?? '')));
  if (bad < 0) return null;
  return `Another save landed on row ${startRow + bad} at the same moment, so this one was not kept. Tap ↻ to reload, check the entries, and save again.`;
}

async function masterSheetId(sheets) {
  const resp = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties(sheetId,title)' });
  const sh = (resp.data.sheets || []).find((x) => x.properties.title === 'Master Entry');
  if (!sh) throw new Error('No Master Entry tab');
  return sh.properties.sheetId;
}

// ---- Loyverse import log ----
// Each import (the 6:00 job, or Save from Loyverse in the app) adds one line to a "Sync Log"
// tab, so Home can say when the last import ran and whether it worked. The tab is made on
// first use. A failure to log never fails the import itself.
const SYNC_LOG = 'Sync Log';
const SYNC_HEAD = ['When', 'Result', 'Dates', 'Added', 'Updated', 'Message'];

async function logSync(sheets, entry) {
  const row = [[new Date().toISOString(), entry.ok ? 'OK' : 'Failed', entry.dates || '', entry.added || 0, entry.updated || 0, String(entry.message || '').slice(0, 500)]];
  const append = () => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `'${SYNC_LOG}'!A:F`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: row },
  });
  try {
    await append();
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message || '')) { console.error('Sync log:', err.message); return; }
    try {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: SYNC_LOG } } }] } });
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${SYNC_LOG}'!A1:F1`, valueInputOption: 'RAW', requestBody: { values: [SYNC_HEAD] } });
      await append();
    } catch (e) { console.error('Sync log:', e.message); }
  }
}

// The newest line of the Sync Log ({ when, ok, dates, added, updated, message }), or null.
async function lastSync(sheets) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SYNC_LOG}'!A2:F` });
    const rows = (resp.data.values || []).filter((r) => r[0]);
    const r = rows[rows.length - 1];
    if (!r) return null;
    return { when: String(r[0]), ok: r[1] === 'OK', dates: String(r[2] || ''), added: +r[3] || 0, updated: +r[4] || 0, message: String(r[5] || '') };
  } catch (err) {
    return null;   // no Sync Log tab yet
  }
}

// Shown when a save would go past the bottom of Master Entry.
const sheetFullError = (lastRow) => `Master Entry is full (row ${lastRow}). Add more rows at the bottom of the sheet, copying the last row's formulas.`;

module.exports = { rowMismatch, verifyWritten, masterSheetId, logSync, lastSync, SHEET_ID, MOCK, MOCK_CUSTOMER_SHOPS, getSheetsClient, currentPin, checkPin, serialToDate, num, readMasterEntry, sheetFullError, customerShopMap, creditShopError };
