// Leave requests in apps-script/Code.gs, run against a fake sheet: half days, days in a row,
// and old rows without the "Half day" column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

// A grid of cells, 1-based like Apps Script
function fakeSheet(name, rows, maxCols = 26) {
  const grid = rows.map((r) => r.slice());
  const sh = {
    name,
    getLastRow: () => grid.length,
    getMaxColumns: () => maxCols,
    insertColumnsAfter: (_, n) => { maxCols += n; },
    setFrozenRows() {},
    getDataRange: () => sh.getRange(1, 1, grid.length, maxCols),
    getRange(row, col, nr = 1, nc = 1) {
      if (col + nc - 1 > maxCols) throw new Error('range past the last column');
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((grid[row - 1 + i] || [])[col - 1 + j] ?? ''))),
        getValue: () => range.getValues()[0][0],
        setValues(v) { v.forEach((r, i) => r.forEach((x, j) => { (grid[row - 1 + i] = grid[row - 1 + i] || [])[col - 1 + j] = x; })); return range; },
        setValue(x) { return range.setValues([[x]]); },
        clearContent() { return range.setValue(''); },
        setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range, setFontColor: () => range,
      };
      return range;
    },
    grid,
  };
  return sh;
}

const HEAD10 = ['Request ID', 'Requested', 'Employee ID', 'Name', 'Type', 'Date', 'Reason', 'Status', 'Decided', 'Owner note'];
const STAFF = [['ID', 'Name', 'Works at', 'Day off rule', 'Days off per month', 'Fixed day off'],
  ['E1', 'Sunil', 'Bicasso 1, Bicasso 2', 'flexible', '2', ''],
  ['E2', 'Kumar', 'Bicasso 1, Bicasso 2', 'flexible', '2', ''],
  ['E3', 'Pyone', 'Bicasso 1, Bicasso 2', 'flexible', '2', '']];

function load(leaveRows, maxCols) {
  const sheets = { Staff: fakeSheet('Staff', STAFF), Leave: fakeSheet('Leave', leaveRows, maxCols) };
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet(n, [])) };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, '').slice(2), getUuid: () => 'abcd-1234' },
    GmailApp: { sendEmail() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const staff = ctx.readStaffRows(ss);
  ctx.todayKey = () => '2026-11-10';
  ctx.leaveWho = () => ({ staff: staff[0], t: Date.now() });   // signed in as Sunil
  return { ctx, sheets };
}

test('half day: saved as one row marked Morning, counts 0.5 of the allowance', () => {
  const { ctx, sheets } = load([HEAD10]);
  const r = ctx.leaveRequest({}, 'dayoff', ['2026-11-20'], '', 'morning');
  assert.equal(r.success, true, r.error);
  const rows = sheets.Leave.grid;
  assert.equal(rows[0][10], 'Half day');                   // column added to an older sheet
  assert.equal(rows[1][5], '2026-11-20');
  assert.equal(rows[1][10], 'First half');
  assert.equal(r.daysOffUsed['2026-11'], 0.5);
  assert.equal(r.requests[0].half, 'morning');
  assert.equal(r.requests[0].days, 0.5);
});

test('two half days and a full day fit a 2-day allowance; a fourth half day does not', () => {
  const { ctx } = load([HEAD10]);
  assert.equal(ctx.leaveRequest({}, 'dayoff', ['2026-11-20'], '', 'morning').success, true);
  assert.equal(ctx.leaveRequest({}, 'dayoff', ['2026-11-22'], '', 'afternoon').success, true);
  assert.equal(ctx.leaveRequest({}, 'dayoff', ['2026-11-24'], '', '').success, true);
  const r = ctx.leaveRequest({}, 'dayoff', ['2026-11-26'], '', 'morning');
  assert.equal(r.success, false);
  assert.match(r.error, /already have 2 in November/);
});

test('days in a row: one request, one row per day, owner sees them grouped', () => {
  const { ctx, sheets } = load([HEAD10]);
  const r = ctx.leaveRequest({}, 'dayoff', ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'], 'family trip', '');
  assert.equal(r.success, false);                          // 3 days in November is over the 2 allowed
  assert.match(r.error, /November/);
  const ok = ctx.leaveRequest({}, 'dayoff', ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'], 'family trip', '');
  assert.equal(ok.success, true, ok.error);
  assert.equal(sheets.Leave.grid.length, 5);
  assert.deepEqual([...ok.requests[0].dates], ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.equal(ok.requests[0].days, 4);
  assert.deepEqual({ ...ok.daysOffUsed }, { '2026-11': 2, '2026-12': 2 });
});

test('a half day is one date only, and must be morning or afternoon', () => {
  const { ctx } = load([HEAD10]);
  assert.match(ctx.leaveRequest({}, 'sick', ['2026-11-10', '2026-11-11'], '', 'morning').error, /one date only/);
  assert.match(ctx.leaveRequest({}, 'sick', ['2026-11-10'], '', 'evening').error, /first or second half/);
});

test('a half day off can be today; a full day off still needs 3 days notice; the time is sent', () => {
  const { ctx } = load([HEAD10]);
  const r = ctx.leaveRequest({}, 'dayoff', ['2026-11-10'], '', 'afternoon');
  assert.equal(r.success, true, r.error);
  assert.equal(r.halfTimes.afternoon, '3:45 PM – 9:30 PM');
  assert.match(ctx.leaveRequest({}, 'dayoff', ['2026-11-11'], '', '').error, /3 days ahead/);
  assert.match(ctx.leaveRequest({}, 'dayoff', ['2026-11-09'], '', 'morning').error, /today at the earliest/);
});

test('a day off over 14 days in a row is refused', () => {
  const { ctx } = load([HEAD10]);
  const dates = Array.from({ length: 15 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  assert.match(ctx.leaveRequest({}, 'dayoff', dates, '', '').error, /up to 14 days/);
});

test('older rows without the Half day column still read as full days, even on a 10-column sheet', () => {
  const { ctx } = load([HEAD10, ['L1', '', 'E1', 'Sunil', 'Day off', '2026-11-15', '', 'Approved', '', '']], 10);
  const rows = ctx.readLeave(ctx.SpreadsheetApp.getActiveSpreadsheet());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].half, '');
  assert.equal(ctx.leaveAmount(rows[0]), 1);
  // A new request widens the sheet and works
  const r = ctx.leaveRequest({}, 'dayoff', ['2026-11-20'], '', 'afternoon');
  assert.equal(r.success, true, r.error);
  assert.equal(r.daysOffUsed['2026-11'], 1.5);
});

test('half-day hours come from each person\'s own shop, split at the middle', () => {
  const { ctx } = load([HEAD10]);
  const b = ctx.halfTimesFor({ places: ['Bicasso 1', 'Bicasso 2'] });
  assert.equal(b.morning, '10:00 AM – 3:45 PM');
  assert.equal(b.afternoon, '3:45 PM – 9:30 PM');
  const n = ctx.halfTimesFor({ places: ['Bicasso Nana'] });
  assert.equal(n.morning, '1:00 PM – 6:30 PM');
  assert.equal(n.afternoon, '6:30 PM – 12:00 AM');
  const r = ctx.leaveRequest({}, 'sick', ['2026-11-10'], '', 'morning');   // Sunil works at Bicasso 1
  assert.equal(r.requests[0].time, '10:00 AM – 3:45 PM');
  assert.equal(ctx.halfTimesFor({ places: ['Palladium'] }).morning, '');
});

// Owner writes leave for an employee without their PIN
function ownerCtx(leaveRows) {
  const env = load(leaveRows || [HEAD10]);
  env.ctx.isOwner = () => true;
  return env;
}

test('owner leave: saved approved with "Entered by owner", no notice needed', () => {
  const { ctx, sheets } = ownerCtx();
  const r = ctx.ownerAddLeave({}, 'E2', 'dayoff', ['2026-11-11', '2026-11-12'], 'family', '');
  assert.equal(r.success, true, r.error);
  const rows = sheets.Leave.grid.slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][2], 'E2');
  assert.equal(rows[0][7], 'Approved');
  assert.equal(rows[0][9], 'Entered by owner');
  assert.equal(r.addedDays, 2);
});

test('owner leave: half day, past day allowed within a month, too old refused', () => {
  const { ctx, sheets } = ownerCtx();
  assert.equal(ctx.ownerAddLeave({}, 'E1', 'sick', ['2026-11-08'], '', 'afternoon').success, true);
  assert.equal(sheets.Leave.grid[1][10], 'Second half');
  assert.equal(ctx.ownerAddLeave({}, 'E1', 'sick', ['2026-09-01'], '', '').success, false);
});

test('owner leave: same day twice refused; over allowance saved with a warning', () => {
  const { ctx } = ownerCtx();
  assert.equal(ctx.ownerAddLeave({}, 'E1', 'dayoff', ['2026-11-20', '2026-11-21'], '', '').success, true);
  assert.equal(ctx.ownerAddLeave({}, 'E1', 'dayoff', ['2026-11-21'], '', '').success, false);
  const r = ctx.ownerAddLeave({}, 'E1', 'dayoff', ['2026-11-25'], '', '');
  assert.equal(r.success, true, r.error);
  assert.match(r.warning, /3 days off in November/);
});

test('owner leave: refused without the owner login', () => {
  const { ctx } = load([HEAD10]);
  assert.equal(ctx.ownerAddLeave({ auth: 'x' }, 'E1', 'dayoff', ['2026-11-20'], '', '').success, false);
});
