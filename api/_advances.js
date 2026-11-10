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
const SALARY_TAB = 'Staff Salary';
const DEDUCTIONS_TAB = 'Advance Deductions';

const isAdvance = (r) => r.category === 'Salary' && /advance/i.test(r.notes || '');
const words = (s) => String(s || '').toLowerCase().replace(/ · \d\d:\d\d$/, '').split(/[^a-z0-9\u1000-\u109f]+/).filter(Boolean);
const money = (v) => Math.max(0, Math.round(parseFloat(String(v ?? '').replace(/,/g, '')) || 0));

// Whose advance a note is: the person whose whole name is in it, or else whose first name is
// (when only one person has that first name). Returns the name or ''.
function nameInNote(note, names) {
  const w = words(note);
  const has = (seq) => w.some((_, i) => seq.every((s, j) => w[i + j] === s));
  const full = names.filter((n) => has(words(n))).sort((a, b) => words(b).length - words(a).length);
  if (full.length) return full[0];
  const first = names.filter((n) => words(n).length && w.includes(words(n)[0]));
  return first.length === 1 ? first[0] : '';
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
function advancesFor(rows, names, salaries, deductions, month) {
  const end = month + '-31';
  const people = new Map(names.map((n) => [n, { name: n, salary: salaries[n] || 0, taken: 0, owesBefore: 0, deduct: 0, items: [] }]));
  const unmatched = [];
  for (const r of rows) {
    if (!isAdvance(r) || r.date > end) continue;
    const amount = (r.cashOut || 0) + (r.bankOut || 0);
    const name = nameInNote(r.notes, names);
    const p = people.get(name);
    if (!p) { if (r.date.slice(0, 7) === month) unmatched.push({ row: r.row, date: r.date, shop: r.shop, amount, notes: r.notes }); continue; }
    p.owesBefore += amount;
    if (r.date.slice(0, 7) === month) {
      p.taken += amount;
      p.items.push({ row: r.row, date: r.date, shop: r.shop, amount, notes: r.notes });
    }
  }
  for (const d of deductions) {
    const p = people.get(d.name);
    if (!p) continue;
    if (d.month < month) p.owesBefore -= d.amount;
    else if (d.month === month) p.deduct = d.amount;
  }
  const staff = [...people.values()].map((p) => {
    const owes = Math.max(0, p.owesBefore);
    const deduct = Math.min(p.deduct, owes);
    return { name: p.name, salary: p.salary, taken: p.taken, owes, deduct, pay: Math.max(0, p.salary - deduct), owesAfter: owes - deduct,
      items: p.items.sort((a, b) => (a.date < b.date ? -1 : 1)) };
  });
  return { month, staff, unmatched };
}

module.exports = { SALARY_TAB, DEDUCTIONS_TAB, isAdvance, nameInNote, money, salariesFromRows, deductionsFromRows, advancesFor };
