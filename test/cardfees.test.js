// Bicasso card fees: bank deposits tab, fee per day, the learned usual rate and the flags.
const test = require('node:test');
const assert = require('node:assert/strict');
const { depositsFromRows, upsertDeposit, feeSummary, money } = require('../api/_cardfees');
const { cardReceipts, isQr } = require('../api/_loyverse');

test('QR / PromptPay payment names are told apart from cards', () => {
  for (const n of ['QR PromptPay', 'QR', 'PromptPay', 'Thai QR']) assert.ok(isQr(n), n);
  for (const n of ['Card', 'Visa', 'Credit card', 'Transfer']) assert.ok(!isQr(n), n);
});

test('card receipts carry the QR part separately', () => {
  const AT = '2026-11-10T05:00:00.000Z';
  const r = (payments, extra = {}) => ({ store_id: 's1', created_at: AT, receipt_date: AT, receipt_type: 'SALE', total_money: 0, payments, ...extra });
  const lines = cardReceipts([
    r([{ type: 'CARD', name: 'Card', money_amount: 1000 }]),
    r([{ type: 'OTHER', name: 'QR PromptPay', money_amount: 400 }]),
    r([{ type: 'OTHER', name: 'QR PromptPay', money_amount: 100 }], { receipt_type: 'REFUND' }),
  ], new Map([['s1', 'Bicasso 1']]), new Set(['2026-11-10']));
  assert.deepEqual(lines.map((l) => [l.amount, l.qr]), [[1000, 0], [400, 400], [-100, -100]]);
});

test('deposits tab: read, set, replace and remove a day', () => {
  const H = ['Date', 'Amount', 'Note'];
  assert.deepEqual(depositsFromRows([H, ['2026-11-10', '41,307.88'], ['bad', 5], ['2026-11-09', '']]), { '2026-11-10': { amount: 41307.88, note: '' } });
  let v = upsertDeposit([H], '2026-11-10', 41307.88);
  v = upsertDeposit(v, '2026-11-09', 9074.49);
  assert.deepEqual(v.map((r) => r[0]), ['Date', '2026-11-09', '2026-11-10']);
  v = upsertDeposit(v, '2026-11-10', 41000);
  assert.equal(depositsFromRows(v)['2026-11-10'].amount, 41000);
  v = upsertDeposit(v, '2026-11-09', 0);
  assert.deepEqual(Object.keys(depositsFromRows(v)), ['2026-11-10']);
  assert.equal(money('฿1,234.50'), 1234.5);
  assert.equal(money('-5'), 0);
});

test('fee per day, usual rate, and the days flagged', () => {
  const days = [
    { date: '2026-11-08', card: 10000, qr: 0 },
    { date: '2026-11-09', card: 10000, qr: 2000 },
    { date: '2026-11-10', card: 42530, qr: 0 },
    { date: '2026-11-11', card: 10000, qr: 0 },   // 5% fee: more than any card costs
    { date: '2026-11-14', card: 10000, qr: 0 },   // 3.3%: dear premium cards, not wrong
    { date: '2026-11-12', card: 5000, qr: 0 },    // paid more than sold
    { date: '2026-11-13', card: 7000, qr: 0 },    // nothing entered
  ];
  const deps = {
    '2026-11-08': { amount: 9713 }, '2026-11-09': { amount: 9713 }, '2026-11-10': { amount: 41307.88 },
    '2026-11-11': { amount: 9500 }, '2026-11-12': { amount: 6000 }, '2026-11-14': { amount: 9670 },
  };
  const s = feeSummary(days, deps);
  const by = Object.fromEntries(s.days.map((d) => [d.date, d]));
  assert.equal(by['2026-11-10'].fee, 1222.12);
  assert.equal(by['2026-11-10'].pct.toFixed(2), '2.87');
  assert.equal(s.rate.toFixed(2), '2.87');               // median of 2.87, 2.87, 2.87, 3.3, 5
  assert.equal(by['2026-11-14'].flag, '');
  assert.equal(by['2026-11-10'].flag, '');
  assert.equal(by['2026-11-11'].flag, 'short');
  assert.equal(by['2026-11-12'].flag, 'more');
  assert.equal(by['2026-11-13'].received, null);
  assert.equal(by['2026-11-13'].flag, '');
  // QR counted in when the deposit pays it too
  assert.equal(feeSummary(days, deps, { withQr: true }).days[1].sales, 12000);
  assert.equal(s.totals.days, 6);
  // two days entered: too few to show a usual rate, but an impossible fee is still flagged
  const two = feeSummary(days.slice(2, 4), deps);
  assert.equal(two.rate, null);
  assert.deepEqual(two.days.map((d) => d.flag), ['', 'short']);
});
