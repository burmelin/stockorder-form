// The import's daily "Card Fee" rows: Bank shows what the bank pays in (card less its fee,
// QR in full), sales stay at full value, and a fee changed by hand is kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyTotals, planFees, TAG } = require('../api/_loyverse');
const Statement = require('../finance/statement');

const STORES = new Map([['b1', 'Bicasso 1'], ['b2', 'Bicasso 2'], ['n', 'Nana'], ['p', 'Palladium']]);
const DAY = '2026-11-12';
const DATES = new Set([DAY]);
const AT = '2026-11-12T05:00:00.000Z';
const receipt = (store, payments, extra = {}) => ({
  store_id: store, created_at: AT, receipt_date: AT, receipt_type: 'SALE',
  total_money: payments.reduce((n, p) => n + p.money_amount, 0), payments, ...extra,
});
const pay = (name, n, type = 'OTHER') => ({ type, name, money_amount: n });

test('dailyTotals splits card from QR / SCAN inside bank', () => {
  const { totals } = dailyTotals([
    receipt('b2', [pay('Card', 2000, 'CARD')]),
    receipt('b2', [pay('SCAN', 700)]),
    receipt('b2', [pay('Card', 300, 'CARD')], { receipt_type: 'REFUND' }),
  ], STORES, DATES);
  assert.equal(totals[0].bank, 2400);
  assert.equal(totals[0].card, 1700);
});

const total = (shop, card, extra = {}) => ({ date: DAY, shop, cash: 0, bank: card, card, credit: 0, account: null, receipts: 1, refunds: 0, ...extra });
const feeRow = (bankOut, notes, enteredBy = TAG, row = 9) => ({ row, date: DAY, shop: 'Bicasso 2', category: 'Card Fee', bankOut, enteredBy, notes });

test('a Bicasso day with card sales gets a Card Fee row at the rate; QR has no fee', () => {
  const [a] = planFees([total('Bicasso 2', 2700, { bank: 3400 })], [], 2.89);
  assert.equal(a.action, 'add');
  assert.equal(a.category, 'Card Fee');
  assert.equal(a.bankOut, 78.03);
  assert.match(a.note, /estimate.*2\.89%.*\[fee 78\.03\]$/);
});

test('only Bicasso shops, and not a day with no card sales', () => {
  const acts = planFees([total('Palladium', 1000), total('Nana', 1000, { account: 'Nana Card' }), total('Bicasso 1', 0, { bank: 500 })], [], 2.89);
  assert.deepEqual(acts, []);
});

test('re-runs leave the row, update it when Loyverse changes, keep a hand change', () => {
  assert.equal(planFees([total('Bicasso 2', 2700)], [feeRow(78.03, 'x [fee 78.03]')], 2.89)[0].action, 'unchanged');
  const up = planFees([total('Bicasso 2', 3000)], [feeRow(78.03, 'x [fee 78.03]')], 2.89)[0];
  assert.equal(up.action, 'update'); assert.equal(up.row, 9); assert.equal(up.bankOut, 86.7);
  const kept = planFees([total('Bicasso 2', 3000)], [feeRow(80, 'x [fee 78.03]')], 2.89)[0];
  assert.equal(kept.action, 'skip'); assert.equal(kept.kept, true);
  const hand = planFees([total('Bicasso 2', 3000)], [feeRow(80, 'real fee', 'Owner')], 2.89)[0];
  assert.equal(hand.action, 'skip');
});

test('statement: Bank takes the fee off, sales stay full, the fee is an expense', () => {
  const tx = [
    { row: 2, date: DAY, shop: 'Bicasso 2', category: 'Retail Sale', cashIn: 0, bankIn: 2700, cashOut: 0, bankOut: 0, creditAmount: 0 },
    { row: 3, date: DAY, shop: 'Bicasso 2', category: 'Card Fee', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 78.03, creditAmount: 0, notes: 'est' },
  ];
  const lists = { shops: ['Bicasso 1', 'Bicasso 2'], categories: [{ name: 'Other Expense', type: 'Expense' }] };
  const s = Statement.build(tx, lists, DAY, DAY);
  assert.equal(s.sales.total, 2700);
  assert.equal(Math.round((s.close.bank - s.open.bank) * 100) / 100, 2621.97);
  assert.equal(s.cardFee, 78.03);
  assert.equal(s.per['Bicasso 2'].bankOut, 0);
  assert.equal(s.expenseTotal.bank, 78.03);
  assert.equal(s.expByCat['Card Fee'], 78.03);
});
