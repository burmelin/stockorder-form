// GET  /api/bank-deposits?from=YYYY-MM-DD&to=YYYY-MM-DD — what the bank paid in for Bicasso
//      card sales, by the sales day it pays for: { deposits: { date: { amount, note } } }
// POST /api/bank-deposits { date, amount, note } — set a day's deposit (amount 0 removes it)
// Kept in the finance sheet's "Bank Deposits" tab. Owner login only. See api/_cardfees.js.
const { SHEET_ID, MOCK, getSheetsClient, checkPin } = require('./_google');
const { DEPOSITS_TAB, DEPOSIT_HEADERS, money, depositsFromRows, upsertDeposit } = require('./_cardfees');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const MOCK_DEPOSITS = {};   // so the local dev server remembers what was typed

async function readTab(sheets) {
  try {
    return (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${DEPOSITS_TAB}'!A1:C` })).data.values || [];
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message || '')) throw err;
    return null;   // the tab doesn't exist yet
  }
}

async function save(req, res) {
  const b = req.body || {};
  const date = String(b.date || '');
  const amount = money(b.amount);
  const note = String(b.note || '').trim().slice(0, 200);
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (amount > 10000000) return res.status(400).json({ error: 'That amount is too large' });
  if (MOCK) {
    if (amount) MOCK_DEPOSITS[date] = { amount, note }; else delete MOCK_DEPOSITS[date];
    return res.json({ ok: true, mock: true });
  }
  try {
    const sheets = getSheetsClient();
    let values = await readTab(sheets);
    if (!values) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: DEPOSITS_TAB } } }] } });
      values = [DEPOSIT_HEADERS];
    }
    const next = upsertDeposit(values, date, amount, note);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${DEPOSITS_TAB}'!A:C` });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${DEPOSITS_TAB}'!A1`, valueInputOption: 'RAW', requestBody: { values: next } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the deposit: ' + err.message });
  }
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method === 'POST') return save(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST only' });
  const q = req.query || {};
  const from = String(q.from || '0000-00-00'), to = String(q.to || '9999-99-99');
  const pick = (all) => Object.fromEntries(Object.entries(all).filter(([d]) => d >= from && d <= to));
  if (MOCK) return res.json({ ok: true, mock: true, deposits: pick(MOCK_DEPOSITS) });
  try {
    const values = await readTab(getSheetsClient());
    res.json({ ok: true, deposits: pick(depositsFromRows(values || [])) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read the deposits: ' + err.message });
  }
};
