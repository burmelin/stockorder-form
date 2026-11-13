// The Loyverse import: receipts -> daily totals, the add/update/keep plan, pay-outs, and the
// guards that stop the same money being counted twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyTotals, cardReceipts, planSync, planMovements, loyverseClash, payoutClash, TAG } = require('../api/_loyverse');

const STORES = new Map([['s1', 'Bicasso 1'], ['s2', 'Nana']]);
const DAY = '2026-11-05';
const DATES = new Set([DAY]);
// 10:00 Bangkok time on DAY
const AT = '2026-11-05T03:00:00.000Z';
const receipt = (store, payments, extra = {}) => ({
  store_id: store, created_at: AT, receipt_date: AT, receipt_type: 'SALE',
  total_money: payments.reduce((n, p) => n + p.money_amount, 0), payments, ...extra,
});
const cash = (n) => ({ type: 'CASH', name: 'Cash', money_amount: n });
const card = (n) => ({ type: 'CARD', name: 'Card', money_amount: n });

test('receipts add up per shop per day: cash, bank, refunds, cancelled', () => {
  const { totals } = dailyTotals([
    receipt('s1', [cash(1000)]),
    receipt('s1', [card(500)]),
    receipt('s1', [cash(200)], { receipt_type: 'REFUND' }),
    receipt('s1', [cash(999)], { cancelled_at: AT }),
  ], STORES, DATES);
  assert.equal(totals.length, 1);
  assert.deepEqual({ cash: totals[0].cash, bank: totals[0].bank, receipts: totals[0].receipts, refunds: totals[0].refunds },
    { cash: 800, bank: 500, receipts: 2, refunds: 1 });
});

test('cash handed over before change is cut back to the receipt total', () => {
  const r = receipt('s1', [cash(1000)]);
  r.total_money = 850;
  const { totals } = dailyTotals([r], STORES, DATES);
  assert.equal(totals[0].cash, 850);
});

test('card sales at a neighbour-card shop become credit, not bank', () => {
  const { totals } = dailyTotals([receipt('s2', [cash(300), card(700)])], STORES, DATES, { Nana: 'Nana Card (Neighbour)' });
  assert.equal(totals[0].bank, 0);
  assert.equal(totals[0].credit, 700);
  assert.equal(totals[0].account, 'Nana Card (Neighbour)');
});

const total = (cashN, bankN) => ({ date: DAY, shop: 'Bicasso 1', cash: cashN, bank: bankN, credit: 0, account: null, receipts: 3, refunds: 0 });
const sheetRow = (extra) => ({ row: 50, date: DAY, shop: 'Bicasso 1', customer: '', category: 'Retail Sale', cashIn: 0, bankIn: 0, cashOut: 0, bankOut: 0, credit: 0, enteredBy: TAG, notes: '', ...extra });

test('a new day is added; the same numbers again are left unchanged', () => {
  assert.equal(planSync([total(800, 500)], [], DAY)[0].action, 'add');
  const same = sheetRow({ cashIn: 800, bankIn: 500, notes: 'Loyverse · 3 receipts [800|500|0]' });
  assert.equal(planSync([total(800, 500)], [same], DAY)[0].action, 'unchanged');
});

test('a late receipt updates the Loyverse row in place', () => {
  const row = sheetRow({ cashIn: 800, bankIn: 500, notes: 'Loyverse · 3 receipts [800|500|0]' });
  const [p] = planSync([total(900, 500)], [row], DAY);
  assert.equal(p.action, 'update');
  assert.equal(p.row, 50);
});

test('a row corrected by hand is kept, never overwritten', () => {
  const corrected = sheetRow({ cashIn: 750, bankIn: 500, notes: 'Loyverse · 3 receipts [800|500|0]' });
  const [p] = planSync([total(900, 500)], [corrected], DAY);
  assert.equal(p.action, 'skip');
  assert.equal(p.kept, true);
});

test('a day typed by hand is left alone (no second sales row)', () => {
  const hand = sheetRow({ cashIn: 800, enteredBy: 'App' });
  const [p] = planSync([total(800, 500)], [hand], DAY);
  assert.equal(p.action, 'skip');
});

test('older rows without a stamp are kept (can not tell if they were corrected)', () => {
  const old = sheetRow({ cashIn: 700, notes: 'Loyverse · 3 receipts' });
  const [p] = planSync([total(800, 500)], [old], '2026-11-09');
  assert.equal(p.action, 'skip');
});

test('pay-outs are classified from the note and found again on re-runs', () => {
  const shifts = [{ store_id: 's1', opened_at: AT, cash_movements: [
    { type: 'PAY_OUT', money_amount: 5000, comment: 'Collected by Sonu', created_at: AT },
    { type: 'PAY_OUT', money_amount: 300, comment: 'taxi', created_at: AT },
    { type: 'PAY_OUT', money_amount: 8000, comment: 'Salary Kumar', created_at: AT },
  ] }];
  const first = planMovements(shifts, STORES, DATES, {}, new Map(), []).actions;
  assert.deepEqual(first.map((a) => [a.category, a.action]),
    [['Collection (to Palladium)', 'add'], ['Other Expense', 'add'], ['Salary', 'add']]);
  // Same shift again, rows now in the sheet: nothing new
  const existing = first.map((a, i) => ({ row: 60 + i, date: a.date, shop: a.shop, category: a.category, cashIn: 0, bankIn: 0, cashOut: a.cashOut, enteredBy: TAG, notes: a.note }));
  const again = planMovements(shifts, STORES, DATES, {}, new Map(), existing).actions;
  assert.ok(again.every((a) => a.action === 'unchanged'));
});

test('hand-typed sales are refused once Loyverse imported that day', () => {
  const imported = [sheetRow({ cashIn: 800 })];
  assert.match(loyverseClash(imported, [{ category: 'Retail Sale', shop: 'Bicasso 1', date: DAY }]), /already imported/);
  assert.equal(loyverseClash(imported, [{ category: 'Retail Sale', shop: 'Bicasso 2', date: DAY }]), null);
  assert.equal(loyverseClash(imported, [{ category: 'Rent', shop: 'Bicasso 1', date: DAY }]), null);
});

test('a hand-typed cash expense asks first when Loyverse has pay-outs that day', () => {
  const imported = [sheetRow({ category: 'Other Expense', cashOut: 300, notes: 'taxi · 10:00' })];
  assert.match(payoutClash(imported, [{ category: 'Other Expense', shop: 'Bicasso 1', date: DAY, cashOut: 300 }]), /Save your entries anyway/);
  assert.equal(payoutClash(imported, [{ category: 'Rent', shop: 'Bicasso 1', date: DAY, bankOut: 300 }]), null);
});

test('card receipts: one line per card / QR receipt, adding up to the day\'s Bank In', () => {
  const qr = (n) => ({ type: 'OTHER', name: 'QR PromptPay', money_amount: n });
  const receipts = [
    receipt('s1', [card(500)], { receipt_number: '1-1001', receipt_date: '2026-11-05T08:30:00.000Z' }),
    receipt('s1', [cash(1000)]),
    receipt('s1', [cash(300), qr(700)], { receipt_number: '1-1002' }),
    receipt('s1', [card(200)], { receipt_type: 'REFUND', receipt_number: '1-1003' }),
    receipt('s1', [card(999)], { cancelled_at: AT }),
    receipt('s1', [card(400)], { receipt_date: '2026-11-06T03:00:00.000Z' }),
  ];
  const lines = cardReceipts(receipts, STORES, DATES);
  assert.deepEqual(lines.map((l) => [l.time, l.number, l.amount, l.methods.join()]), [
    ['10:00', '1-1002', 700, 'QR PromptPay'],
    ['10:00', '1-1003', -200, 'Card'],
    ['15:30', '1-1001', 500, 'Card'],
  ]);
  const { totals } = dailyTotals(receipts, STORES, DATES);
  assert.equal(lines.reduce((n, l) => n + l.amount, 0), totals[0].bank);
});

test('Nana: QR goes to bank (no fee) from 13 Nov; cards stay neighbour credit; earlier days unchanged', () => {
  const scan = (n) => ({ type: 'OTHER', name: 'SCAN', money_amount: n });
  const acct = { Nana: 'Nana Card (Neighbour)' };
  const on = (iso) => ({ created_at: iso, receipt_date: iso });
  const receipts = [
    receipt('s2', [card(700)], { ...on('2026-11-13T09:00:00.000Z'), receipt_number: '3-1' }),
    receipt('s2', [scan(400)], { ...on('2026-11-13T10:00:00.000Z'), receipt_number: '3-2' }),
    receipt('s2', [cash(100), scan(200)], { ...on('2026-11-13T11:00:00.000Z'), receipt_number: '3-3' }),
    receipt('s2', [scan(500)], { ...on('2026-11-12T10:00:00.000Z'), receipt_number: '3-0' }),
  ];
  const dates = new Set(['2026-11-12', '2026-11-13']);
  const { totals } = dailyTotals(receipts, STORES, dates, acct);
  const day = (d) => totals.find((t) => t.date === d);
  assert.deepEqual([day('2026-11-13').cash, day('2026-11-13').bank, day('2026-11-13').credit, day('2026-11-13').card], [100, 600, 700, 0]);
  assert.deepEqual([day('2026-11-12').bank, day('2026-11-12').credit], [0, 500]);
  // the bank report lists only Nana's QR receipts, from 13 Nov, adding up to its Bank In
  const lines = cardReceipts(receipts, STORES, dates);
  assert.deepEqual(lines.map((l) => [l.number, l.amount, l.qr]), [['3-2', 400, 400], ['3-3', 200, 200]]);
});
