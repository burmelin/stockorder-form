// GET  /api/advances?month=YYYY-MM — each staff member's salary, advances and pay for the month
// POST /api/advances { kind: 'salary', name, amount }        — set a person's monthly salary
// POST /api/advances { kind: 'deduct', month, name, amount } — how much to take off that payday
// POST /api/advances { kind: 'payroll', month, people: [{ name, salary, deduct, commission }] }
//                                       — mark these people paid for the month (others kept)
// See api/_advances.js for how advances are found and counted. Staff come from the Stock
// sheet's Staff tab: everyone, shops and Palladium.
const { SHEET_ID, MOCK, getSheetsClient, checkPin, readMasterEntry } = require('./_google');
const { localDate } = require('./_loyverse');
const { SALARY_TAB, DEDUCTIONS_TAB, PAYROLL_TAB, PAYROLL_HEADERS, payrollFromRows, upsertPayroll, money, staffNamesFromRows, salariesFromRows, deductionsFromRows, advancesFor } = require('./_advances');

const STOCK_SHEET_ID = process.env.STOCK_SHEET_ID || '1RsicbmRnmQYRZJE37sydQ2sxMxIzQXfk5ke4aB6ATBM';
const HEADERS = { [SALARY_TAB]: ['Name', 'Monthly salary'], [DEDUCTIONS_TAB]: ['Month', 'Name', 'Amount'] };

// Reads a whole tab, making it (with its header row) the first time
async function readTab(sheets, tab) {
  const cols = HEADERS[tab].length === 2 ? 'A1:B' : 'A1:C';
  try {
    return (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tab}'!${cols}` })).data.values || [];
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message || '')) throw err;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    const values = [HEADERS[tab]];
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1`, valueInputOption: 'RAW', requestBody: { values } });
    return values;
  }
}

// Writes these people's payroll rows for the month; other people's rows stay as they are
async function savePayroll(req, res) {
  const b = req.body || {};
  const month = String(b.month || '');
  const people = Array.isArray(b.people) ? b.people.filter((p) => p && String(p.name || '').trim()).slice(0, 100) : [];
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!people.length) return res.status(400).json({ error: 'Nobody to save' });
  const paidAt = localDate(Date.now());
  if (MOCK) return res.json({ ok: true, mock: true, paidAt });
  try {
    const sheets = getSheetsClient();
    let values;
    try {
      values = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${PAYROLL_TAB}'!A1:G` })).data.values || [];
    } catch (err) {
      if (!/Unable to parse range/i.test(err.message || '')) throw err;
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: PAYROLL_TAB } } }] } });
      values = [PAYROLL_HEADERS];
    }
    const next = upsertPayroll(values, month, people, paidAt);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${PAYROLL_TAB}'!A:G` });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${PAYROLL_TAB}'!A1`, valueInputOption: 'RAW', requestBody: { values: next } });
    res.json({ ok: true, paidAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the payroll: ' + err.message });
  }
}

async function save(req, res) {
  const b = req.body || {};
  if (b.kind === 'payroll') return savePayroll(req, res);
  const name = String(b.name || '').trim().slice(0, 100);
  const amount = money(b.amount);
  const month = String(b.month || '');
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (b.kind !== 'salary' && b.kind !== 'deduct') return res.status(400).json({ error: 'kind must be salary or deduct' });
  if (b.kind === 'deduct' && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (amount > 10000000) return res.status(400).json({ error: 'That amount is too large' });
  if (MOCK) return res.json({ ok: true, mock: true });
  try {
    const sheets = getSheetsClient();
    const tab = b.kind === 'salary' ? SALARY_TAB : DEDUCTIONS_TAB;
    const values = await readTab(sheets, tab);
    const same = b.kind === 'salary'
      ? (r) => String(r[0] || '').trim() === name
      : (r) => String(r[0] || '').trim() === month && String(r[1] || '').trim() === name;
    const i = values.findIndex((r, n) => n > 0 && same(r));
    const col = b.kind === 'salary' ? 'B' : 'C';
    if (i > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${tab}'!${col}${i + 1}`, valueInputOption: 'RAW', requestBody: { values: [[amount]] } });
    } else {
      const row = b.kind === 'salary' ? [name, amount] : [month, name, amount];
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `'${tab}'!A:${col}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save: ' + err.message });
  }
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method === 'POST') return save(req, res);
  const month = String((req.query || {}).month || localDate(Date.now()).slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });

  if (MOCK) {
    const rows = [
      { row: 40, date: `${month}-05`, shop: 'Bicasso 1', category: 'Salary', cashOut: 2000, bankOut: 0, notes: 'Kumar Advance · 14:10' },
      { row: 41, date: `${month}-12`, shop: 'Nana', category: 'Salary', cashOut: 1000, bankOut: 0, notes: 'advance · 19:02' },
    ];
    const names = ['Pyone Cho', 'Sunil GTM', 'Kumar Giri', 'Bharati'];
    return res.json({ ...advancesFor(rows, names, { 'Kumar Giri': 15000 }, [], month), payroll: [], staffNote: '', mock: true });
  }

  try {
    const sheets = getSheetsClient();
    const soft = (p) => p.then((r) => r, (err) => ({ err }));
    const [master, stock, salaries, deductions, payroll] = await Promise.all([
      readMasterEntry(sheets),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range: "'Staff'!A1:J60" })),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SALARY_TAB}'!A2:B` })),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${DEDUCTIONS_TAB}'!A2:C` })),
      soft(sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${PAYROLL_TAB}'!A2:G` })),
    ]);
    let names = [], staffNote = '';
    if (stock.err) {
      staffNote = 'Staff are read from the Staff tab of the Stock sheet, but the finance app can\'t open it ('
        + (stock.err.code || stock.err.message) + ').';
    } else {
      names = staffNamesFromRows(stock.data.values || []);
    }
    res.json({
      ...advancesFor(master.rows, names,
        salaries.err ? {} : salariesFromRows(salaries.data.values || []),
        deductions.err ? [] : deductionsFromRows(deductions.data.values || []), month),
      payroll: payroll.err ? [] : payrollFromRows(payroll.data.values || [], month),
      staffNote, mock: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read spreadsheet: ' + err.message });
  }
};
