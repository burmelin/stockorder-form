// POST /api/transaction — appends one row to the Master Entry tab.
// Writes columns A-D and F-L only; E (Type), M and N are formulas that stay untouched.
const { SHEET_ID, MOCK, getSheetsClient, checkPin, num, readMasterEntry, sheetFullError, creditShopError, rowMismatch, verifyWritten, masterSheetId } = require('./_google');
const { loyverseClash, payoutClash } = require('./_loyverse');

// Which money fields each category is allowed to use (mirrors the sheet's README rules)
const RULES = {
  'Retail Sale': ['cashIn', 'bankIn'],
  'Bank Received': ['bankIn'],
  'Scan / QR Payment': ['bankIn'],
  'Credit Sale': ['creditAmount'],
  'Customer Payment': ['cashIn', 'bankIn'],
  'Supplier Pay': ['cashOut', 'bankOut'],
  'Salary': ['cashOut', 'bankOut'],
  'Wages': ['cashOut', 'bankOut'],
  'Commission': ['cashOut', 'bankOut'],
  'Rent': ['cashOut', 'bankOut'],
  'Gov Tax': ['cashOut', 'bankOut'],
  'Home Expenses': ['cashOut', 'bankOut'],
  'Other Expense': ['cashOut', 'bankOut'],
  'Collection (to Palladium)': ['cashOut'],
  'Cash to Bank Deposit': ['cashOut', 'bankIn'],
  'Bank to Cash (ATM)': ['cashIn', 'bankOut'],
  'Collection to Bank': ['cashOut', 'bankIn'],
  'Opening Balance': ['cashIn', 'bankIn'],
  'Adjustment': ['cashIn', 'bankIn', 'cashOut', 'bankOut'],
};

const NEEDS_CUSTOMER = ['Credit Sale', 'Customer Payment'];

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method === 'PUT') return handleUpdate(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST, PUT or DELETE only' });

  const b = req.body || {};
  const category = String(b.category || '');
  const shop = String(b.shop || '');
  const customer = String(b.customer || '');
  const notes = String(b.notes || '').slice(0, 200);
  const date = String(b.date || '');

  const amounts = {
    cashIn: num(b.cashIn),
    bankIn: num(b.bankIn),
    cashOut: num(b.cashOut),
    bankOut: num(b.bankOut),
    creditAmount: num(b.creditAmount),
  };

  // ---- validation ----
  if (!RULES[category]) return res.status(400).json({ error: 'Unknown category: ' + category });
  if (!shop) return res.status(400).json({ error: 'Shop is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

  const allowed = RULES[category];
  const used = Object.entries(amounts).filter(([, v]) => v > 0).map(([k]) => k);
  if (used.length === 0) return res.status(400).json({ error: 'Enter at least one amount' });
  const illegal = used.filter((k) => !allowed.includes(k));
  if (illegal.length) {
    return res.status(400).json({ error: `${category} cannot use: ${illegal.join(', ')}` });
  }
  if (Object.values(amounts).some((v) => v < 0)) return res.status(400).json({ error: 'Amounts must be positive' });

  if (NEEDS_CUSTOMER.includes(category)) {
    if (!customer) return res.status(400).json({ error: 'Pick a credit customer for ' + category });
    const shopErr = await creditShopError([{ customer, shop }]).catch((e) => 'Failed to read spreadsheet: ' + e.message);
    if (shopErr) return res.status(400).json({ error: shopErr });
  }

  // Sheet stores dates as M/D/YYYY
  const [y, m, d] = date.split('-').map(Number);
  const sheetDate = `${m}/${d}/${y}`;

  if (MOCK) return res.json({ ok: true, mock: true, row: 999, echo: { sheetDate, shop, customer, category, ...amounts, notes } });

  try {
    const sheets = getSheetsClient();

    // One read gives the first empty row and the rows to check for Loyverse duplicates
    const { rows: existing, nextRow: targetRow, lastRow } = await readMasterEntry(sheets);
    const clash = loyverseClash(existing, [{ category, shop, date }]);
    if (clash) return res.status(409).json({ error: clash });
    const payClash = !b.confirmDuplicates && payoutClash(existing, [{ category, shop, date, cashOut: amounts.cashOut }]);
    if (payClash) return res.status(409).json({ error: payClash, needsConfirm: true });
    if (targetRow > lastRow) return res.status(500).json({ error: sheetFullError(lastRow) });

    // null = leave the cell untouched (protects the Type formula in column E)
    const rowValues = [[
      sheetDate,                                   // A Date
      shop,                                        // B Shop
      NEEDS_CUSTOMER.includes(category) ? customer : '', // C Credit Customer
      category,                                    // D Category
      null,                                        // E Type (formula)
      amounts.cashIn || '',                        // F Cash In
      amounts.bankIn || '',                        // G Bank In
      amounts.cashOut || '',                       // H Cash Out
      amounts.bankOut || '',                       // I Bank Out
      amounts.creditAmount || '',                  // J Credit Sale Amount
      'App',                                       // K Entered By
      notes,                                       // L Notes
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'Master Entry'!A${targetRow}:L${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowValues },
    });
    const lost = await verifyWritten(sheets, targetRow, rowValues);
    if (lost) return res.status(409).json({ error: lost });

    res.json({ ok: true, row: targetRow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to write to spreadsheet: ' + err.message });
  }
};

async function handleUpdate(req, res) {
  const b = req.body || {};
  const row = parseInt(b.row, 10);
  if (!row || row < 2) return res.status(400).json({ error: 'Invalid row number' });

  const category = String(b.category || '');
  const shop = String(b.shop || '');
  const customer = String(b.customer || '');
  const notes = String(b.notes || '').slice(0, 200);
  const date = String(b.date || '');

  const amounts = {
    cashIn: num(b.cashIn),
    bankIn: num(b.bankIn),
    cashOut: num(b.cashOut),
    bankOut: num(b.bankOut),
    creditAmount: num(b.creditAmount),
  };

  if (!RULES[category]) return res.status(400).json({ error: 'Unknown category: ' + category });
  if (!shop) return res.status(400).json({ error: 'Shop is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

  const allowed = RULES[category];
  const used = Object.entries(amounts).filter(([, v]) => v > 0).map(([k]) => k);
  if (used.length === 0) return res.status(400).json({ error: 'Enter at least one amount' });
  const illegal = used.filter((k) => !allowed.includes(k));
  if (illegal.length) return res.status(400).json({ error: `${category} cannot use: ${illegal.join(', ')}` });
  if (Object.values(amounts).some((v) => v < 0)) return res.status(400).json({ error: 'Amounts must be positive' });

  if (NEEDS_CUSTOMER.includes(category)) {
    if (!customer) return res.status(400).json({ error: 'Pick a credit customer for ' + category });
    const shopErr = await creditShopError([{ customer, shop }]).catch((e) => 'Failed to read spreadsheet: ' + e.message);
    if (shopErr) return res.status(400).json({ error: shopErr });
  }

  const [y, m, d] = date.split('-').map(Number);
  const sheetDate = `${m}/${d}/${y}`;

  if (MOCK) return res.json({ ok: true, mock: true, row, echo: { sheetDate, shop, customer, category, ...amounts, notes } });

  try {
    const sheets = getSheetsClient();
    const changed = await rowMismatch(sheets, row, b.original);
    if (changed) return res.status(409).json({ error: changed });
    const rowValues = [[
      sheetDate, shop,
      NEEDS_CUSTOMER.includes(category) ? customer : '',
      category, null,
      amounts.cashIn || '', amounts.bankIn || '',
      amounts.cashOut || '', amounts.bankOut || '',
      amounts.creditAmount || '', 'App', notes,
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'Master Entry'!A${row}:L${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowValues },
    });

    res.json({ ok: true, row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update spreadsheet: ' + err.message });
  }
}

// DELETE { row, original }: removes one entry's row from Master Entry, after checking the row
// still holds that entry. The rows below move up, as when a row is deleted in the sheet.
async function handleDelete(req, res) {
  const b = req.body || {};
  const row = parseInt(b.row, 10);
  if (!row || row < 2) return res.status(400).json({ error: 'Invalid row number' });
  if (MOCK) return res.json({ ok: true, mock: true, row });
  try {
    const sheets = getSheetsClient();
    const changed = await rowMismatch(sheets, row, b.original);
    if (changed) return res.status(409).json({ error: changed });
    const sheetId = await masterSheetId(sheets);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] },
    });
    res.json({ ok: true, row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete from spreadsheet: ' + err.message });
  }
}
