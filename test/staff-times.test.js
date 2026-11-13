const test = require('node:test');
const assert = require('node:assert');
const { staffDays } = require('../api/_loyverse');

const STORES = new Map([['s1', 'Bicasso 1'], ['s3', 'Nana']]);
const DATES = new Set(['2026-11-12']);
const EMP = [{ id: 'e1', name: 'Aye' }, { id: 'e2', name: 'Sub Kumar' }];
// Thai time is UTC+7
const th = (local) => new Date(local + '+07:00').toISOString();

test('till open/close with who, late and early against shop hours', () => {
  const shifts = [
    { store_id: 's1', opened_at: th('2026-11-12T10:24:00'), closed_at: th('2026-11-12T21:35:00'), opened_by_employee: 'e1', closed_by_employee: 'e1' },
    { store_id: 's3', opened_at: th('2026-11-12T13:05:00'), closed_at: th('2026-11-12T23:20:00'), opened_by_employee: 'e2', closed_by_employee: 'e2' },
  ];
  const days = staffDays(shifts, [], EMP, STORES, DATES);
  assert.strictEqual(days.length, 2);
  const b1 = days.find((d) => d.shop === 'Bicasso 1').tills[0];
  assert.deepStrictEqual([b1.opened, b1.openedBy, b1.closed, b1.closedBy, b1.late, b1.early, b1.hours], ['10:24', 'Aye', '21:35', 'Aye', 24, 0, 11.2]);
  const nana = days.find((d) => d.shop === 'Nana').tills[0];
  assert.strictEqual(nana.late, 0);    // 5 min after 13:00 is within grace
  assert.strictEqual(nana.early, 40);  // 23:20 vs midnight
});

test('after midnight belongs to the evening before', () => {
  const shifts = [{ store_id: 's3', opened_at: th('2026-11-12T13:00:00'), closed_at: th('2026-11-13T00:20:00'), opened_by_employee: 'e2' }];
  const receipts = [{ store_id: 's3', employee_id: 'e2', receipt_date: th('2026-11-13T00:10:00') }, { store_id: 's3', employee_id: 'e2', receipt_date: th('2026-11-12T14:00:00') }];
  const [d] = staffDays(shifts, receipts, EMP, STORES, DATES);
  assert.strictEqual(d.tills[0].closed, '00:20 +1');
  assert.strictEqual(d.tills[0].early, 0);
  assert.deepStrictEqual(d.staff, [{ name: 'Sub Kumar', firstSale: '14:00', lastSale: '00:10 +1', receipts: 2 }]);
});

test('till left open for days, unknown staff, cancelled receipts, other dates', () => {
  const shifts = [{ store_id: 's1', opened_at: th('2026-11-12T10:00:00'), closed_at: th('2026-11-14T21:00:00'), opened_by_employee: 'gone' }];
  const receipts = [
    { store_id: 's1', receipt_date: th('2026-11-12T11:00:00') },
    { store_id: 's1', employee_id: 'e1', receipt_date: th('2026-11-12T12:00:00'), cancelled_at: 'x' },
    { store_id: 's1', employee_id: 'e1', receipt_date: th('2026-11-11T12:00:00') },
  ];
  const [d] = staffDays(shifts, receipts, EMP, STORES, DATES);
  assert.strictEqual(d.tills[0].openedBy, 'Unknown staff');
  assert.strictEqual(d.tills[0].closed, '21:00 on 14/11');
  assert.strictEqual(d.tills[0].openDays, 2);
  assert.deepStrictEqual(d.staff.map((p) => [p.name, p.receipts]), [['Not recorded', 1]]);
});

test('still-open till', () => {
  const [d] = staffDays([{ store_id: 's1', opened_at: th('2026-11-12T09:58:00') }], [], EMP, STORES, DATES);
  assert.deepStrictEqual([d.tills[0].closed, d.tills[0].hours, d.tills[0].late], ['', null, 0]);
});
