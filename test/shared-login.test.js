// Bicasso 1 and Bicasso 2 are one shop, "Burmelin" (apps-script/Code.gs): one login, orders go to
// Burmelin, leave lists cover both POS' staff, and Restock's "on the way" adds all their open orders.
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
  assert.equal(ctx.loginLabel(b2), 'Burmelin');
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
    row('E', 'Pending', 'Burmelin', [item('B152', '30', '58', 10)]),
  ]) });
  const got = ctx.ordersOnTheWay(ctx.SHARED_STOCK['Bicasso 1']);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { 'B152|30|58': 13, 'T9027|43|50': 3 }, 'new Burmelin orders and older B1/B2 orders both count');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.ordersOnTheWay(['Bicasso Nana']))), { 'B152|30|58': 4 });
});

test('an order from the Burmelin login is saved as shop "Burmelin", whatever the phone sends', () => {
  const saved = [];
  const orders = {
    getLastRow: () => 1 + saved.length,
    getRange: () => ({ setValues: (v) => saved.push(v[0]), setNumberFormat() {}, setBackground() {}, getValues: () => [] }),
  };
  const ctx = load({ Orders: orders });
  Object.assign(ctx, {
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok' },
    Utilities: { formatDate: () => '261118' },
    notifyOwner() {},
  });
  ctx.SpreadsheetApp.flush = () => {};
  vm.runInContext('ORDERS_TAB_NAME = "Orders"', ctx);
  const items = [{ product: 'B152', qty: 2 }];
  const r1 = ctx.submitOrder({ items, orderType: 'store', shopName: 'Bicasso 2' }, { auth: 'x', authStore: 'Bicasso 1' });
  const r2 = ctx.submitOrder({ items, orderType: 'store', shopName: 'Bicasso Nana' }, { auth: 'x', authStore: 'Bicasso 2' });
  const r3 = ctx.submitOrder({ items, orderType: 'store', shopName: 'Burmelin' }, { auth: 'x', authStore: 'Bicasso Nana' });
  assert.deepEqual([r1, r2, r3].map((r) => r.error || "ok"), ["ok", "ok", "ok"]);
  assert.deepEqual(saved.map((row) => [row[2], row[12]]), [['Burmelin', 'Burmelin'], ['Burmelin', 'Burmelin'], ['Bicasso Nana', 'Bicasso Nana']]);
});
