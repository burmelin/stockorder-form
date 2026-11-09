// GET /api/transactions — returns all Master Entry rows (parsed), for the per-shop
// and per-customer detail views. The client filters by shop/customer.
const { SHEET_ID, MOCK, getSheetsClient, checkPin, serialToDate, num } = require('./_google');

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;

  if (MOCK) return res.json({ transactions: mockTx(), mock: true });

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'Master Entry'!A2:L",
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const rows = resp.data.values || [];
    const tx = [];
    rows.forEach((r, i) => {
      if (r[0] === undefined || r[0] === '') return;
      const d = typeof r[0] === 'number' ? serialToDate(r[0]) : null;
      tx.push({
        row: i + 2,
        date: d ? d.toISOString().slice(0, 10) : String(r[0]),
        shop: String(r[1] || ''),
        customer: String(r[2] || ''),
        category: String(r[3] || ''),
        type: String(r[4] || ''),
        cashIn: num(r[5]), bankIn: num(r[6]), cashOut: num(r[7]), bankOut: num(r[8]),
        creditAmount: num(r[9]),
        notes: String(r[11] || '').replace(/\s*\[-?[\d.]+\|-?[\d.]+\|-?[\d.]+\]\s*$/, ''), // hide the import's amount stamp
      });
    });
    res.json({ transactions: tx, mock: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read spreadsheet: ' + err.message });
  }
};

function mockTx() {
  return [
    { row: 2, date: '2026-07-03', shop: 'Bicasso 1', customer: '', category: 'Opening Balance', type: 'Transfer', cashIn: 2100, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 0, notes: '' },
    { row: 3, date: '2026-07-03', shop: 'Nana', customer: '', category: 'Opening Balance', type: 'Transfer', cashIn: 90420, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 0, notes: '' },
    { row: 4, date: '2026-07-03', shop: 'Nana', customer: '', category: 'Collection (to Palladium)', type: 'Transfer', cashIn: 0, bankIn: 0, cashOut: 90000, bankOut: 0, creditAmount: 0, notes: '' },
    { row: 5, date: '2026-07-03', shop: 'Palladium', customer: '', category: 'Salary', type: 'Expense', cashIn: 0, bankIn: 0, cashOut: 14000, bankOut: 0, creditAmount: 0, notes: 'Nana employee salary' },
    { row: 6, date: '2026-07-04', shop: 'Bicasso 1', customer: '', category: 'Retail Sale', type: 'Income', cashIn: 3200, bankIn: 5400, cashOut: 0, bankOut: 0, creditAmount: 0, notes: '' },
    { row: 7, date: '2026-07-05', shop: 'Bicasso 1', customer: '', category: 'Rent', type: 'Expense', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 8000, creditAmount: 0, notes: 'July rent' },
    { row: 8, date: '2026-05-30', shop: 'Palladium', customer: 'Shyam Gtm', category: 'Credit Sale', type: 'Income', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 620000, notes: 'Opening balance' },
    { row: 9, date: '2026-06-15', shop: 'Palladium', customer: 'Shyam Gtm', category: 'Credit Sale', type: 'Income', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 18383, notes: '' },
    { row: 10, date: '2026-06-20', shop: 'Palladium', customer: 'Shyam Gtm', category: 'Customer Payment', type: 'Income', cashIn: 8000, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 0, notes: 'part payment' },
    { row: 11, date: '2026-07-01', shop: 'Palladium', customer: 'Mars', category: 'Credit Sale', type: 'Income', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 84005, notes: 'Opening balance' },
  ];
}
