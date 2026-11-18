// Bicasso 1 and Bicasso 2 share one login and one Loyverse stock (apps-script/Code.gs):
// leave lists cover both shops' staff, and Restock's "on the way" adds both shops' open orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

function load(sheets = {}) {
  const ss = { getSheetByName: (n) => sheets[n] || null };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return ctx;
}
const rowsSheet = (rows) => ({
  getLastRow: () => rows.length + 1,
  getLastColumn: () => 13,
  getRange: (r, c, nr, nc) => ({ getValues: () => rows.slice(r - 2, r - 2 + nr).map((x) => x.concat(Array(nc).fill('')).slice(0, nc)) }),
});

test('the shared login sees the staff of both shops; Nana and Palladium stay separate', () => {
  const ctx = load();
  const b1 = { authStore: 'Bicasso 1' }, b2 = { authStore: 'Bicasso 2' }, nana = { authStore: 'Bicasso Nana' };
  const sunil = { places: ['Bicasso 2'] }, aye = { places: ['Bicasso 1'] }, mya = { places: ['Bicasso Nana'] }, cover = { places: ['Bicasso Nana', 'Palladium'] };
  assert.equal(ctx.worksAt(sunil, b1), true);
  assert.equal(ctx.worksAt(aye, b2), true);
  assert.equal(ctx.worksAt(mya, b1), false);
  assert.equal(ctx.worksAt(mya, nana), true);
  assert.equal(ctx.worksAt(cover, nana), false, 'warehouse staff never ask for leave from a shop phone');
  assert.equal(ctx.loginLabel(b2), 'Bicasso 1 + 2');
  assert.equal(ctx.loginLabel(nana), 'Bicasso Nana');
});

test('orders on the way: open store orders of both Bicasso shops, done orders and Nana left out', () => {
  const item = (lp, lc, ls, qty) => ({ lp, lc, ls, qty, product: lp, color: 'Color ' + lc, size: ls });
  const row = (id, status, shop, items) => [id, '', shop, '', '', '', JSON.stringify(items), 0, status, '', '', 'store', shop];
  const ctx = load({ Orders: rowsSheet([
    row('A', 'Pending', 'Bicasso 1', [item('B152', '30', '58', 2)]),
    row('B', 'Invoiced', 'Bicasso 2', [item('B152', '30', '58', 1), item('T9027', '43', '50', 3)]),
    row('C', 'Completed', 'Bicasso 1', [item('B152', '30', '58', 5)]),
    row('D', 'Pending', 'Bicasso Nana', [item('B152', '30', '58', 4)]),
  ]) });
  const got = ctx.ordersOnTheWay(['Bicasso 1', 'Bicasso 2']);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { 'B152|30|58': 3, 'T9027|43|50': 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.ordersOnTheWay(['Bicasso Nana']))), { 'B152|30|58': 4 });
});
