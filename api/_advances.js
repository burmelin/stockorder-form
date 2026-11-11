// Salary advances: money a person takes from their salary before payday.
//
// An advance is a Master Entry row with category Salary and the word "advance" in the note
// together with the person's name, e.g. "Kumar Advance". It comes from a shop drawer (staff type
// it as the Loyverse pay-out note, the daily import books it as Salary) or is added by the owner
// in Finance → Staff. It counts as salary spending on the day it is paid: it is salary paid
// early. On payday the owner types how much of what the person owes to take off; the pay is
// then salary − that amount, so over time salary spending adds up to the full salaries.
//
// Saved in the finance sheet:
//   "Staff Salary"        Name | Monthly salary
//   "Advance Deductions"  Month (YYYY-MM) | Name | Amount
//   "Payroll"             Month | Name | Salary | Advance taken off | Commission | Pay | Marked paid
//                         (one row per person, written when the owner marks them paid)
const SALARY_TAB = 'Staff Salary';
const DEDUCTIONS_TAB = 'Advance Deductions';
const PAYROLL_TAB = 'Payroll';
const OWNERS_TAB = 'Advance Names';      // Key (date|shop|note) | Name: whose advance, picked by the owner
const OPENING_TAB = 'Advance Opening';   // Date | Name | Amount | Note: advances from before tracking
const advanceKey = (r) => [r.date, r.shop, r.notes || ''].join('|');
// Advances in Master Entry are counted from this day, when the owner started tracking them in
// the app. Older advances still owed are added by hand as "earlier" advances (tab "Advance
// Opening", no cash moves). Empty = count everything.
const ADVANCES_FROM = '2026-11-01';
const PAYROLL_HEADERS = ['Month', 'Name', 'Salary', 'Advance taken off', 'Commission', 'Pay', 'Marked paid'];

const isAdvance = (r) => r.category === 'Salary' && /advance/i.test(r.notes || '');
const words = (s) => String(s || '').toLowerCase().replace(/ · \d\d:\d\d$/, '').split(/[^a-z0-9\u1000-\u109f]+/).filter(Boolean);
const money = (v) => Math.max(0, Math.round(parseFloat(String(v ?? '').replace(/,/g, '')) || 0));

// Whose advance a note is: the person whose whole name is in it, or else whose first name is
// (when only one person has that first name). Returns the name or ''.
function nameInNote(note, names) {
  const w = words(note);
  const has = (seq) => w.some((_, i) => seq.every((s, j) => w[i + j] === s));
  const full = names.filter((n) => has(words(n))).sort((a, b) => words(b).length - words(a).length);
  // A name that is part of someone else's longer name ("Sunil" and "Sunil GTM") is not enough
  const inside = (n) => names.some((m) => m !== n && !full.includes(m) && words(n).every((x) => words(m).includes(x)));
  if (full.length) return inside(full[0]) ? '' : full[0];
  // First name only, when no other staff name has that word ("Kumar" with Kumar Giri and Sub
  // Kumar could be either: the owner picks in Finance)
  const first = names.filter((n) => words(n).length && w.includes(words(n)[0]));
  if (first.length !== 1) return '';
  const fw = words(first[0])[0];
  return names.some((m) => m !== first[0] && words(m).includes(fw)) ? '' : first[0];
}

// Everyone in the Stock sheet's Staff tab (shops and Palladium), in sheet order
function staffNamesFromRows(values) {
  const nameCol = (values[0] || []).map((h) => String(h).trim().toLowerCase()).indexOf('name');
  if (nameCol < 0) return [];
  return [...new Set(values.slice(1).map((r) => String(r[nameCol] || '').trim().replace(/\s+/g, ' ')).filter(Boolean))];
}

// The saved Payroll rows for one month
function payrollFromRows(values, month) {
  return values.filter((r) => String(r[0] || '').trim() === month && String(r[1] || '').trim())
    .map((r) => ({ name: String(r[1]).trim(), salary: money(r[2]), deduct: money(r[3]), commission: money(r[4]), pay: money(r[5]), paidAt: String(r[6] || '') }));
}
// All Payroll rows with the rows of these people for this month written (or rewritten); every
// other row is kept, so people can be marked paid one at a time on different days.
function upsertPayroll(values, month, people, paidAt) {
  const names = new Set(people.map((p) => String(p.name).trim()));
  const keep = values.filter((r, i) => i > 0 && String(r[0] || '').trim()
    && !(String(r[0]).trim() === month && names.has(String(r[1] || '').trim())));
  const rows = people.map((p) => {
    const salary = money(p.salary), deduct = money(p.deduct), commission = money(p.commission);
    return [month, String(p.name).trim().slice(0, 100), salary, deduct, commission, Math.max(0, salary - deduct) + commission, paidAt];
  });
  return [PAYROLL_HEADERS, ...[...keep, ...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
}

function ownersFromRows(values) {
  const out = {};
  for (const r of values) if (String(r[0] || '').trim() && String(r[1] || '').trim()) out[String(r[0]).trim()] = String(r[1]).trim();
  return out;
}
function openingsFromRows(values) {
  return values.map((r) => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(String(r[0] || '').trim()) ? String(r[0]).trim() : '', name: String(r[1] || '').trim(), amount: money(r[2]), note: String(r[3] || '').trim() }))
    .filter((o) => o.name && o.amount);
}

function salariesFromRows(values) {
  const out = {};
  for (const r of values) {
    const name = String(r[0] || '').trim();
    if (name && name.toLowerCase() !== 'name') out[name] = money(r[1]);
  }
  return out;
}
function deductionsFromRows(values) {
  const out = [];
  for (const r of values) {
    const month = String(r[0] || '').trim(), name = String(r[1] || '').trim();
    if (/^\d{4}-\d{2}$/.test(month) && name) out.push({ month, name, amount: money(r[2]) });
  }
  return out;
}

// For one month: each person's salary, advances taken that month, what they owe on payday
// (all advances to the end of the month, less what earlier paydays took off), the amount
// taken off this payday, and the pay. Advances whose note names nobody are listed apart.
// Every advance that makes up what a person owes is in their items (earlier months too), and
// earlierCuts is what earlier paydays already took off, so the screen can show where the
// total comes from. Advances before ADVANCES_FROM are not counted: tracking started then.
function advancesFor(rows, names, salaries, deductions, month, from = ADVANCES_FROM, extra = {}) {
  const owners = extra.owners || {}, openings = extra.openings || [];
  const end = month + '-31';
  const people = new Map(names.map((n) => [n, { name: n, salary: salaries[n] || 0, taken: 0, owesBefore: 0, earlierCuts: 0, deduct: 0, items: [] }]));
  const unmatched = [];
  for (const r of rows) {
    if (!isAdvance(r) || r.date > end || (from && r.date < from)) continue;
    const amount = (r.cashOut || 0) + (r.bankOut || 0);
    const picked = owners[advanceKey(r)];
    const name = picked && names.includes(picked) ? picked : nameInNote(r.notes, names);
    const p = people.get(name);
    if (!p) { unmatched.push({ row: r.row, date: r.date, shop: r.shop, amount, notes: r.notes, key: advanceKey(r) }); continue; }
    p.owesBefore += amount;
    const thisMonth = r.date.slice(0, 7) === month;
    if (thisMonth) p.taken += amount;
    p.items.push({ row: r.row, date: r.date, shop: r.shop, amount, notes: r.notes, thisMonth });
  }
  for (const o of openings) {
    const p = people.get(o.name);
    if (!p || !o.amount || (o.date && o.date > end)) continue;
    p.owesBefore += o.amount;
    p.items.push({ row: 0, date: o.date, shop: 'Before tracking', amount: o.amount, notes: o.note || 'earlier advance', thisMonth: false, earlier: true });
  }
  for (const d of deductions) {
    const p = people.get(d.name);
    if (!p) continue;
    if (d.month < month && (!from || d.month >= from.slice(0, 7))) { p.owesBefore -= d.amount; p.earlierCuts += d.amount; }
    else if (d.month === month) p.deduct = d.amount;
  }
  const staff = [...people.values()].map((p) => {
    const owes = Math.max(0, p.owesBefore);
    const deduct = Math.min(p.deduct, owes);
    return { name: p.name, salary: p.salary, taken: p.taken, owes, earlierCuts: p.earlierCuts, deduct, pay: Math.max(0, p.salary - deduct), owesAfter: owes - deduct,
      items: p.items.sort((a, b) => (a.date < b.date ? -1 : 1)) };
  });
  return { month, staff, unmatched };
}

module.exports = { ADVANCES_FROM, OWNERS_TAB, OPENING_TAB, advanceKey, ownersFromRows, openingsFromRows, SALARY_TAB, DEDUCTIONS_TAB, PAYROLL_TAB, PAYROLL_HEADERS, payrollFromRows, upsertPayroll, isAdvance, nameInNote, staffNamesFromRows, money, salariesFromRows, deductionsFromRows, advancesFor };
