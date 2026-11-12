// Bicasso card fees: bank deposits tab, fee per day, the learned usual rate and the flags.
const test = require('node:test');
const assert = require('node:assert/strict');
const { depositsFromRows, upsertDeposit, feeSummary, learnedRate, money, DEFAULT_RATE } = require('../api/_cardfees');
const { cardReceipts, isQr } = require('../api/_loyverse');

test('QR / PromptPay payment names are told apart from cards', () => {
  for (const n of ['QR PromptPay', 'QR', 'PromptPay', 'Thai QR', 'SCAN', 'Scan']) assert.ok(isQr(n), n);
  for (const n of ['Card', 'Visa', 'Credit card', 'Transfer', 'Scan card']) assert.ok(!isQr(n), n);
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
  const H = ['Date', 'Amount', 'Note', 'Card sales'];
  assert.deepEqual(depositsFromRows([H, ['2026-11-10', '41,307.88', '', '42530'], ['bad', 5], ['2026-11-09', '']]), { '2026-11-10': { amount: 41307.88, note: '', cardSales: 42530 } });
  let v = upsertDeposit([H], '2026-11-10', 41307.88, '', 42530);
  assert.deepEqual(v[1], ['2026-11-10', 41307.88, '', 42530]);
  v = upsertDeposit(v, '2026-11-09', 9074.49);
  assert.deepEqual(v.map((r) => r[0]), ['Date', '2026-11-09', '2026-11-10']);
  v = upsertDeposit(v, '2026-11-10', 41000);
  assert.equal(depositsFromRows(v)['2026-11-10'].amount, 41000);
  v = upsertDeposit(v, '2026-11-09', 0);
  assert.deepEqual(Object.keys(depositsFromRows(v)), ['2026-11-10']);
  assert.equal(money('฿1,234.50'), 1234.5);
  assert.equal(money('-5'), 0);
});

test('learned rate: median of checked days, else the 10 Nov rate', () => {
  assert.deepEqual(learnedRate({}), { rate: DEFAULT_RATE, days: 0 });
  // a deposit saved without card sales, or bigger than the sales, can't teach a rate
  assert.equal(learnedRate({ a: { amount: 100, cardSales: 0 }, b: { amount: 200, cardSales: 100 } }).days, 0);
  const r = learnedRate({
    '2026-11-10': { amount: 41307.88, cardSales: 42530 },   // 2.87%
    '2026-11-11': { amount: 9750, cardSales: 10000 },       // 2.5%
    '2026-11-12': { amount: 9700, cardSales: 10000 },       // 3%
  });
  assert.equal(r.days, 3);
  assert.equal(r.rate.toFixed(2), '2.87');
});

test('every day gets an estimated bank in; checked days are compared and flagged', () => {
  const days = [
    { date: '2026-11-10', card: 42530, qr: 500 },
    { date: '2026-11-11', card: 10000, qr: 0 },   // 5% fee: more than any card costs
    { date: '2026-11-12', card: 5000, qr: 0 },    // paid more than sold
    { date: '2026-11-13', card: 10000, qr: 0 },   // 3.3%: dear premium cards, not wrong
    { date: '2026-11-14', card: 7000, qr: 0 },    // not checked: estimate only
  ];
  const deps = {
    '2026-11-10': { amount: 41307.88 }, '2026-11-11': { amount: 9500 },
    '2026-11-12': { amount: 6000 }, '2026-11-13': { amount: 9670 },
  };
  const s = feeSummary(days, deps, { rate: 2.87 });
  const by = Object.fromEntries(s.days.map((d) => [d.date, d]));
  assert.equal(by['2026-11-10'].fee, 1222.12);
  assert.equal(by['2026-11-10'].pct.toFixed(2), '2.87');
  assert.equal(by['2026-11-14'].expected, 6799.1);
  assert.equal(by['2026-11-14'].received, null);
  assert.deepEqual(s.days.map((d) => d.flag), ['', 'short', 'more', '', '']);
  assert.equal(s.totals.sales, 74530);
  assert.equal(s.totals.expected, round2(74530 * (1 - 0.0287)));
  assert.equal(s.totals.checked.days, 4);
  assert.equal(s.totals.checked.received, 66477.88);
  // QR counted in when the deposit pays it too
  assert.equal(feeSummary(days, deps, { withQr: true }).days[0].sales, 43030);
});

function round2(n) { return Math.round(n * 100) / 100; }
