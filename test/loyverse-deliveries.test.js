// Release 2 (19 Nov 2026): a Burmelin delivery goes into Loyverse, and nothing reads or writes the
// old Bicasso 1 / Bicasso 2 / Nana Stock tabs any more.
//  - planReceive (api/_shopstock.js): order lines -> new Loyverse stock levels
//  - Apps Script (apps-script/Code.gs): markDone, loyverseClaim, loyverseResult, getRetailStock
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { variantIndex, planReceive } = require('../api/_shopstock');

// ── planReceive ──────────────────────────────────────────────────
const ITEMS = [
  { item_name: 'B152 Polo', option1_name: 'Colour', option2_name: 'Size',
    variants: [{ variant_id: 'p58', option1_value: '30', option2_value: '58' }, { variant_id: 'p60', option1_value: '30', option2_value: '60' }] },
  { item_name: 'F1165-3# Pant', option1_name: 'Size', variants: [{ variant_id: 'f32', option1_value: '32' }] },
  { item_name: 'T2051 Short Pant', variants: [{ variant_id: 'tot' }] },
];

test('planReceive: Loyverse stock now + the delivery, per size; unknown sizes listed to add by hand', () => {
  const levels = [
    { variant_id: 'p58', store_id: 'burm', in_stock: 2 },
    { variant_id: 'p60', store_id: 'burm', in_stock: -1 },   // a wrong tap in Loyverse: still counts from there
    { variant_id: 'p58', store_id: 'nana', in_stock: 9 },    // another store: ignored
  ];
  const lines = [
    { pid: 'B152', col: '30', sz: '58', qty: 3, label: 'B152 · Colour 30 · Size 58' },
    { pid: 'B152', col: '30', sz: '58', qty: 1 },            // same size twice in one order: added up
    { pid: 'B152', col: '30', sz: '60', qty: 2 },
    { pid: 'F1165', col: '3', sz: '32', qty: 4 },            // Palladium writes 3, Loyverse 3#
    { pid: 'T2051', col: '', sz: '', qty: 5, label: 'T2051 · Colour  · Size ' },   // total-only item: by hand
    { pid: 'B152', col: '30', sz: '99', qty: 1, label: 'B152 · Colour 30 · Size 99' },
    { pid: 'B152', col: '30', sz: '58', qty: 0 },
  ];
  const plan = planReceive(variantIndex(ITEMS), levels, lines, 'burm');
  assert.deepEqual(plan.updates, [
    { variant_id: 'p58', store_id: 'burm', stock_after: 6 },
    { variant_id: 'p60', store_id: 'burm', stock_after: 1 },
    { variant_id: 'f32', store_id: 'burm', stock_after: 4 },   // no stock record yet: starts from 0
  ]);
  assert.equal(plan.pcs, 10);
  assert.deepEqual(plan.missing, ['T2051 · Colour  · Size  ×5', 'B152 · Colour 30 · Size 99 ×1']);
});

// ── Apps Script with a fake spreadsheet ──────────────────────────
const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

// Anything a test doesn't care about (formatting, clear, merge…) is a no-op that returns itself
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? function () { return lenient(t); } : undefined)) });

function fakeSheet(name, rows) {
  const grid = rows.map((r) => r.slice());
  const touched = { reads: 0, writes: 0 };
  const cell = (r, c) => { while (grid.length < r) grid.push([]); const row = grid[r - 1]; while (row.length < c) row.push(''); return row; };
  const range = (r, c, nr = 1, nc = 1) => lenient({
    getValues: () => { touched.reads++; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (grid[r - 1 + i] || [])[c - 1 + j] ?? '')); },
    getValue: () => { touched.reads++; return (grid[r - 1] || [])[c - 1] ?? ''; },
    setValues: (v) => { touched.writes++; v.forEach((row, i) => row.forEach((x, j) => { cell(r + i, c + j)[c - 1 + j] = x; })); return range(r, c, nr, nc); },
    setValue: (x) => { touched.writes++; cell(r, c)[c - 1] = x; return range(r, c, nr, nc); },
    setBackground() { return this; }, setBackgrounds() { return this; }, setNumberFormat() { return this; },
    setFontWeight() { return this; }, setFontColor() { return this; },
  });
  return lenient({
    grid, touched,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(1, ...grid.map((r) => r.length)),
    getRange: range,
    getDataRange() { return range(1, 1, Math.max(1, grid.length), this.getLastColumn()); },
    appendRow: (r) => { touched.writes++; grid.push(r.slice()); },
    setFrozenRows() {}, setColumnWidths() {}, setColumnWidth() {},
  });
}

function load(sheets) {
  const list = Object.values(sheets);
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => list,
    insertSheet: (n) => { sheets[n] = fakeSheet(n, []); list.push(sheets[n]); return sheets[n]; },
  };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ EMPLOYEE_PASS: 'pal-pass' }) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok', getActiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { formatDate: () => '19/11 16:00' },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return ctx;
}

const item = (lp, lc, ls, qty) => ({ lp, lc, ls, qty, product: lp, color: 'Color ' + lc, size: ls });
const orderRow = (id, status, shop, items, lv = '') => [id, '19/11/2026', shop, '', '', '', JSON.stringify(items), 0, status, '', '', 'store', shop, lv];

function world(orders) {
  return {
    'Palladium Stock': fakeSheet('Palladium Stock', [
      ['ID', 'Product ID', 'Category', 'Color', 'Size', 'Stock'],
      ['', 'B152', 'Polo', '30', '58', 10],
      ['', 'B152', 'Polo', '30', '60', 5],
    ]),
    Orders: fakeSheet('Orders', [['Order ID', 'Date', 'Customer Name', 'E', 'P', 'N', 'Items', 'Q', 'Status', 'Inv', 'Done', 'Type', 'Shop']].concat(orders)),
    'Bicasso 1 Stock': fakeSheet('Bicasso 1 Stock', [['ID', 'Product ID', 'Category', 'Color', 'Size', 'Stock'], ['', 'B152', 'Polo', '30', '58', 1]]),
    'Bicasso 2 Stock': fakeSheet('Bicasso 2 Stock', [['ID', 'Product ID', 'Category', 'Color', 'Size', 'Stock']]),
    'Bicasso Nana Stock': fakeSheet('Bicasso Nana Stock', [['ID', 'Product ID', 'Category', 'Color', 'Size', 'Stock']]),
  };
}
const OLD_TABS = ['Bicasso 1 Stock', 'Bicasso 2 Stock', 'Bicasso Nana Stock'];
const untouched = (w) => OLD_TABS.every((n) => w[n].touched.reads === 0 && w[n].touched.writes === 0);
const PAL = { auth: 'pal-pass' };

test('Done on a Burmelin order: Palladium goes down, old shop tabs untouched, order says "To add"', () => {
  const w = world([orderRow('ORD-1', 'Pending', 'Burmelin', [item('B152', '30', '58', 3)])]);
  const ctx = load(w);
  const r = ctx.markDone('ORD-1', 'pal-pass');
  assert.equal(r.success, true);
  assert.equal(r.loyverse, 'To add');
  assert.equal(w['Palladium Stock'].grid[1][5], 7);
  assert.equal(w.Orders.grid[1][8], 'Completed');
  assert.equal(w.Orders.grid[1][13], 'To add');
  assert.equal(w.Orders.grid[0][13], 'Loyverse', 'the column gets a heading');
  assert.ok(untouched(w), 'the old Bicasso 1 / 2 / Nana tabs are not read or written');
});

test('Done on an older Bicasso 2 order also goes to Burmelin in Loyverse; a Nana order says "Add by hand"', () => {
  const w = world([
    orderRow('ORD-2', 'Pending', 'Bicasso 2', [item('B152', '30', '60', 1)]),
    orderRow('ORD-3', 'Pending', 'Bicasso Nana', [item('B152', '30', '60', 2)]),
  ]);
  const ctx = load(w);
  assert.equal(ctx.markDone('ORD-2', 'pal-pass').loyverse, 'To add');
  assert.equal(ctx.markDone('ORD-3', 'pal-pass').loyverse, 'Add by hand');
  assert.equal(w['Palladium Stock'].grid[2][5], 2);
  assert.ok(untouched(w));
});

test('claim -> result: a delivery can only be added once; a failure can be tried again', () => {
  const w = world([
    orderRow('ORD-4', 'Completed', 'Burmelin', [item('B152', '30', '58', 2), item('B152', '30', '58', 1)], 'To add'),
    orderRow('ORD-5', 'Pending', 'Burmelin', [item('B152', '30', '58', 1)]),
    orderRow('ORD-6', 'Completed', 'Bicasso Nana', [item('B152', '30', '58', 1)], 'Add by hand'),
  ]);
  const ctx = load(w);
  assert.equal(ctx.loyverseClaim({ auth: 'shop-pass' }, 'ORD-4').success, false, 'only Palladium');
  assert.match(ctx.loyverseClaim(PAL, 'ORD-5').error, /Done first/);
  assert.match(ctx.loyverseClaim(PAL, 'ORD-6').error, /Only Burmelin/);

  const c = ctx.loyverseClaim(PAL, 'ORD-4');
  assert.equal(c.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.lines)), [{ pid: 'B152', col: '30', sz: '58', qty: 3, label: 'B152 · Colour 30 · Size 58' }]);
  assert.match(w.Orders.grid[1][13], /^Adding/);
  assert.equal(ctx.loyverseClaim(PAL, 'ORD-4').busy, true, 'a double tap is refused while it is being added');

  ctx.loyverseResult(PAL, 'ORD-4', { ok: false, error: 'Loyverse down' });
  assert.equal(w.Orders.grid[1][13], 'Failed: Loyverse down');
  assert.equal(ctx.loyverseClaim(PAL, 'ORD-4').success, true, 'a failed one can be tried again');
  const r = ctx.loyverseResult(PAL, 'ORD-4', { ok: true, pcs: 3, missing: [] });
  assert.equal(r.loyverse, 'Added 19/11 16:00 · 3 pcs');
  assert.equal(ctx.loyverseClaim(PAL, 'ORD-4').already, true, 'never added twice');
  assert.equal(ctx.loyverseResult(PAL, 'ORD-4', { ok: true, pcs: 3 }).success, false, 'a result needs a claim');
  assert.ok(untouched(w));
});

test('getRetailStock / getStoreBundle read only Palladium; old shop tabs are not read', () => {
  const w = world([]);
  const ctx = load(w);
  const all = ctx.getRetailStock(null);
  assert.equal(all.success, true);
  assert.deepEqual(Object.keys(all.stores).sort(), ['Bicasso 1', 'Bicasso 2', 'Bicasso Nana', 'Palladium']);
  assert.deepEqual(JSON.parse(JSON.stringify(all.stores['Bicasso 1'])), {});
  assert.equal(all.stores.Palladium.B152['Color 30']['58'], 10);
  const b = ctx.getStoreBundle('Bicasso 1');
  assert.equal(b.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(b.stores)), {});
  assert.ok(untouched(w));
});

test('generateMasterSheet adds the shop stock the app sends (Loyverse), not the old tabs', () => {
  const w = world([]);
  const ctx = load(w);
  const r = ctx.generateMasterSheet('pal-pass', {}, { 'B152||30||58': 4 });
  assert.equal(r.success, true, r.error);
  const cells = (sheet) => sheet.grid.flat().filter((x) => typeof x === 'number');
  assert.ok(cells(w.Master).includes(14), 'Palladium 10 + Burmelin/Nana 4');
  const w2 = world([]);
  load(w2).generateMasterSheet('pal-pass', {}, {});
  assert.ok(!cells(w2.Master).includes(14) && cells(w2.Master).includes(10), 'without shop stock: Palladium only');
  assert.ok(untouched(w));
});
