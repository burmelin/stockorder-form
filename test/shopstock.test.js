// Shop stock from Loyverse (api/_shopstock.js): how Loyverse items become Palladium's
// product / colour / size, the stock grid, and the 7-day sales list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVariant, variantIndex, buildStock, salesLines, salesMoney, storeIds, tillShops } = require('../api/_shopstock');

const sizedItem = {
  id: 'i1', item_name: '4002 Cotton Shirt', option1_name: 'Colour', option2_name: 'Size',
  variants: [
    { variant_id: 'v1', sku: '4002-1-M', option1_value: '1', option2_value: 'M' },
    { variant_id: 'v2', sku: '4002-1-L', option1_value: '1', option2_value: 'L' },
  ],
};
const splitItem = {   // one item per colour; the SKU runs colour and size together
  id: 'i2', item_name: 'FL1167-12 Linen Pant', option1_name: 'Size',
  variants: [{ variant_id: 'v3', sku: 'FL1167129', option1_value: '9' }, { variant_id: 'v4', sku: 'FL11671230', option1_value: '30' }],
};
const hashColour = { id: 'i3', item_name: 'F1165-3# Pant', option1_name: 'SIZE', variants: [{ variant_id: 'v5', option1_value: '32' }] };
const oldCode = { id: 'i4', item_name: 'S152 Polo', option1_name: 'Colour', option2_name: 'Size', variants: [{ variant_id: 'v6', option1_value: '30', option2_value: '58' }] };
const totalOnly = { id: 'i5', item_name: 'T2051 Short Pant', variants: [{ variant_id: 'v7', sku: 'T2051' }] };
const nanaOld = { id: 'i6', item_name: 'B01 Polo (Nana old stock)', variants: [{ variant_id: 'v8', sku: 'B01' }] };
const custom = { id: 'i7', item_name: 'Custom made T9027', option1_name: 'SIZE', option2_name: 'Color', variants: [{ variant_id: 'v9', option1_value: '52', option2_value: 'Bage' }] };
const deleted = { id: 'i8', item_name: 'B01-2 Polo', option1_name: 'Size', deleted_at: '2026-11-18', variants: [{ variant_id: 'v10', option1_value: '48' }] };
const ITEMS = [sizedItem, splitItem, hashColour, oldCode, totalOnly, nanaOld, custom, deleted];

test('an item with Colour and Size options gives product, colour and size', () => {
  assert.deepEqual(parseVariant(sizedItem, sizedItem.variants[0]), { kind: 'sized', pid: '4002', col: '1', sz: 'M', name: '4002 Cotton Shirt' });
});

test('a split item reads the colour from the NAME, not the run-together SKU', () => {
  const p = parseVariant(splitItem, splitItem.variants[0]);
  assert.deepEqual([p.pid, p.col, p.sz], ['FL1167', '12', '9']);   // SKU FL1167129 alone would be ambiguous
  const h = parseVariant(hashColour, hashColour.variants[0]);
  assert.deepEqual([h.pid, h.col, h.sz], ['F1165', '3#', '32']);
});

test('old product numbers become the number Palladium uses', () => {
  assert.equal(parseVariant(oldCode, oldCode.variants[0]).pid, 'B152');
  assert.equal(parseVariant({ item_name: 'FD9039-4 Shirt', option1_name: 'Size' }, { option1_value: 'L' }).pid, 'T9039');
  assert.equal(parseVariant({ item_name: 'F9027 Pant' }, {}).pid, 'T9027');
});

test('no sizes, Nana old stock and items without a product code are total-only kinds', () => {
  assert.equal(parseVariant(totalOnly, totalOnly.variants[0]).kind, 'total');
  assert.deepEqual(parseVariant(nanaOld, nanaOld.variants[0]), { kind: 'old', pid: 'B01', name: 'B01 Polo (Nana old stock)' });
  // "Custom made T9027" has Size and Color options but is not a Palladium product
  assert.equal(parseVariant(custom, custom.variants[0]).kind, 'other');
});

test('buildStock makes the app grid for sized items and a totals list for the rest', () => {
  const idx = variantIndex(ITEMS);
  assert.equal(idx.has('v10'), false, 'deleted items are left out');
  const levels = [
    { variant_id: 'v1', store_id: 's', in_stock: 2 }, { variant_id: 'v2', store_id: 's', in_stock: 0 },
    { variant_id: 'v3', store_id: 's', in_stock: 5 }, { variant_id: 'v5', store_id: 's', in_stock: -1 },
    { variant_id: 'v6', store_id: 's', in_stock: 4.0 }, { variant_id: 'v7', store_id: 's', in_stock: 109 },
    { variant_id: 'v8', store_id: 's', in_stock: 0 }, { variant_id: 'v9', store_id: 's', in_stock: 35 },
    { variant_id: 'unknown', store_id: 's', in_stock: 7 },
  ];
  const { sized, totals } = buildStock(idx, levels);
  assert.deepEqual(sized['4002'], { 'Color 1': { M: 2, L: 0 } });
  assert.deepEqual(sized.FL1167, { 'Color 12': { 9: 5 } });
  assert.equal(sized.F1165['Color 3#']['32'], -1, 'below zero is shown as it is (a wrong tap in Loyverse)');
  assert.equal(sized.B152['Color 30']['58'], 4);
  assert.deepEqual(totals.map((t) => [t.name, t.qty]), [['Custom made T9027', 35], ['T2051 Short Pant', 109]], 'zero lines are hidden');
});

test('two Loyverse items for the same piece add up', () => {
  const twin = { item_name: 'B152-30 Polo', option1_name: 'Size', variants: [{ variant_id: 'w1', option1_value: '58' }] };
  const { sized } = buildStock(variantIndex([oldCode, twin]), [{ variant_id: 'v6', in_stock: 4 }, { variant_id: 'w1', in_stock: 1 }]);
  assert.equal(sized.B152['Color 30']['58'], 5);
});

test('salesLines: one line per item sold, refunds negative, cancelled skipped, newest first, shop by till', () => {
  const idx = variantIndex(ITEMS);
  const tills = tillShops([{ id: 'd1', name: 'POS 1' }, { id: 'd2', name: 'B2 POS' }]);
  const shopOf = (r) => tills.get(r.pos_device_id) || 'Bicasso 1';
  const receipts = [
    { receipt_number: '1-1001', receipt_type: 'SALE', created_at: '2026-11-17T05:00:00Z', receipt_date: '2026-11-17T05:00:00Z', pos_device_id: 'd1',
      line_items: [{ variant_id: 'v1', item_name: '4002 Cotton Shirt', quantity: 2 }, { variant_id: 'v7', item_name: 'T2051 Short Pant', quantity: 1 }] },
    { receipt_number: '2-1002', receipt_type: 'SALE', receipt_date: '2026-11-18T13:30:00Z', pos_device_id: 'd2',
      line_items: [{ variant_id: 'v3', item_name: 'FL1167-12 Linen Pant', variant_name: '9', quantity: 1 }] },
    { receipt_number: '2-1003', receipt_type: 'REFUND', receipt_date: '2026-11-18T14:00:00Z', pos_device_id: 'd2',
      line_items: [{ variant_id: 'v3', quantity: 1 }] },
    { receipt_number: '1-1004', receipt_type: 'SALE', cancelled_at: '2026-11-18T10:00:00Z', receipt_date: '2026-11-18T09:00:00Z', pos_device_id: 'd1',
      line_items: [{ variant_id: 'v1', quantity: 5 }] },
    { receipt_number: '1-1005', receipt_type: 'SALE', receipt_date: '2026-11-16T04:00:00Z', pos_device_id: 'd1',
      line_items: [{ variant_id: 'gone', item_name: 'B156-9 Sport Polo', variant_name: '48', quantity: 1 }] },
  ];
  const lines = salesLines(receipts, idx, shopOf, 'Asia/Bangkok');
  assert.deepEqual(lines.map((l) => [l.receipt, l.shop, l.pid, l.col, l.sz, l.qty]), [
    ['2-1003', 'Bicasso 2', 'FL1167', '12', '9', -1],
    ['2-1002', 'Bicasso 2', 'FL1167', '12', '9', 1],
    ['1-1001', 'Bicasso 1', '4002', '1', 'M', 2],
    ['1-1001', 'Bicasso 1', 'T2051', '', '', 1],
    ['1-1005', 'Bicasso 1', 'B156', '', '', 1],   // item deleted since: name only, no size
  ]);
  assert.equal(lines[1].day, '2026-11-18');
  assert.equal(lines[1].time, '20:30');            // Bangkok time
  assert.equal(lines[2].day, '2026-11-17');
});

test('storeIds finds the two shop stores by name', () => {
  const ids = storeIds([{ id: 'a', name: 'Burmelin' }, { id: 'b', name: 'BICASSO 2 Terminal 21' }, { id: 'c', name: 'bicasso 3 nana' }]);
  assert.deepEqual(ids, { burmelin: 'a', nana: 'c' });
});

test('salesMoney: takings per day and shop (POS), split cash / card / QR, refunds off, change off the cash', () => {
  const tills = tillShops([{ id: 'd1', name: 'POS 1' }, { id: 'd2', name: 'B2 POS' }]);
  const shopOf = (r) => tills.get(r.pos_device_id) || 'Bicasso 1';
  const at = '2026-11-18T06:00:00Z';
  const receipts = [
    { receipt_type: 'SALE', receipt_date: at, pos_device_id: 'd1', total_money: 1000, payments: [{ type: 'CASH', name: 'Cash', money_amount: 1100 }] },   // 100 change
    { receipt_type: 'SALE', receipt_date: at, pos_device_id: 'd1', total_money: 900, payments: [{ type: 'NONCASH', name: 'Card', money_amount: 600 }, { type: 'OTHER', name: 'SCAN', money_amount: 300 }] },
    { receipt_type: 'SALE', receipt_date: at, pos_device_id: 'd2', total_money: 500, payments: [{ type: 'OTHER', name: 'QR PromptPay', money_amount: 500 }] },
    { receipt_type: 'REFUND', receipt_date: at, pos_device_id: 'd2', total_money: 200, payments: [{ type: 'CASH', name: 'Cash', money_amount: 200 }] },
    { receipt_type: 'SALE', receipt_date: at, pos_device_id: 'd2', cancelled_at: at, total_money: 999, payments: [{ type: 'CASH', money_amount: 999 }] },
    { receipt_type: 'SALE', receipt_date: '2026-11-17T20:00:00Z', pos_device_id: 'd1', total_money: 50, payments: [{ type: 'CASH', money_amount: 50 }] },   // 03:00 on the 18th in Bangkok
  ];
  const got = salesMoney(receipts, shopOf, 'Asia/Bangkok');
  assert.deepEqual(got.map((t) => [t.day, t.shop, t.cash, t.card, t.qr, t.total, t.receipts, t.refunds]), [
    ['2026-11-18', 'Bicasso 1', 1050, 600, 300, 1950, 3, 0],
    ['2026-11-18', 'Bicasso 2', -200, 0, 500, 300, 1, 1],
  ]);
});

test('salesLines gives each line its amount (refunds negative)', () => {
  const idx = variantIndex(ITEMS);
  const lines = salesLines([
    { receipt_type: 'SALE', receipt_date: '2026-11-18T05:00:00Z', line_items: [{ variant_id: 'v1', quantity: 2, total_money: 790 }] },
    { receipt_type: 'REFUND', receipt_date: '2026-11-18T06:00:00Z', line_items: [{ variant_id: 'v1', quantity: 1, total_money: 395 }] },
  ], idx, () => 'Bicasso 1', 'Asia/Bangkok');
  assert.deepEqual(lines.map((l) => [l.qty, l.amount]), [[-1, -395], [2, 790]]);
});
