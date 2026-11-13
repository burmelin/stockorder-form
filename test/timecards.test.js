const test = require('node:test');
const assert = require('node:assert');
const T = require('../finance/timecards');
const { mergeRows, shopFor } = require('../api/timecards');

test('reads separate date and time columns, AM/PM, quoted names, after-midnight clock-out', () => {
  const csv = '﻿Clock in date,Clock in time,Clock out date,Clock out time,Employee,Store,Total hours\n'
    + '13/11/2026,9:52 AM,13/11/2026,9:34 PM,"Aye, Thida",Bicasso 1,11.70\n'
    + '13/11/2026,12:58 PM,14/11/2026,12:05 AM,Sub Kumar,Nana,11.12\n'
    + 'Total,,,,,,22.82\n';
  const r = T.parseTimecards(csv);
  assert.strictEqual(r.dayFirst, true);
  assert.deepStrictEqual(r.cards, [
    { employee: 'Aye, Thida', store: 'Bicasso 1', inAt: '2026-11-13 09:52', outAt: '2026-11-13 21:34' },
    { employee: 'Sub Kumar', store: 'Nana', inAt: '2026-11-13 12:58', outAt: '2026-11-14 00:05' },
  ]);
  assert.deepStrictEqual([r.from, r.to, r.skipped], ['2026-11-13', '2026-11-13', 1]);
});

test('combined date-time cells, month first, out without date rolls to next day, open timecard', () => {
  const csv = 'Employee;Store;Clock in;Clock out\n'
    + 'Mon;Bicasso 2;11/13/2026 10:25;11/13/2026 21:31\n'
    + 'Sub Kumar;Nana;11/13/2026 13:00;00:20\n'
    + 'Pyone;Bicasso 2;11/14/2026 10:00;\n';
  const r = T.parseTimecards(csv);
  assert.strictEqual(r.dayFirst, false);
  assert.strictEqual(r.cards[1].outAt, '2026-11-14 00:20');
  assert.strictEqual(r.cards[2].outAt, '');
  assert.deepStrictEqual([r.from, r.to], ['2026-11-13', '2026-11-14']);
});

test('month names and Buddhist years', () => {
  const r = T.parseTimecards('Date,Employee,Store,Clock in,Clock out\n"Nov 12, 2026",Aye,Bicasso 1,10:01,21:30\n12 พ.ย.,x,y,,\n');
  assert.strictEqual(r.cards[0].inAt, '2026-11-12 10:01');
  const b = T.parseTimecards('Date,Employee,Clock in,Clock out\n12/11/2569,Aye,10:01,21:30\n');
  assert.strictEqual(b.cards[0].inAt, '2026-11-12 10:01');
});

test('not a timecards file', () => {
  assert.ok(T.parseTimecards('Date,Gross sales\n1/1/2026,100').error);
});

test('report: late, early, totals, after-midnight belongs to the evening', () => {
  const cards = [
    { employee: 'Aye', shop: 'Bicasso 1', inAt: '2026-11-13 10:25', outAt: '2026-11-13 21:00' },
    { employee: 'Sub Kumar', shop: 'Nana', inAt: '2026-11-13 12:58', outAt: '2026-11-14 00:05' },
    { employee: 'Aye', shop: 'Bicasso 1', inAt: '2026-11-14 09:55', outAt: '' },
  ];
  const r = T.build(cards, '2026-11-13', '2026-11-14');
  assert.deepStrictEqual(r.days.map((d) => d.date), ['2026-11-14', '2026-11-13']);
  const d13 = r.days[1].lines;
  assert.deepStrictEqual([d13[0].late, d13[0].early, d13[0].hours], [25, 30, 10.58]);
  assert.deepStrictEqual([d13[1].in, d13[1].out, d13[1].late, d13[1].early], ['12:58', '00:05 +1', 0, 0]);
  const aye = r.totals.find((p) => p.employee === 'Aye');
  assert.deepStrictEqual([aye.days, aye.late, aye.early, aye.open], [2, 1, 1, 1]);
});

test('uploading an overlapping week replaces those days instead of adding twice', () => {
  const week1 = [{ employee: 'Aye', store: 'Bicasso 1', inAt: '2026-11-06 10:00', outAt: '2026-11-06 21:30' },
    { employee: 'Aye', store: 'Bicasso 1', inAt: '2026-11-12 10:00', outAt: '2026-11-12 21:30' }];
  let rows = mergeRows([], '2026-11-06', '2026-11-12', week1, '2026-11-13');
  assert.strictEqual(rows.length, 3);
  const week2 = [{ employee: 'Aye', store: 'Bicasso 1', inAt: '2026-11-12 10:05', outAt: '2026-11-12 21:30' },
    { employee: 'Aye', store: 'Bicasso 1', inAt: '2026-11-13 10:00', outAt: '2026-11-13 21:30' }];
  rows = mergeRows(rows, '2026-11-12', '2026-11-13', week2, '2026-11-14');
  assert.deepStrictEqual(rows.slice(1).map((r) => r[3]), ['2026-11-06 10:00', '2026-11-12 10:05', '2026-11-13 10:00']);
  assert.deepStrictEqual(rows[0], ['Day', 'Employee', 'Shop', 'Clock in', 'Clock out', 'Hours', 'Loyverse store', 'Uploaded']);
  assert.strictEqual(rows[1][5], 11.5);
});

test('store names map to shops', () => {
  assert.strictEqual(shopFor('bicasso 1'), 'Bicasso 1');
  assert.strictEqual(shopFor('Bicasso Nana'), 'Nana');
  assert.strictEqual(shopFor('Somewhere'), 'Somewhere');
});

test('the real Loyverse export layout: combined date-time, Open and Missing', () => {
  const csv = 'Employee,Store,Clock in,Clock out,Total hours\n'
    + 'Staff A,Burmelin,Missing,04/11/2026 21:17,\n'
    + 'Staff B,Burmelin,13/11/2026 10:08,Open,0.82\n'
    + 'Staff C,BICASSO 3 Nana,12/11/2026 13:45,12/11/2026 23:43,9.95\n'
    + 'Staff B,Burmelin,10/11/2026 10:22,Missing,\n'
    + 'Staff B,Burmelin,08/11/2026 9:56,08/11/2026 20:58,11.02\n';
  const r = T.parseTimecards(csv);
  assert.deepStrictEqual([r.cards.length, r.noClockIn, r.from, r.to], [4, 1, '2026-11-08', '2026-11-13']);
  assert.deepStrictEqual(r.cards[0], { employee: 'Staff B', store: 'Burmelin', inAt: '2026-11-13 10:08', outAt: '' });
  assert.strictEqual(r.cards[2].outAt, '');
  assert.strictEqual(r.cards[3].inAt, '2026-11-08 09:56');
  assert.strictEqual(shopFor('BICASSO 2 Terminal 21'), 'Bicasso 2');
  assert.strictEqual(shopFor('BICASSO 3 Nana'), 'Nana');
  assert.strictEqual(shopFor('Burmelin'), 'Bicasso 1');
});

test('leave this month: approved day off, sick (half), waiting requests, other months ignored', () => {
  const { leaveFromRows } = require('../api/timecards');
  const H = ['Request ID', 'Requested', 'Employee ID', 'Name', 'Type', 'Date', 'Reason', 'Status', 'Decided', 'Owner note', 'Half day'];
  const row = (name, type, date, status, half = '') => ['', '', '', name, type, date, '', status, '', '', half];
  const out = leaveFromRows([H,
    row('Aye', 'Day off', '2026-11-04', 'Approved'),
    row('Aye', 'Day off', '2026-11-04', 'Approved'),
    row('Aye', 'Sick leave', '2026-11-09', 'Approved', 'First half'),
    row('Aye', 'Day off', '2026-11-20', 'Pending'),
    row('Aye', 'Day off', '2026-11-21', 'Declined'),
    row('Mon', 'Day off', '2026-10-30', 'Approved'),
  ], '2026-11');
  assert.deepStrictEqual(out, [{ name: 'Aye', dayOff: 1, sick: 0.5, pending: 1, dates: { dayOff: ['4'], sick: ['9½'], pending: ['20 off'] } }]);
});
