// POST /api/batch — appends several rows to the Master Entry tab in one write.
// Used by the "Daily" screen to record a shop's sales + expenses for a date together.
// Like /api/transaction, it writes columns A-D and F-L only; E (Type), M and N stay
// as sheet formulas (left as null so the update never overwrites them).
const { SHEET_ID, MOCK, getSheetsClient, checkPin, num, readMasterEntry, sheetFullError, creditShopError } = require('./_google');
const { loyverseClash, payoutClash } = require('./_loyverse');

// Which money fields each category is allowed to use (mirrors api/transaction.js)
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

// Validate + normalise one incoming entry. Returns { row } (a 12-cell A-L array with
// null at E) or { error } describing the first problem found.
function buildRow(entry, idx) {
  const where = `Row ${idx + 1}`;
  const category = String(entry.category || '');
  const shop = String(entry.shop || '');
  const customer = String(entry.customer || '');
  const notes = String(entry.notes || '').slice(0, 200);
  const date = String(entry.date || '');

  const amounts = {
    cashIn: num(entry.cashIn),
    bankIn: num(entry.bankIn),
    cashOut: num(entry.cashOut),
    bankOut: num(entry.bankOut),
    creditAmount: num(entry.creditAmount),
  };

  if (!RULES[category]) return { error: `${where}: unknown category "${category}"` };
  if (!shop) return { error: `${where}: shop is required` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `${where}: date must be YYYY-MM-DD` };

  const allowed = RULES[category];
  const used = Object.entries(amounts).filter(([, v]) => v > 0).map(([k]) => k);
  if (used.length === 0) return { error: `${where}: enter at least one amount` };
  const illegal = used.filter((k) => !allowed.includes(k));
  if (illegal.length) return { error: `${where}: ${category} cannot use ${illegal.join(', ')}` };
  if (Object.values(amounts).some((v) => v < 0)) return { error: `${where}: amounts must be positive` };

  if (NEEDS_CUSTOMER.includes(category) && !customer) return { error: `${where}: pick a credit customer for ${category}` };

  const [y, m, d] = date.split('-').map(Number);
  const sheetDate = `${m}/${d}/${y}`; // sheet stores dates as M/D/YYYY

  return {
    row: [
      sheetDate,                                          // A Date
      shop,                                               // B Shop
      NEEDS_CUSTOMER.includes(category) ? customer : '',  // C Credit Customer
      category,                                           // D Category
      null,                                               // E Type (formula — untouched)
      amounts.cashIn || '',                               // F Cash In
      amounts.bankIn || '',                               // G Bank In
      amounts.cashOut || '',                              // H Cash Out
      amounts.bankOut || '',                              // I Bank Out
      amounts.creditAmount || '',                         // J Credit Sale Amount
      'App',                                              // K Entered By
      notes,                                              // L Notes
    ],
  };
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const entries = Array.isArray((req.body || {}).rows) ? req.body.rows : null;
  if (!entries || !entries.length) return res.status(400).json({ error: 'Send a non-empty "rows" array' });
  if (entries.length > 100) return res.status(400).json({ error: 'Too many rows in one save (max 100)' });

  const rowValues = [];
  for (let i = 0; i < entries.length; i++) {
    const built = buildRow(entries[i], i);
    if (built.error) return res.status(400).json({ error: built.error });
    rowValues.push(built.row);
  }

  const credit = entries.filter((e) => NEEDS_CUSTOMER.includes(e.category)).map((e) => ({ customer: String(e.customer), shop: String(e.shop) }));
  const shopErr = await creditShopError(credit).catch((e) => 'Failed to read spreadsheet: ' + e.message);
  if (shopErr) return res.status(400).json({ error: shopErr });

  if (MOCK) return res.json({ ok: true, mock: true, count: rowValues.length });

  try {
    const sheets = getSheetsClient();

    // One read gives the first empty row and the rows to check for Loyverse duplicates
    const { rows: existing, nextRow: startRow, lastRow } = await readMasterEntry(sheets);
    const clash = loyverseClash(existing, entries);
    if (clash) return res.status(409).json({ error: clash });
    // Pay-outs Loyverse already imported: ask before saving what is probably the same money.
    const payClash = !req.body.confirmDuplicates && payoutClash(existing, entries);
    if (payClash) return res.status(409).json({ error: payClash, needsConfirm: true });
    const endRow = startRow + rowValues.length - 1;
    if (endRow > lastRow) return res.status(500).json({ error: sheetFullError(lastRow) });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'Master Entry'!A${startRow}:L${endRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowValues },
    });

    res.json({ ok: true, count: rowValues.length, startRow, endRow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to write to spreadsheet: ' + err.message });
  }
};
