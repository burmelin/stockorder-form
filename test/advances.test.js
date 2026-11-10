// Salary advances: who an advance belongs to, what they owe, and the pay after a deduction.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nameInNote, staffNamesFromRows, advancesFor, salariesFromRows, deductionsFromRows } = require('../api/_advances');
const { planMovements } = require('../api/_loyverse');

const NAMES = ['Kumar Giri', 'Sunil GTM', 'Pyone Cho', 'Bharati'];
const adv = (row, date, notes, cashOut, a = {}) => ({ row, date, shop: a.shop || 'Bicasso 1', category: a.category || 'Salary', cashOut, bankOut: a.bankOut || 0, notes });

test('advances: the note names the person by full or first name', () => {
  assert.equal(nameInNote('Kumar Advance · 14:10', NAMES), 'Kumar Giri');
  assert.equal(nameInNote('advance sunil', NAMES), 'Sunil GTM');
  assert.equal(nameInNote('Pyone Cho advance', NAMES), 'Pyone Cho');
  assert.equal(nameInNote('advance', NAMES), '');
  // two people called Kumar: the first name alone is not enough
  assert.equal(nameInNote('Kumar advance', ['Kumar Giri', 'Kumar Rai']), '');
  assert.equal(nameInNote('Kumar Rai advance', ['Kumar Giri', 'Kumar Rai']), 'Kumar Rai');
});

test('advances: owed carries over, the deduction is what the owner typed', () => {
  const rows = [
    adv(10, '2026-10-05', 'Kumar Advance · 12:00', 3000),
    adv(11, '2026-10-20', 'Kumar advance', 0, { shop: 'Palladium', bankOut: 2000 }),
    adv(12, '2026-11-03', 'Kumar Advance · 18:30', 1000),
    adv(13, '2026-11-04', 'Salary Kumar', 9000),                       // a salary, not an advance
    adv(14, '2026-11-06', 'advance', 500, { shop: 'Nana' }),           // nobody named
    adv(15, '2026-12-01', 'Kumar advance', 700),                       // after the month
    adv(16, '2026-11-07', 'Sunil advance', 400, { category: 'Other Expense' }),
  ];
  const salaries = salariesFromRows([['Kumar Giri', '15,000'], ['Sunil GTM', 12000]]);
  const deductions = deductionsFromRows([['2026-10', 'Kumar Giri', 4000], ['2026-11', 'Kumar Giri', 1500], ['bad', 'x', 1]]);

  const nov = advancesFor(rows, NAMES, salaries, deductions, '2026-11');
  const k = nov.staff.find((s) => s.name === 'Kumar Giri');
  // 3000 + 2000 + 1000 taken, 4000 taken off in October
  assert.deepEqual([k.salary, k.taken, k.owes, k.deduct, k.pay, k.owesAfter], [15000, 1000, 2000, 1500, 13500, 500]);
  assert.deepEqual(k.items.map((i) => i.row), [12]);
  assert.deepEqual(nov.unmatched.map((u) => u.row), [14]);
  const s = nov.staff.find((x) => x.name === 'Sunil GTM');
  assert.deepEqual([s.salary, s.owes, s.pay], [12000, 0, 12000]);

  const oct = advancesFor(rows, NAMES, salaries, deductions, '2026-10');
  const ko = oct.staff.find((x) => x.name === 'Kumar Giri');
  assert.deepEqual([ko.taken, ko.owes, ko.deduct, ko.pay], [5000, 5000, 4000, 11000]);
});

test('advances: a deduction never takes more than is owed', () => {
  const r = advancesFor([adv(1, '2026-11-02', 'Bharati advance', 800)], NAMES, { Bharati: 9000 }, [{ month: '2026-11', name: 'Bharati', amount: 5000 }], '2026-11');
  const b = r.staff.find((x) => x.name === 'Bharati');
  assert.deepEqual([b.deduct, b.pay, b.owesAfter], [800, 8200, 0]);
});

test('advances: a Loyverse pay-out noted "Kumar Advance" is booked as Salary', () => {
  const AT = '2026-11-09T07:00:00Z';
  const shifts = [{ store_id: 's1', opened_at: AT, cash_movements: [{ type: 'PAY_OUT', money_amount: 2000, comment: 'Kumar Advance', created_at: AT }] }];
  const [a] = planMovements(shifts, new Map([['s1', 'Bicasso 1']]), new Set(['2026-11-09']), {}, new Map(), []).actions;
  assert.equal(a.category, 'Salary');
  assert.equal(a.cashOut, 2000);
  assert.match(a.note, /^Kumar Advance · /);
});

test('advances: every staff member is listed, Palladium too', () => {
  const rows = [['ID', 'Name', 'Works at'], ['E1', 'Kumar  Giri', 'Bicasso 1'], ['E2', 'Aung', 'Palladium'], ['E3', '', 'Nana'], ['E4', 'Kumar Giri', 'Bicasso 2']];
  assert.deepEqual(staffNamesFromRows(rows), ['Kumar Giri', 'Aung']);
  assert.deepEqual(staffNamesFromRows([['ID']]), []);
});

test('payroll: people are marked paid one at a time, others kept', () => {
  const { upsertPayroll, payrollFromRows, PAYROLL_HEADERS } = require('../api/_advances');
  const old = [PAYROLL_HEADERS, ['2026-11', 'Kumar Giri', 15000, 0, 2000, 17000, '2026-11-30'], ['2026-11', 'Aung', 9000, 0, 0, 9000, '2026-11-29'], ['2026-10', 'Kumar Giri', 15000, 4000, 1800, 12800, '2026-10-31']];
  const next = upsertPayroll(old, '2026-11', [{ name: 'Kumar Giri', salary: 15000, deduct: 1500, commission: 2100 }], '2026-12-01');
  assert.deepEqual(next[0], PAYROLL_HEADERS);
  assert.deepEqual(next.slice(1).map((r) => [r[0], r[1], r[5], r[6]]),
    [['2026-10', 'Kumar Giri', 12800, '2026-10-31'], ['2026-11', 'Aung', 9000, '2026-11-29'], ['2026-11', 'Kumar Giri', 15600, '2026-12-01']]);
  const nov = payrollFromRows(next.slice(1), '2026-11');
  assert.deepEqual(nov.find((p) => p.name === 'Kumar Giri'), { name: 'Kumar Giri', salary: 15000, deduct: 1500, commission: 2100, pay: 15600, paidAt: '2026-12-01' });
});
