const test = require('node:test');
const assert = require('node:assert');
const { summarize } = require('../api/drawer');
const Statement = require('../finance/statement');

const row = (o) => ({ row: 2, date: '2026-11-15', shop: 'Warehouse', customer: '', category: 'Retail Sale', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, credit: 0, enteredBy: 'Palladium manager', notes: '', ...o });

test('drawer: cash in hand = float + sales − expenses; only today\'s own rows can be deleted', () => {
  const d = summarize([
    row({ row: 2, date: '2026-10-30', category: 'Drawer Float', cashIn: 1000, enteredBy: 'App' }),
    row({ row: 3, date: '2026-11-14', category: 'Other Expense', cashOut: 200 }),
    row({ row: 4, category: 'Retail Sale', cashIn: 500 }),
    row({ row: 5, shop: 'Palladium', category: 'Drawer Float', cashOut: 1000 }),
  ], '2026-11-15');
  assert.strictEqual(d.cash, 1300);
  assert.deepStrictEqual(d.entries.map((e) => [e.row, e.what, e.amount, e.canDelete]), [[4, 'Sale', 500, true], [3, 'Expense', -200, false]]);
});

test('statement: a float moves cash without counting as income; profit = shops − office costs', () => {
  const t = (o) => ({ row: 1, date: '2026-11-15', customer: '', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 0, notes: '', ...o });
  const lists = { shops: ['Bicasso 1', 'Palladium', 'Warehouse'], customers: [], categories: [] };
  const s = Statement.build([
    t({ shop: 'Palladium', category: 'Drawer Float', cashOut: 1000 }),
    t({ shop: 'Warehouse', category: 'Drawer Float', cashIn: 1000 }),
    t({ shop: 'Warehouse', category: 'Other Expense', cashOut: 100 }),
    t({ shop: 'Bicasso 1', category: 'Retail Sale', cashIn: 5000, bankIn: 3000 }),
    t({ shop: 'Bicasso 1', category: 'Rent', bankOut: 2000 }),
    t({ shop: 'Palladium', category: 'Groceries', cashOut: 700 }),
  ], lists, '2026-11-15', '2026-11-15');
  assert.strictEqual(s.incomes.length, 0);
  assert.strictEqual(s.per.Warehouse.cash, 900);
  assert.strictEqual(s.close.cash, 5000 - 100 - 700);
  const b1 = s.profit.shops.find((r) => r.shop === 'Bicasso 1');
  assert.deepStrictEqual([b1.sales, b1.costs, b1.profit], [8000, 2000, 6000]);
  assert.strictEqual(s.profit.office.costs, 700);
  assert.strictEqual(s.profit.company, 6000 - 100 - 700);
  assert.strictEqual(Statement.label('Palladium'), 'Office');
  assert.strictEqual(Statement.label('Warehouse'), 'Palladium');
});
