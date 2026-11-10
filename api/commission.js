// GET /api/commission?month=YYYY-MM — staff commission for a month (default: this month), from
// the Retail Sale and Credit Sale rows in Master Entry:
// - Terminal 21: 3% of Bicasso 1 + Bicasso 2 sales plus the daily bonus, split between the Bicasso staff
// - Nana: 1% of Nana's sales (cash + neighbour card), split between Nana's staff
// Staff come from the Stock & Orders sheet's Staff tab (the one real staff list, edited in the
// app under Settings → Staff): people whose "Works at" includes Bicasso 1 or 2, or Nana, and not
// the warehouse (Palladium). The finance robot account needs Viewer access to that sheet.
const { SHEET_ID, MOCK, getSheetsClient, checkPin, readMasterEntry } = require('./_google');
const { localDate } = require('./_loyverse');
const { commissionFor, nanaCommissionFor, BONUS_BANDS } = require('./_commission');

const STOCK_SHEET_ID = process.env.STOCK_SHEET_ID || '1RsicbmRnmQYRZJE37sydQ2sxMxIzQXfk5ke4aB6ATBM';

// { bicasso: [names], nana: [names] } from the Stock app's Staff tab (columns found by header)
function staffFromStockRows(values) {
  const head = (values[0] || []).map((h) => String(h).trim().toLowerCase());
  const nameCol = head.indexOf('name'), placesCol = head.indexOf('works at');
  if (nameCol < 0 || placesCol < 0) throw new Error('The Staff tab needs "Name" and "Works at" columns');
  const out = { bicasso: [], nana: [] };
  for (const r of values.slice(1)) {
    const name = String(r[nameCol] || '').trim();
    const places = String(r[placesCol] || '').split(',').map((p) => p.trim().toLowerCase());
    if (!name || places.includes('palladium') || places.includes('warehouse')) continue;
    if (places.includes('bicasso 1') || places.includes('bicasso 2')) out.bicasso.push(name);
    if (places.includes('bicasso nana') || places.includes('nana')) out.nana.push(name);
  }
  return out;
}

// ---- days off ----
// Approved leave (day off or sick leave) from the Stock sheet's Leave tab, counted per person
// for the month: the starting number of days off. A half day (Morning / Afternoon in the
// "Half day" column) counts as 0.5. The owner can change it in the app; that
// number is saved in the finance sheet's "Commission Days Off" tab (Month, Name, Days off), so
// every phone shows the same.
const DAYS_OFF_TAB = 'Commission Days Off';
// Days off go in half-day steps
const halfSteps = (v) => Math.min(31, Math.max(0, Math.round((parseFloat(v) || 0) * 2) / 2));

function leaveDaysFromRows(values, month) {
  const head = (values[0] || []).map((h) => String(h).trim().toLowerCase());
  const nameCol = head.indexOf('name'), dateCol = head.indexOf('date'), statusCol = head.indexOf('status'), halfCol = head.indexOf('half day');
  const out = {};
  if (nameCol < 0 || dateCol < 0 || statusCol < 0) return out;
  const seen = new Set();
  for (const r of values.slice(1)) {
    const name = String(r[nameCol] || '').trim(), date = String(r[dateCol] || '').trim();
    if (!name || String(r[statusCol] || '').trim() !== 'Approved' || date.slice(0, 7) !== month) continue;
    const key = name + '|' + date;
    if (seen.has(key)) continue;   // one day counts once, even if asked twice
    seen.add(key);
    const half = halfCol > -1 && /^(morning|afternoon)$/i.test(String(r[halfCol] || '').trim());
    out[name] = (out[name] || 0) + (half ? 0.5 : 1);
  }
  return out;
}

function savedDaysFromRows(values, month) {
  const out = {};
  for (const r of values) if (String(r[0] || '').trim() === month && String(r[1] || '').trim()) out[String(r[1]).trim()] = halfSteps(r[2]);
  return out;
}

// POST { month, name, days }: save one person's days off for a month
async function saveDaysOff(req, res) {
  const b = req.body || {};
  const month = String(b.month || ''), name = String(b.name || '').trim().slice(0, 100);
  const days = halfSteps(b.days);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (MOCK) return res.json({ ok: true, mock: true });
  try {
    const sheets = getSheetsClient();
    let values;
    try {
      values = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${DAYS_OFF_TAB}'!A1:C` })).data.values || [];
    } catch (err) {
      if (!/Unable to parse range/i.test(err.message || '')) throw err;
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: DAYS_OFF_TAB } } }] } });
      values = [['Month', 'Name', 'Days off']];
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${DAYS_OFF_TAB}'!A1:C1`, valueInputOption: 'RAW', requestBody: { values } });
    }
    const i = values.findIndex((r, n) => n > 0 && String(r[0] || '').trim() === month && String(r[1] || '').trim() === name);
    if (i > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${DAYS_OFF_TAB}'!C${i + 1}`, valueInputOption: 'RAW', requestBody: { values: [[days]] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `'${DAYS_OFF_TAB}'!A:C`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[month, name, days]] } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save days off: ' + err.message });
  }
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method === 'POST') return saveDaysOff(req, res);
  const month = String((req.query || {}).month || localDate(Date.now()).slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });

  if (MOCK) {
    const rows = mockRows(month), staff = { bicasso: ['Pyone Cho', 'Sunil GTM', 'Kumar Giri'], nana: ['Bharati'] };
    return res.json({ ...commissionFor(rows, month, staff.bicasso.length), staff: staff.bicasso, bands: BONUS_BANDS,
      nana: { ...nanaCommissionFor(rows, month, staff.nana.length), staff: staff.nana }, staffSource: 'stock',
      daysOff: { leave: { 'Sunil GTM': 3 }, saved: {} }, mock: true });
  }

  try {
    const sheets = getSheetsClient();
    const soft = (p) => p.then((r) => r, (err) => ({ err }));
    const [master, stock, leave, saved] = await Promise.all([
      readMasterEntry(sheets),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range: "'Staff'!A1:J60" })),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range: "'Leave'!A1:K" })),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${DAYS_OFF_TAB}'!A2:C` })),
    ]);
    const daysOff = {
      leave: leave.err ? {} : leaveDaysFromRows(leave.data.values || [], month),
      saved: saved.err ? {} : savedDaysFromRows(saved.data.values || [], month),
    };
    let staff, staffSource = 'stock', staffNote = '';
    if (!stock.err) {
      staff = staffFromStockRows(stock.data.values || []);
    } else {
      staff = { bicasso: [], nana: [] };
      staffSource = 'none';
      staffNote = 'Staff are read from the Staff tab of the Stock sheet, but the finance app can\'t open that sheet yet ('
        + (stock.err.code || stock.err.message) + '). Share "Burmelin Stock & Orders" with the finance app\'s robot account (Viewer).';
      console.error('Stock Staff tab:', stock.err.message);
    }
    res.json({
      ...commissionFor(master.rows, month, staff.bicasso.length), staff: staff.bicasso, bands: BONUS_BANDS,
      nana: { ...nanaCommissionFor(master.rows, month, staff.nana.length), staff: staff.nana },
      staffSource, staffNote, daysOff, mock: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read spreadsheet: ' + err.message });
  }
};

module.exports.staffFromStockRows = staffFromStockRows;
module.exports.leaveDaysFromRows = leaveDaysFromRows;
module.exports.savedDaysFromRows = savedDaysFromRows;

function mockRows(month) {
  const day = (d, shop, cash, bank) => ({ date: `${month}-${String(d).padStart(2, '0')}`, shop, category: 'Retail Sale', cashIn: cash, bankIn: bank, credit: 0 });
  const card = (d, amount) => ({ date: `${month}-${String(d).padStart(2, '0')}`, shop: 'Nana', customer: 'Nana Card (Neighbour)', category: 'Credit Sale', cashIn: 0, bankIn: 0, credit: amount });
  return [
    day(3, 'Bicasso 1', 4000, 7500), day(3, 'Bicasso 2', 6000, 0),
    day(10, 'Bicasso 1', 8000, 15000), day(10, 'Bicasso 2', 7000, 10000),
    day(11, 'Bicasso 1', 2000, 3000), day(11, 'Bicasso 2', 9000, 25000),
    day(3, 'Nana', 5200, 0), card(3, 3100), day(10, 'Nana', 6400, 0), card(10, 2800),
  ];
}
