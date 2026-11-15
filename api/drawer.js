// /api/drawer — the Palladium manager's cash drawer (sheet shop "Warehouse", see _google.js).
//   GET                          cash in hand + this month's entries
//   POST { kind, amount, note }  kind 'sale' (Retail Sale, Cash In) or 'expense' (Other Expense, Cash Out)
//   DELETE { row, original }     takes back one of today's entries made from the drawer screen
// Open to the Palladium login (staff app) and the owner. The owner gives the float from
// Finance (two "Drawer Float" rows: Office Cash Out, drawer Cash In).
const { SHEET_ID, MOCK, DRAWER, getSheetsClient, checkDrawer, num, readMasterEntry, sheetFullError, rowMismatch, verifyWritten, masterSheetId } = require('./_google');

const BY = 'Palladium manager';   // Entered By for rows made on this screen
const KINDS = { sale: { category: 'Retail Sale', field: 'cashIn' }, expense: { category: 'Other Expense', field: 'cashOut' } };

// Today in Thailand, YYYY-MM-DD
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

// Drawer rows -> what the screen shows
function summarize(rows, day) {
  const mine = rows.filter((r) => r.shop === DRAWER);
  const cash = mine.reduce((n, r) => n + r.cashIn - r.cashOut, 0);
  const month = day.slice(0, 7);
  const entries = mine.filter((r) => r.date.slice(0, 7) === month && (r.cashIn || r.cashOut)).map((r) => ({
    row: r.row, date: r.date, category: r.category, notes: r.notes,
    amount: r.cashIn - r.cashOut,
    what: r.category === 'Drawer Float' ? 'Cash from office'
      : r.category === 'Retail Sale' ? 'Sale'
      : /^Collection/.test(r.category) ? 'Given to office'
      : r.cashIn ? r.category : 'Expense',
    canDelete: r.enteredBy === BY && r.date === day,
    original: { date: r.date, shop: r.shop, customer: r.customer, category: r.category, cashIn: r.cashIn, bankIn: r.bankIn, cashOut: r.cashOut, bankOut: r.bankOut, creditAmount: r.credit },
  })).reverse();
  return { cash, entries, today: day };
}

module.exports = async function handler(req, res) {
  const by = await checkDrawer(req, res);
  if (!by) return;

  if (req.method === 'GET') {
    if (MOCK) return res.json({ ...summarize(mockRows(), today()), mock: true });
    try {
      const { rows } = await readMasterEntry(getSheetsClient());
      return res.json(summarize(rows, today()));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not read the sheet: ' + err.message });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const kind = KINDS[b.kind];
    const amount = Math.round(num(b.amount) * 100) / 100;
    const note = String(b.note || '').trim().slice(0, 120);
    if (!kind) return res.status(400).json({ error: 'Pick Sale or Expense' });
    if (!(amount > 0) || amount > 200000) return res.status(400).json({ error: 'Type the amount in baht' });
    if (b.kind === 'expense' && !note) return res.status(400).json({ error: 'Write what the money was for' });
    const day = today();
    const [y, m, d] = day.split('-').map(Number);
    if (MOCK) return res.json({ ok: true, mock: true });
    try {
      const sheets = getSheetsClient();
      const { nextRow, lastRow } = await readMasterEntry(sheets);
      if (nextRow > lastRow) return res.status(500).json({ error: sheetFullError(lastRow) });
      const values = [[`${m}/${d}/${y}`, DRAWER, '', kind.category, null,
        kind.field === 'cashIn' ? amount : '', '', kind.field === 'cashOut' ? amount : '', '', '',
        by === 'Owner' ? 'App' : BY, note]];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `'Master Entry'!A${nextRow}:L${nextRow}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values },
      });
      const lost = await verifyWritten(sheets, nextRow, values);
      if (lost) return res.status(409).json({ error: lost });
      return res.json({ ok: true, row: nextRow });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not save: ' + err.message });
    }
  }

  if (req.method === 'DELETE') {
    const b = req.body || {};
    const row = parseInt(b.row, 10);
    const o = b.original || {};
    if (!row || row < 2) return res.status(400).json({ error: 'Invalid row' });
    if (o.shop !== DRAWER || o.date !== today()) return res.status(400).json({ error: "Only today's entries can be taken back here. Ask the owner to fix older ones." });
    if (MOCK) return res.json({ ok: true, mock: true });
    try {
      const sheets = getSheetsClient();
      const changed = await rowMismatch(sheets, row, o);
      if (changed) return res.status(409).json({ error: 'The list changed. Pull to refresh and try again.' });
      const k = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'Master Entry'!K${row}` });
      if (String(((k.data.values || [])[0] || [])[0] || '') !== BY) return res.status(403).json({ error: 'Only entries made on this screen can be taken back here.' });
      const sheetId = await masterSheetId(sheets);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] },
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not delete: ' + err.message });
    }
  }

  res.status(405).json({ error: 'GET, POST or DELETE only' });
};

function mockRows() {
  const day = today();
  const base = { shop: DRAWER, customer: '', bankIn: 0, bankOut: 0, credit: 0 };
  return [
    { ...base, row: 900, date: day.slice(0, 8) + '01', category: 'Drawer Float', cashIn: 3000, cashOut: 0, enteredBy: 'App', notes: 'From Office Cash' },
    { ...base, row: 901, date: day, category: 'Other Expense', cashIn: 0, cashOut: 120, enteredBy: BY, notes: 'Water and ice' },
    { ...base, row: 902, date: day, category: 'Retail Sale', cashIn: 850, cashOut: 0, enteredBy: BY, notes: 'Cousin, 2 shirts' },
  ];
}

module.exports.summarize = summarize;
