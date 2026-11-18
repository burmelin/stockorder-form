// Bicasso 1 and Bicasso 2 share one Loyverse store ("Burmelin") since 18 Nov 2026. The till
// ("POS device") decides the shop: "B2 POS" is Bicasso 2, other tills stay Bicasso 1, and the
// old Bicasso 2 store keeps counting as Bicasso 2.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapStores, mapDevices, shopResolver, dailyTotals, cardReceipts, planMovements, planFees } = require('../api/_loyverse');

const SHOPS = ['Palladium', 'Bicasso 1', 'Bicasso 2', 'Nana'];
const STORES = [{ id: 'burm', name: 'Burmelin' }, { id: 'old2', name: 'BICASSO 2 Terminal 21' }, { id: 'nana', name: 'BICASSO 3 Nana' }];
const DEVICES = [
  { id: 'dev-b1', name: 'POS 1', store_id: 'burm' },
  { id: 'dev-b2', name: 'B2 POS', store_id: 'burm' },
  { id: 'dev-old2', name: 'POS 1', store_id: 'old2' },
  { id: 'dev-nana', name: 'Nana POS', store_id: 'nana' },
];
const DAY = '2026-11-18';
const DATES = new Set([DAY]);
const AT = '2026-11-18T08:00:00.000Z'; // 15:00 Bangkok
const receipt = (store, device, payments, extra = {}) => ({
  store_id: store, pos_device_id: device, created_at: AT, receipt_date: AT, receipt_type: 'SALE',
  total_money: payments.reduce((n, p) => n + p.money_amount, 0), payments, ...extra,
});
const cash = (n) => ({ type: 'CASH', name: 'Cash', money_amount: n });
const card = (n) => ({ type: 'CARD', name: 'Card', money_amount: n });
const qr = (n) => ({ type: 'OTHER', name: 'SCAN', money_amount: n });

function resolver() {
  process.env.LOYVERSE_STORE_MAP = JSON.stringify({ Burmelin: 'Bicasso 1', 'BICASSO 2 Terminal 21': 'Bicasso 2', 'BICASSO 3 Nana': 'Nana' });
  const stores = mapStores(STORES, SHOPS);
  const devices = mapDevices(DEVICES, SHOPS);
  delete process.env.LOYVERSE_STORE_MAP;
  return { shopOf: shopResolver(stores.map, devices.map), missing: devices.missing };
}

test('"B2 POS" in the Burmelin store is Bicasso 2; the other till there is Bicasso 1', () => {
  const { shopOf, missing } = resolver();
  assert.deepEqual(missing, []);
  assert.equal(shopOf({ store_id: 'burm', pos_device_id: 'dev-b2' }), 'Bicasso 2');
  assert.equal(shopOf({ store_id: 'burm', pos_device_id: 'dev-b1' }), 'Bicasso 1');
  assert.equal(shopOf({ store_id: 'old2', pos_device_id: 'dev-old2' }), 'Bicasso 2'); // old store, past days
  assert.equal(shopOf({ store_id: 'nana', pos_device_id: 'dev-nana' }), 'Nana');
  assert.equal(shopOf({ store_id: 'burm' }), 'Bicasso 1'); // no till on the record
});

test('sales split by till: cash, card and QR land in the right shop', () => {
  const { shopOf } = resolver();
  const { totals } = dailyTotals([
    receipt('burm', 'dev-b1', [cash(1000)]),
    receipt('burm', 'dev-b1', [card(2000)]),
    receipt('burm', 'dev-b2', [cash(300)]),
    receipt('burm', 'dev-b2', [card(700), qr(100)]),
    receipt('old2', 'dev-old2', [cash(50)]), // the old B2 store, if a till there still sells
  ], shopOf, DATES);
  const by = Object.fromEntries(totals.map((t) => [t.shop, { cash: t.cash, bank: t.bank, card: t.card, receipts: t.receipts }]));
  assert.deepEqual(by['Bicasso 1'], { cash: 1000, bank: 2000, card: 2000, receipts: 2 });
  assert.deepEqual(by['Bicasso 2'], { cash: 350, bank: 800, card: 700, receipts: 3 });
});

test('card fees follow the till: each shop pays on its own card sales', () => {
  const { shopOf } = resolver();
  const { totals } = dailyTotals([receipt('burm', 'dev-b1', [card(1000)]), receipt('burm', 'dev-b2', [card(2000), qr(500)])], shopOf, DATES);
  const fees = planFees(totals, [], 2.89);
  assert.deepEqual(fees.map((f) => [f.shop, f.bankOut]).sort(), [['Bicasso 1', 28.9], ['Bicasso 2', 57.8]]);
});

test('pay-ins and pay-outs follow the till that opened the shift', () => {
  const { shopOf } = resolver();
  const shifts = [
    { store_id: 'burm', pos_device_id: 'dev-b1', opened_at: AT, cash_movements: [{ type: 'PAY_OUT', money_amount: 200, comment: 'Water', created_at: AT }] },
    { store_id: 'burm', pos_device_id: 'dev-b2', opened_at: AT, cash_movements: [
      { type: 'PAY_OUT', money_amount: 5000, comment: 'Collection Sonu', created_at: AT },
      { type: 'PAY_OUT', money_amount: 1000, comment: 'Kumar Advance', created_at: AT },
    ] },
  ];
  const { actions } = planMovements(shifts, shopOf, DATES, {}, new Map(), []);
  assert.deepEqual(actions.map((a) => [a.shop, a.category, a.cashOut]), [
    ['Bicasso 1', 'Other Expense', 200],
    ['Bicasso 2', 'Collection (to Palladium)', 5000],
    ['Bicasso 2', 'Salary', 1000],
  ]);
});

test('the card sales list names the right shop per receipt', () => {
  const { shopOf } = resolver();
  const lines = cardReceipts([receipt('burm', 'dev-b1', [card(400)]), receipt('burm', 'dev-b2', [card(600)])], shopOf, DATES);
  assert.deepEqual(lines.map((l) => [l.shop, l.amount]), [['Bicasso 1', 400], ['Bicasso 2', 600]]);
});

test('a missing "B2 POS" till is reported, and its sales stay with the store', () => {
  const { map, missing } = mapDevices(DEVICES.filter((d) => d.name !== 'B2 POS'), SHOPS);
  assert.deepEqual(missing, ['b2 pos']);
  assert.equal(map.size, 0);
});

test('LOYVERSE_DEVICE_MAP can name a till by id instead (survives a rename)', () => {
  process.env.LOYVERSE_DEVICE_MAP = JSON.stringify({ 'dev-b2': 'Bicasso 2' });
  const { map, missing } = mapDevices([{ id: 'dev-b2', name: 'Renamed till', store_id: 'burm' }], SHOPS);
  delete process.env.LOYVERSE_DEVICE_MAP;
  assert.equal(map.get('dev-b2'), 'Bicasso 2');
  assert.deepEqual(missing, []);
});
