// Bicasso card fees. The bank's deposit lands in someone else's account, so the owner only
// checks it now and then. Every day's bank-in is therefore estimated: card sales less the fee
// rate. The rate is learned from the days that were checked (finance sheet, "Bank Deposits"
// tab: Date | Amount | Note | Card sales; card sales are saved with the deposit so the rate
// doesn't depend on the dates on screen), or DEFAULT_RATE until any day is checked. KBank's published EDC rates (MDR, plus 7% VAT on the fee) run from 0.55% (Thai
// debit) to 3.15% (foreign platinum credit), and Loyverse doesn't say which card was used,
// so each day's fee is a mix: the learned rate is the median of the checked days. A day
// is flagged only when the bank took more than even the dearest card costs, or paid in more
// than was sold, since a day of mostly premium foreign cards is dearer but not wrong.
const DEPOSITS_TAB = 'Bank Deposits';
const DEPOSIT_HEADERS = ['Date', 'Amount', 'Note', 'Card sales'];
const DEFAULT_RATE = 2.87;         // 10 Nov 2026: card ฿42,530, bank paid ฿41,307.88
const MAX_FEE_PCT = 3.15 * 1.07;   // KBank's dearest card (foreign platinum+) with VAT: 3.37%
const MIN_FLAG_BAHT = 20;          // ...and at least this many baht over it, so rounding never flags

const round2 = (n) => Math.round(n * 100) / 100;
function money(v) {
  const n = Number(String(v ?? '').replace(/[,฿\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

// Sheet rows (header first) -> { 'YYYY-MM-DD': { amount, note, cardSales } }. A later row for the same
// date wins; rows without a date or amount are ignored.
function depositsFromRows(values) {
  const out = {};
  for (const r of (values || []).slice(1)) {
    const date = String(r[0] || '').trim();
    const amount = money(r[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) continue;
    out[date] = { amount, note: String(r[2] || '').trim(), cardSales: money(r[3]) };
  }
  return out;
}

// The whole tab with this date's deposit set (amount 0 removes it). Sorted by date.
function upsertDeposit(values, date, amount, note = '', cardSales = 0) {
  const rows = (values || []).slice(1).filter((r) => String(r[0] || '').trim() !== date && String(r[0] || '').trim());
  if (amount > 0) rows.push([date, amount, note, cardSales || '']);
  rows.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return [DEPOSIT_HEADERS, ...rows];
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The fee % to estimate with: median of the checked days (deposit and card sales both saved,
// fee not negative), or DEFAULT_RATE if none. Returns { rate, days }.
function learnedRate(deposits) {
  const pcts = Object.values(deposits)
    .filter((d) => d.cardSales > 0 && d.amount <= d.cardSales)
    .map((d) => ((d.cardSales - d.amount) / d.cardSales) * 100);
  return pcts.length ? { rate: median(pcts), days: pcts.length } : { rate: DEFAULT_RATE, days: 0 };
}

// days: [{ date, card, qr }] (card excludes QR). deposits: from depositsFromRows.
// withQr: true if the bank's deposit pays QR money too (then the fee is worked out on card + QR).
// rate: the fee % to estimate with (learnedRate). The finance page does the same in bankFees().
// Returns { days: [{ date, card, qr, sales, received, fee, pct, expected, flag }], totals }.
function feeSummary(days, deposits, { withQr = false, rate = DEFAULT_RATE } = {}) {
  const rows = days.map((d) => {
    const sales = round2(withQr ? d.card + d.qr : d.card);
    const dep = deposits[d.date];
    const received = dep ? dep.amount : null;
    const fee = received == null ? null : round2(sales - received);
    const pct = received == null || !(sales > 0) ? null : (fee / sales) * 100;
    return { date: d.date, card: round2(d.card), qr: round2(d.qr), sales, received, fee, pct, note: dep ? dep.note : '' };
  });
  for (const r of rows) {
    r.expected = round2(r.sales * (1 - rate / 100));
    r.flag = '';
    if (r.received == null) continue;
    if (r.fee < -0.5) r.flag = 'more';   // paid more than was sold: wrong day, or two days in one deposit
    else if (r.received < r.sales * (1 - MAX_FEE_PCT / 100) - MIN_FLAG_BAHT) r.flag = 'short';   // more than any card costs
  }
  const sum = (xs, k) => round2(xs.reduce((n, r) => n + r[k], 0));
  const checked = rows.filter((r) => r.received != null);
  const totals = {
    sales: sum(rows, 'sales'), expected: sum(rows, 'expected'),
    checked: { days: checked.length, received: sum(checked, 'received'), expected: sum(checked, 'expected') },
  };
  totals.fee = round2(totals.sales - totals.expected);
  return { days: rows, totals };
}

module.exports = { MAX_FEE_PCT, DEFAULT_RATE, DEPOSITS_TAB, DEPOSIT_HEADERS, money, depositsFromRows, upsertDeposit, learnedRate, feeSummary };
