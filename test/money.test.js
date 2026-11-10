// Statement totals, commission, and days off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../finance/statement');
const { commissionFor, nanaCommissionFor, dailyBonus } = require('../api/_commission');
const { leaveDaysFromRows, savedDaysFromRows } = require('../api/commission');

const tx = (date, shop, category, a = {}) => ({ row: 0, date, shop, customer: a.customer || '', category, notes: a.notes || '',
  cashIn: a.cashIn || 0, bankIn: a.bankIn || 0, cashOut: a.cashOut || 0, bankOut: a.bankOut || 0, creditAmount: a.credit || 0 });
const LISTS = {
  shops: ['Palladium', 'Bicasso 1'], customers: ['Mars'],
  categories: [{ name: 'Rent', type: 'Expense' }, { name: 'Salary', type: 'Expense' }],
};
const TX = [
  tx('2026-11-01', 'Bicasso 1', 'Opening Balance', { cashIn: 1000, bankIn: 5000 }),
  tx('2026-11-02', 'Bicasso 1', 'Retail Sale', { cashIn: 3000, bankIn: 2000 }),
  tx('2026-11-02', 'Bicasso 1', 'Collection (to Palladium)', { cashOut: 2500 }),
  tx('2026-11-02', 'Bicasso 1', 'Rent', { bankOut: 1500 }),
  tx('2026-11-03', 'Palladium', 'Credit Sale', { customer: 'Mars', credit: 4000 }),
  tx('2026-11-03', 'Palladium', 'Customer Payment', { customer: 'Mars', cashIn: 1000 }),
  tx('2026-11-03', 'Palladium', 'Salary', { cashOut: 800 }),
];

test('statement: opening + period = closing, and a collection only moves cash', () => {
  const s = build(TX, LISTS, '2026-11-02', '2026-11-03');
  assert.deepEqual(s.open, { cash: 1000, bank: 5000, total: 6000, credit: 0, shop: { 'Bicasso 1': 1000, Palladium: 0 } });
  // cash: 1000 + 3000 sale + 1000 payment - 800 salary (the collection is not spending)
  assert.equal(s.close.cash, 4200);
  assert.equal(s.close.bank, 5000 + 2000 - 1500);
  assert.equal(s.close.credit, 3000);
  // drawers: Bicasso 1 = 1000 + 3000 - 2500; Palladium = 2500 collected + 1000 - 800
  assert.equal(s.per['Bicasso 1'].cash, 1500);
  assert.equal(s.per.Palladium.cash, 2700);
  // the drawers add up to total cash
  assert.equal(s.per['Bicasso 1'].cash + s.per.Palladium.cash, s.close.cash);
  assert.equal(s.sales.total, 3000 + 2000 + 4000);
  assert.deepEqual(s.expByCat, { Rent: 1500, Salary: 800 });
});

test('statement: an opening-balance credit sale is not a sale', () => {
  const s = build([tx('2026-11-02', 'Palladium', 'Credit Sale', { customer: 'Mars', credit: 9000, notes: 'Opening balance' })], LISTS, '2026-11-01', '2026-11-30');
  assert.equal(s.sales.total, 0);
  assert.equal(s.close.credit, 9000);
});

const sale = (date, shop, cashIn, bankIn = 0) => ({ date, shop, category: 'Retail Sale', cashIn, bankIn, credit: 0 });

test('commission: 3% of Bicasso sales split by staff, plus the daily bonus bands', () => {
  assert.equal(dailyBonus(32000), 350);
  assert.equal(dailyBonus(8999), 0);
  const c = commissionFor([sale('2026-11-03', 'Bicasso 1', 20000, 12000), sale('2026-11-03', 'Bicasso 2', 9500), sale('2026-10-31', 'Bicasso 1', 50000)], '2026-11', 3);
  assert.equal(c.totalSales, 41500);
  assert.equal(c.commissionEach, Math.round(41500 * 0.03 / 3));
  assert.equal(c.bonusEach, 350 + 25);
});

test('commission: Nana is 1% of cash plus neighbour-card sales', () => {
  const n = nanaCommissionFor([sale('2026-11-03', 'Nana', 5000), { date: '2026-11-03', shop: 'Nana', category: 'Credit Sale', cashIn: 0, bankIn: 0, credit: 3000 }], '2026-11', 2);
  assert.equal(n.totalSales, 8000);
  assert.equal(n.commissionEach, 40);
});

test('days off: approved leave in the month, each day once; saved numbers win', () => {
  const head = ['Request ID', 'Requested', 'Employee ID', 'Name', 'Type', 'Date', 'Reason', 'Status'];
  const rows = [head,
    ['a', '', '1', 'Sunil', 'Day off', '2026-11-03', '', 'Approved'],
    ['b', '', '1', 'Sunil', 'Sick leave', '2026-11-04', '', 'Approved'],
    ['c', '', '1', 'Sunil', 'Day off', '2026-11-05', '', 'Pending'],
    ['d', '', '1', 'Sunil', 'Day off', '2026-11-03', '', 'Approved'],
    ['e', '', '2', 'Kumar', 'Day off', '2026-10-30', '', 'Approved']];
  assert.deepEqual(leaveDaysFromRows(rows, '2026-11'), { Sunil: 2 });
  assert.deepEqual(savedDaysFromRows([['2026-11', 'Sunil', '4'], ['2026-10', 'Kumar', '1']], '2026-11'), { Sunil: 4 });
});
