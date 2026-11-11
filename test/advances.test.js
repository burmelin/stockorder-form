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

  const nov = advancesFor(rows, NAMES, salaries, deductions, '2026-11', '');
  const k = nov.staff.find((s) => s.name === 'Kumar Giri');
  // 3000 + 2000 + 1000 taken, 4000 taken off in October
  assert.deepEqual([k.salary, k.taken, k.owes, k.deduct, k.pay, k.owesAfter], [15000, 1000, 2000, 1500, 13500, 500]);
  // every advance behind the total is listed, this month's marked
  assert.deepEqual(k.items.map((i) => [i.row, i.thisMonth]), [[10, false], [11, false], [12, true]]);
  assert.equal(k.earlierCuts, 4000);
  assert.deepEqual(nov.unmatched.map((u) => u.row), [14]);
  const s = nov.staff.find((x) => x.name === 'Sunil GTM');
  assert.deepEqual([s.salary, s.owes, s.pay], [12000, 0, 12000]);

  const oct = advancesFor(rows, NAMES, salaries, deductions, '2026-10', '');
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

test('advances: only advances from the start day count', () => {
  const rows = [adv(1, '2026-07-20', 'Kumar Salary Advanced', 2000), adv(2, '2026-11-10', 'Kumar advance', 5000)];
  const all = advancesFor(rows, NAMES, {}, [], '2026-11', '').staff.find((x) => x.name === 'Kumar Giri');
  const fromNov = advancesFor(rows, NAMES, {}, [], '2026-11', '2026-11-01').staff.find((x) => x.name === 'Kumar Giri');
  assert.equal(all.owes, 7000);
  assert.deepEqual([fromNov.owes, fromNov.items.length], [5000, 1]);
});

test('advances: a name that could be two people waits for the owner to pick', () => {
  const names = ['Kumar Giri', 'Sub Kumar', 'Sunil', 'Sunil GTM'];
  assert.equal(nameInNote('Kumar advance', names), '');
  assert.equal(nameInNote('Sib Kumar November Advance', names), '');
  assert.equal(nameInNote('Sub Kumar advance', names), 'Sub Kumar');
  assert.equal(nameInNote('Kumar Giri advance', names), 'Kumar Giri');
  assert.equal(nameInNote('Sunil advance', names), '');
  assert.equal(nameInNote('Sunil GTM advance', names), 'Sunil GTM');
  const { advanceKey, ownersFromRows, openingsFromRows } = require('../api/_advances');
  const rows = [adv(640, '2026-11-07', 'Sib Kumar November Advance · 21:14', 2000, { shop: 'Nana' }), adv(660, '2026-11-10', 'Kumar advance · 21:01', 5000, { shop: 'Bicasso 2' })];
  const before = advancesFor(rows, names, {}, [], '2026-11');
  assert.deepEqual(before.unmatched.map((u) => u.row), [640, 660]);
  const owners = ownersFromRows([[advanceKey(rows[0]), 'Sub Kumar'], [advanceKey(rows[1]), 'Kumar Giri']]);
  const openings = openingsFromRows([['2026-10-15', 'Kumar Giri', '1,000', 'October advance'], ['', '', 5]]);
  const after = advancesFor(rows, names, {}, [], '2026-11', '2026-11-01', { owners, openings });
  assert.equal(after.unmatched.length, 0);
  assert.equal(after.staff.find((p) => p.name === 'Sub Kumar').owes, 2000);
  const k = after.staff.find((p) => p.name === 'Kumar Giri');
  assert.equal(k.owes, 6000);
  assert.ok(k.items.some((i) => i.earlier && i.amount === 1000));
});
