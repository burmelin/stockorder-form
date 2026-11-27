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
    t({ shop: 'Palladium', category: 'Home Expenses', cashOut: 500, notes: 'Groceries' }),
    t({ shop: 'Palladium', category: 'Home Expenses', cashOut: 200, notes: 'Gas' }),
  ], lists, '2026-11-15', '2026-11-15');
  assert.strictEqual(s.incomes.length, 0);
  const home = s.expenses.filter((e) => e.category === 'Home Expenses');
  assert.strictEqual(home.length, 1);
  assert.strictEqual(home[0].cash, 700);
  assert.strictEqual(home[0].notes, 'Groceries 500 · Gas 200');
  assert.strictEqual(s.per.Warehouse.cash, 900);
  assert.strictEqual(s.close.cash, 5000 - 100 - 700);
  const b1 = s.profit.shops.find((r) => r.shop === 'Bicasso 1');
  assert.deepStrictEqual([b1.sales, b1.costs, b1.profit], [8000, 2000, 6000]);
  assert.strictEqual(s.profit.office.costs, 700);
  assert.strictEqual(s.profit.company, 6000 - 100 - 700);
  assert.strictEqual(Statement.label('Palladium'), 'Office');
  assert.strictEqual(Statement.label('Warehouse'), 'Palladium');
});

// ---- Palladium sale paid by Cash / Bank / Not paid yet (api/drawer.js planRow) ----
const { planRow, refOf, UNPAID } = require('../api/drawer');
const DAY = '2026-11-27';

test('sale: cash goes to Cash In, bank to Bank In, unpaid is a Credit Sale to "Palladium Unpaid"', () => {
  const b = { kind: 'sale', amount: 1200, note: 'F1165 · Colour 1 · Size L · 2 × 350 + B152 · Colour 3 · Size 32 · 1 × 500', ref: 'PSabc12345' };
  const cash = planRow({ ...b, pay: 'cash', who: 'Cousin' }, [], DAY, 'Palladium manager').values;
  assert.deepStrictEqual(cash.slice(0, 10), ['11/27/2026', 'Warehouse', '', 'Retail Sale', null, 1200, '', '', '', '']);
  assert.strictEqual(cash[10], 'Palladium manager');
  assert.strictEqual(cash[11], b.note + ' · Cousin · Ref PSabc12345');
  const bank = planRow({ ...b, pay: 'bank' }, [], DAY, 'Palladium manager').values;
  assert.deepStrictEqual([bank[3], bank[5], bank[6]], ['Retail Sale', '', 1200]);
  const owe = planRow({ ...b, pay: 'unpaid', who: 'Ko Aung' }, [], DAY, 'Palladium manager').values;
  assert.deepStrictEqual([owe[2], owe[3], owe[5], owe[6], owe[9]], [UNPAID, 'Credit Sale', '', '', 1200]);
  assert.strictEqual(refOf(owe[11]), 'PSabc12345');
  // an old-style sale (no pay sent) is still cash
  assert.strictEqual(planRow({ kind: 'sale', amount: 100, note: 'x' }, [], DAY, 'Owner').values[5], 100);
});

test('sale: unpaid needs a name; a bad pay type is refused; a retry with the same ref writes nothing', () => {
  const b = { kind: 'sale', amount: 900, note: 'T9039 · Colour 2 · Size 52 · 2 × 450', ref: 'PSabc12345' };
  assert.match(planRow({ ...b, pay: 'unpaid', who: '  ' }, [], DAY, 'x').error, /who will pay/);
  assert.match(planRow({ ...b, pay: 'card' }, [], DAY, 'x').error, /Cash, Bank or Not paid yet/);
  const saved = row({ row: 10, date: DAY, customer: UNPAID, category: 'Credit Sale', credit: 900, notes: b.note + ' · Ko Aung · Ref PSabc12345' });
  assert.deepStrictEqual(planRow({ ...b, pay: 'unpaid', who: 'Ko Aung' }, [saved], DAY, 'x'), { already: true });
});

test('unpaid list: a sale stays owed until it is marked paid; cash payment goes in the drawer, bank does not', () => {
  const sale = row({ row: 10, date: '2026-11-20', customer: UNPAID, category: 'Credit Sale', credit: 900, notes: 'T9039 · Colour 2 · Size 52 · 2 × 450 · Ko Aung · Ref PSabc12345' });
  const sale2 = row({ row: 11, date: '2026-11-21', customer: UNPAID, category: 'Credit Sale', credit: 400, notes: 'B152 · Colour 3 · Size 32 · 1 × 400 · Ma Hla · Ref PSdef67890' });
  const float = row({ row: 2, date: '2026-11-01', category: 'Drawer Float', cashIn: 1000, enteredBy: 'App' });
  let d = summarize([float, sale, sale2], DAY);
  assert.strictEqual(d.cash, 1000);                     // nothing owed is in the drawer
  assert.deepStrictEqual(d.unpaid.map((u) => [u.ref, u.amount]), [['PSdef67890', 400], ['PSabc12345', 900]]);
  assert.strictEqual(d.unpaidTotal, 1300);
  assert.deepStrictEqual(d.entries.filter((e) => e.what === 'Sale').map((e) => [e.amount, e.pay]), [[400, 'unpaid'], [900, 'unpaid']]);

  const pay = planRow({ kind: 'paid', ref: 'PSabc12345', pay: 'cash' }, [float, sale, sale2], DAY, 'Palladium manager').values;
  assert.deepStrictEqual([pay[1], pay[2], pay[3], pay[5], pay[6], pay[9]], ['Warehouse', UNPAID, 'Customer Payment', 900, '', '']);
  assert.strictEqual(pay[11], 'Paid · Ko Aung · sale of 2026-11-20 · Ref PSabc12345');
  const paidRow = row({ row: 12, date: DAY, customer: UNPAID, category: 'Customer Payment', cashIn: 900, notes: pay[11] });
  d = summarize([float, sale, sale2, paidRow], DAY);
  assert.strictEqual(d.cash, 1900);
  assert.deepStrictEqual(d.unpaid.map((u) => u.ref), ['PSdef67890']);
  assert.strictEqual(d.entries[0].what, 'Paid');
  // marking it paid twice writes nothing
  assert.deepStrictEqual(planRow({ kind: 'paid', ref: 'PSabc12345', pay: 'cash' }, [sale, paidRow], DAY, 'x'), { already: true });

  const bank = planRow({ kind: 'paid', ref: 'PSdef67890', pay: 'bank' }, [sale2], DAY, 'x').values;
  assert.deepStrictEqual([bank[5], bank[6]], ['', 400]);
  assert.match(planRow({ kind: 'paid', ref: 'PSnothere99', pay: 'cash' }, [sale2], DAY, 'x').error, /not found/);
});

test('statement: an unpaid sale counts as a sale on its day; the later payment is not counted again', () => {
  const t = (o) => ({ row: 1, customer: '', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, creditAmount: 0, notes: '', ...o });
  const lists = { shops: ['Palladium', 'Warehouse'], customers: [UNPAID], categories: [] };
  const tx = [
    t({ date: '2026-11-20', shop: 'Warehouse', customer: UNPAID, category: 'Credit Sale', creditAmount: 900, notes: 'x · Ko Aung · Ref PSabc12345' }),
    t({ date: '2026-11-21', shop: 'Warehouse', category: 'Retail Sale', bankIn: 500 }),
    t({ date: '2026-11-27', shop: 'Warehouse', customer: UNPAID, category: 'Customer Payment', cashIn: 900 }),
  ];
  const s = Statement.build(tx, lists, '2026-11-01', '2026-11-30');
  const wh = s.profit.shops.find((r) => r.shop === 'Warehouse');
  assert.strictEqual(wh.sales, 1400);
  assert.strictEqual(s.per.Warehouse.cash, 900);
  assert.strictEqual(s.close.bank, 500);
});
