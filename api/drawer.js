// /api/drawer — the Palladium manager's cash drawer (sheet shop "Warehouse", see _google.js).
//   GET                                   cash in hand, this month's entries, and every sale not paid yet
//   POST { kind:'expense', amount, note } Other Expense, Cash Out
//   POST { kind:'sale', amount, note, pay, who, ref }
//        pay 'cash'   → Retail Sale, Cash In (into the drawer)
//        pay 'bank'   → Retail Sale, Bank In (transfer / QR to the company bank, not the drawer)
//        pay 'unpaid' → Credit Sale to the account "Palladium Unpaid" (the buyer owes it; `who` is needed)
//        ref is the sale's id from the phone (also in the Stock sheet's Sales Log). It goes in the
//        notes as "Ref <id>"; a second save with the same ref (a retry) writes nothing.
//   POST { kind:'paid', ref, pay }        an unpaid sale is paid: Customer Payment from "Palladium Unpaid",
//        Cash In (drawer) or Bank In, for the whole amount. A second "paid" for the same ref writes nothing.
//   DELETE { row, original }              takes back one of today's entries made from the drawer screen
// Open to the Palladium login (staff app) and the owner. The owner gives the float from
// Finance (two "Drawer Float" rows: Office Cash Out, drawer Cash In).
// "Palladium Unpaid" is one credit account (Lists tab, column E, shop Warehouse in column F), so
// the owner sees the total owed on Finance Home like any credit customer; who owes what is in
// each row's notes, and the drawer screen lists them one by one.
const { SHEET_ID, MOCK, DRAWER, getSheetsClient, checkDrawer, num, readMasterEntry, sheetFullError, rowMismatch, verifyWritten, masterSheetId } = require('./_google');

const BY = 'Palladium manager';   // Entered By for rows made on this screen
const UNPAID = 'Palladium Unpaid'; // credit account for sales not paid yet
const PAYS = ['cash', 'bank', 'unpaid'];

// Today in Thailand, YYYY-MM-DD
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

const REF_RE = /^PS[a-z0-9]{6,20}$/;
// "… · Ref PSabc123" → "PSabc123"
function refOf(notes) { const m = String(notes || '').match(/(?:^|·\s*)Ref (PS[a-z0-9]+)\s*$/); return m ? m[1] : ''; }

const isUnpaidSale = (r) => r.shop === DRAWER && r.category === 'Credit Sale' && r.customer === UNPAID;
const isUnpaidPayment = (r) => r.shop === DRAWER && r.category === 'Customer Payment' && r.customer === UNPAID;

// Sales still owed: each unpaid sale whose ref has no payment yet
function unpaidList(rows) {
  const paid = new Set(rows.filter(isUnpaidPayment).map((r) => refOf(r.notes)).filter(Boolean));
  return rows.filter((r) => isUnpaidSale(r) && r.credit > 0 && !paid.has(refOf(r.notes)))
    .map((r) => ({ row: r.row, date: r.date, amount: r.credit, notes: r.notes, ref: refOf(r.notes) }))
    .reverse();
}

// Drawer rows -> what the screen shows
function summarize(rows, day) {
  const mine = rows.filter((r) => r.shop === DRAWER);
  const cash = mine.reduce((n, r) => n + r.cashIn - r.cashOut, 0);
  const month = day.slice(0, 7);
  const entries = mine.filter((r) => r.date.slice(0, 7) === month && (r.cashIn || r.cashOut || r.bankIn || r.bankOut || r.credit)).map((r) => {
    const sale = r.category === 'Retail Sale' || isUnpaidSale(r);
    return {
      row: r.row, date: r.date, category: r.category, notes: r.notes,
      amount: r.cashIn - r.cashOut + r.bankIn - r.bankOut + (isUnpaidSale(r) ? r.credit : 0),
      // where the money is: 'cash' (in the drawer), 'bank', or 'unpaid' (still owed)
      pay: isUnpaidSale(r) ? 'unpaid' : (r.bankIn || r.bankOut) && !(r.cashIn || r.cashOut) ? 'bank' : 'cash',
      what: (r.category === 'Drawer Float' || r.category === 'Opening Balance') ? 'Opening cash'
        : sale ? 'Sale'
        : isUnpaidPayment(r) ? 'Paid'
        : /^Collection/.test(r.category) ? 'Given to office'
        : (r.cashIn || r.bankIn) ? r.category : 'Expense',
      canDelete: r.enteredBy === BY && r.date === day,
      original: { date: r.date, shop: r.shop, customer: r.customer, category: r.category, cashIn: r.cashIn, bankIn: r.bankIn, cashOut: r.cashOut, bankOut: r.bankOut, creditAmount: r.credit },
    };
  }).reverse();
  const unpaid = unpaidList(rows);
  return { cash, entries, unpaid, unpaidTotal: unpaid.reduce((n, u) => n + u.amount, 0), today: day };
}

// The Master Entry row (A–L) for one save, or { error }. `rows` = the sheet as read now.
// Columns: A date, B shop, C customer, D category, E type (formula, left empty), F cash in,
// G bank in, H cash out, I bank out, J credit amount, K entered by, L notes.
function planRow(b, rows, day, by) {
  const [y, m, d] = day.split('-').map(Number);
  const date = `${m}/${d}/${y}`;
  const enteredBy = by === 'Owner' ? 'App' : BY;
  const row = (customer, category, f, g, h, j, notes) => [date, DRAWER, customer, category, null, f || '', g || '', h || '', '', j || '', enteredBy, notes];

  if (b.kind === 'expense') {
    const amount = Math.round(num(b.amount) * 100) / 100;
    const note = String(b.note || '').trim().slice(0, 120);
    if (!(amount > 0) || amount > 200000) return { error: 'Type the amount in baht' };
    if (!note) return { error: 'Write what the money was for' };
    return { values: row('', 'Other Expense', 0, 0, amount, 0, note) };
  }

  if (b.kind === 'sale') {
    const amount = Math.round(num(b.amount) * 100) / 100;
    const pay = b.pay || 'cash';
    const who = String(b.who || '').replace(/[·+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const ref = String(b.ref || '').trim();
    if (!(amount > 0) || amount > 500000) return { error: 'Type the amount in baht' };
    if (!PAYS.includes(pay)) return { error: 'Choose how it was paid: Cash, Bank or Not paid yet' };
    if (pay === 'unpaid' && !who) return { error: 'Write who will pay later' };
    if (ref && !REF_RE.test(ref)) return { error: 'Missing sale ID. Close the app and open it again.' };
    if (pay === 'unpaid' && !ref) return { error: 'Missing sale ID. Close the app and open it again.' };
    if (ref && rows.some((r) => r.shop === DRAWER && refOf(r.notes) === ref && (r.category === 'Retail Sale' || isUnpaidSale(r)))) return { already: true };
    const note = [String(b.note || '').trim().slice(0, 400), who, ref && 'Ref ' + ref].filter(Boolean).join(' · ');
    if (pay === 'unpaid') return { values: row(UNPAID, 'Credit Sale', 0, 0, 0, amount, note) };
    return { values: row('', 'Retail Sale', pay === 'cash' ? amount : 0, pay === 'bank' ? amount : 0, 0, 0, note) };
  }

  if (b.kind === 'paid') {
    const ref = String(b.ref || '').trim();
    const pay = b.pay;
    if (pay !== 'cash' && pay !== 'bank') return { error: 'Choose Cash or Bank' };
    const sale = rows.find((r) => isUnpaidSale(r) && refOf(r.notes) === ref);
    if (!ref || !sale) return { error: 'That unpaid sale was not found. Pull to refresh.' };
    if (rows.some((r) => isUnpaidPayment(r) && refOf(r.notes) === ref)) return { already: true };
    // "T9027 … · Cousin · Ref PS…" → "Paid · Cousin · sale of 15 Nov · Ref PS…"
    const parts = sale.notes.split(' · ');
    const who = parts.length >= 3 ? parts[parts.length - 2] : '';  // the buyer's name sits just before the ref
    const note = ['Paid', who, 'sale of ' + sale.date, 'Ref ' + ref].filter(Boolean).join(' · ');
    return { values: row(UNPAID, 'Customer Payment', pay === 'cash' ? sale.credit : 0, pay === 'bank' ? sale.credit : 0, 0, 0, note) };
  }

  return { error: 'Pick Sale or Expense' };
}

module.exports = async function handler(req, res) {
  const by = await checkDrawer(req, res);
  if (!by) return;

  if (req.method === 'GET') {
    if (MOCK) return res.json({ ...summarize(mockRows(), today()), mock: true });
    try {
      const { rows } = await readMasterEntry(getSheetsClient());
      return res.json(summarize(rows, today()));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not read the sheet: ' + err.message });
    }
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const day = today();
    if (MOCK) {
      const plan = planRow(b, mockRows(), day, by);
      return plan.error ? res.status(400).json({ error: plan.error }) : res.json({ ok: true, mock: true });
    }
    try {
      const sheets = getSheetsClient();
      const { rows, nextRow, lastRow } = await readMasterEntry(sheets);
      const plan = planRow(b, rows, day, by);
      if (plan.error) return res.status(400).json({ error: plan.error });
      if (plan.already) return res.json({ ok: true, already: true });
      if (nextRow > lastRow) return res.status(500).json({ error: sheetFullError(lastRow) });
      const values = [plan.values];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `'Master Entry'!A${nextRow}:L${nextRow}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values },
      });
      const lost = await verifyWritten(sheets, nextRow, values);
      if (lost) return res.status(409).json({ error: lost });
      return res.json({ ok: true, row: nextRow });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not save: ' + err.message });
    }
  }

  if (req.method === 'DELETE') {
    const b = req.body || {};
    const row = parseInt(b.row, 10);
    const o = b.original || {};
    if (!row || row < 2) return res.status(400).json({ error: 'Invalid row' });
    if (o.shop !== DRAWER || o.date !== today()) return res.status(400).json({ error: "Only today's entries can be taken back here. Ask the owner to fix older ones." });
    if (o.category === 'Retail Sale' || o.category === 'Credit Sale') return res.status(400).json({ error: 'A sale also took pieces off stock, so it can only be fixed by the owner.' });
    if (MOCK) return res.json({ ok: true, mock: true });
    try {
      const sheets = getSheetsClient();
      const changed = await rowMismatch(sheets, row, o);
      if (changed) return res.status(409).json({ error: 'The list changed. Pull to refresh and try again.' });
      const k = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'Master Entry'!K${row}` });
      if (String(((k.data.values || [])[0] || [])[0] || '') !== BY) return res.status(403).json({ error: 'Only entries made on this screen can be taken back here.' });
      const sheetId = await masterSheetId(sheets);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] },
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not delete: ' + err.message });
    }
  }

  res.status(405).json({ error: 'GET, POST or DELETE only' });
};

function mockRows() {
  const day = today();
  const base = { shop: DRAWER, customer: '', bankIn: 0, bankOut: 0, credit: 0 };
  return [
    { ...base, row: 900, date: day.slice(0, 8) + '01', category: 'Drawer Float', cashIn: 3000, cashOut: 0, enteredBy: 'App', notes: 'From Office Cash' },
    { ...base, row: 901, date: day, category: 'Other Expense', cashIn: 0, cashOut: 120, enteredBy: BY, notes: 'Water and ice' },
    { ...base, row: 902, date: day, category: 'Retail Sale', cashIn: 850, cashOut: 0, enteredBy: BY, notes: 'T9027 · Colour 24 · Size 50 · 2 × 425 · Cousin' },
    { ...base, row: 903, date: day, category: 'Retail Sale', cashIn: 0, cashOut: 0, bankIn: 1200, enteredBy: BY, notes: 'F1165 · Colour 1 · Size L · 2 × 350 + B152 · Colour 3 · Size 32 · 1 × 500 · Ref PSmock0001' },
    { ...base, row: 904, date: day, customer: UNPAID, category: 'Credit Sale', cashIn: 0, cashOut: 0, credit: 900, enteredBy: BY, notes: 'T9039 · Colour 2 · Size 52 · 2 × 450 · Ko Aung · Ref PSmock0002' },
  ];
}

module.exports.summarize = summarize;
module.exports.planRow = planRow;
module.exports.refOf = refOf;
module.exports.UNPAID = UNPAID;
