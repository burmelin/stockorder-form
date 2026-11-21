// Palladium recount (apps-script/Code.gs): the app is the only way to change Palladium stock.
// Each changed size is checked against what the phone showed, saved, and logged in Stock History.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

function setup(stockRows) {
  // Palladium Stock: row 1 empty, row 2 headers, then ID | Product ID | Category | Color | Size | Stock
  const pal = [['', '', '', '', '', ''], ['ID', 'Product ID', 'Category', 'Color', 'Size', 'Stock']].concat(stockRows);
  const history = [['Date/Time', 'Store', 'Product ID', 'Color', 'Size', 'Change', 'Before', 'After', 'Action', 'Reference', 'By']];
  const palSheet = {
    getName: () => 'Palladium Stock',
    getDataRange: () => ({ getValues: () => pal.map((r) => r.slice()) }),
    getRange: (r, c) => ({ setValue: (v) => { pal[r - 1][c - 1] = v; } }),
  };
  const histSheet = {
    getLastRow: () => history.length,
    getRange: (r, c, nr, nc) => ({
      setValues: (v) => v.forEach((row, i) => { history[r - 1 + i] = row; }),
      setNumberFormat() {},
      getValues: () => history.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + (nc || 1))),
    }),
  };
  const ss = { getSheets: () => [palSheet], getSheetByName: (n) => (n === 'Stock History' ? histSheet : n === 'Palladium Stock' ? palSheet : null) };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ EMPLOYEE_PASS: 'pal-pass', OWNER_PASS: 'own-pass', PASS_BICASSO_NANA: 'nana-pass' }) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, pal, history };
}
const PAL = { auth: 'pal-pass', authStore: 'Palladium' };
const ROWS = [['F1165130', 'F1165', 'Linen Pant', '1', '30', 0], ['F1165132', 'F1165', 'Linen Pant', '1', '32', 5]];

test('a recount writes the new numbers and logs who, old -> new and why', () => {
  const { ctx, pal, history } = setup(ROWS.map((r) => r.slice()));
  const r = ctx.palladiumRecount(PAL, [{ pid: 'F1165', col: '1', sz: '30', was: 0, now: 3 }, { pid: 'F1165', col: '1', sz: '32', was: 5, now: 4 }],
    'Recount', 'shelf B', 'Test Person', 'RC-abc123');
  assert.equal(r.success, true);
  assert.equal(r.saved, 2);
  assert.equal(pal[2][5], 3);
  assert.equal(pal[3][5], 4);
  assert.equal(history.length, 3);
  const [, store, pid, col, sz, change, before, after, action, ref, by] = history[1];
  assert.deepEqual([store, pid, col, sz, change, before, after, action, ref, by],
    ['Palladium', 'F1165', '1', '30', 3, 0, 3, 'Recount: Recount', 'RC-abc123 · shelf B', 'Test Person (Palladium login)']);
});

test('the same recount sent twice (a retry) changes nothing the second time', () => {
  const { ctx, pal, history } = setup(ROWS.map((r) => r.slice()));
  const line = [{ pid: 'F1165', col: '1', sz: '30', was: 0, now: 3 }];
  assert.equal(ctx.palladiumRecount(PAL, line, 'Found', '', 'Test Person', 'RC-retry1').success, true);
  const again = ctx.palladiumRecount(PAL, line, 'Found', '', 'Test Person', 'RC-retry1');
  assert.equal(again.alreadyDone, true);
  assert.equal(pal[2][5], 3);
  assert.equal(history.length, 2);
});

test('if stock moved while counting (an order was sent), nothing is saved and the fresh number comes back', () => {
  const { ctx, pal, history } = setup(ROWS.map((r) => r.slice()));
  const r = ctx.palladiumRecount(PAL, [{ pid: 'F1165', col: '1', sz: '30', was: 0, now: 3 }, { pid: 'F1165', col: '1', sz: '32', was: 6, now: 2 }],
    'Recount', '', 'Test Person', 'RC-moved1');
  assert.equal(r.success, false);
  assert.deepEqual(JSON.parse(JSON.stringify(r.changedMeanwhile)), [{ pid: 'F1165', col: '1', sz: '32', was: 6, now: 5 }]);
  assert.equal(pal[2][5], 0, 'the other line is not saved either');
  assert.equal(history.length, 1);
});

test('only Palladium and the owner may recount; shops may not', () => {
  const { ctx } = setup(ROWS.map((r) => r.slice()));
  const line = [{ pid: 'F1165', col: '1', sz: '30', was: 0, now: 1 }];
  assert.equal(ctx.palladiumRecount({ auth: 'nana-pass', authStore: 'Bicasso Nana' }, line, 'Recount', '', 'X', 'RC-shop01').needLogin, true);
  assert.equal(ctx.palladiumRecount({ auth: 'own-pass', authStore: 'Owner' }, line, 'Recount', '', 'Owner', 'RC-owner1').success, true);
});

test('bad input is refused before anything changes', () => {
  const { ctx, pal } = setup(ROWS.map((r) => r.slice()));
  const ok = { pid: 'F1165', col: '1', sz: '30', was: 0, now: 2 };
  assert.match(ctx.palladiumRecount(PAL, [ok], 'Because', '', 'Test Person', 'RC-bad001').error, /reason/);
  assert.match(ctx.palladiumRecount(PAL, [ok], 'Recount', '', '', 'RC-bad002').error, /who counted/);
  assert.match(ctx.palladiumRecount(PAL, [{ ...ok, now: -1 }], 'Recount', '', 'Test Person', 'RC-bad003').error, /whole pieces/);
  assert.match(ctx.palladiumRecount(PAL, [{ ...ok, now: 2.5 }], 'Recount', '', 'Test Person', 'RC-bad004').error, /whole pieces/);
  assert.match(ctx.palladiumRecount(PAL, [{ ...ok, sz: '99' }], 'Recount', '', 'Test Person', 'RC-bad005').error, /not in Palladium Stock/);
  assert.match(ctx.palladiumRecount(PAL, [ok, ok], 'Recount', '', 'Test Person', 'RC-bad006').error, /listed twice/);
  assert.match(ctx.palladiumRecount(PAL, [ok], 'Recount', '', 'Test Person', 'bad').error, /recount ID/);
  assert.equal(pal[2][5], 0);
});
