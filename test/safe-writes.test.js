// Edits and deletes check the sheet row first; added rows are read back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rowMismatch, verifyWritten } = require('../api/_google');

const fakeSheets = (values) => ({ spreadsheets: { values: { get: async () => ({ data: { values } }) } } });
// 2026-11-05 as a Google Sheets serial number
const SERIAL = 46331;
const original = { date: '2026-11-05', shop: 'Bicasso 1', customer: '', category: 'Rent', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 8000, creditAmount: 0 };

test('an edit goes ahead when the row still holds the entry', async () => {
  const sheets = fakeSheets([[SERIAL, 'Bicasso 1', '', 'Rent', 'Expense', '', '', '', 8000, '']]);
  assert.equal(await rowMismatch(sheets, 10, original), null);
});

test('an edit is refused when rows moved and the row holds another entry', async () => {
  const sheets = fakeSheets([[SERIAL, 'Nana', '', 'Retail Sale', 'Income', 5000, '', '', '', '']]);
  assert.match(await rowMismatch(sheets, 10, original), /changed since Finance loaded it/);
});

test('an edit from a page without the original is refused', async () => {
  assert.match(await rowMismatch(fakeSheets([]), 10, undefined), /reload/);
});

test('added rows: a clash with another save is reported', async () => {
  const written = [['11/5/2026', 'Bicasso 1', '', 'Rent', null, '', '', '', 8000, '', 'App', 'note']];
  assert.equal(await verifyWritten(fakeSheets([['11/5/2026', 'Bicasso 1', '', 'Rent', 'Expense', '', '', '', '8,000', '', 'App']]), 20, written), null);
  assert.match(await verifyWritten(fakeSheets([['11/5/2026', 'Nana', '', 'Retail Sale', 'Income', '', '', '', '', '', 'Loyverse']]), 20, written), /same moment/);
});
