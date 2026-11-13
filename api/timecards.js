// GET  /api/timecards?from=YYYY-MM-DD&to=YYYY-MM-DD — saved clock in / out times for those days,
//      plus each person's leave in the month of `to` (Stock sheet, Leave tab)
// POST /api/timecards { from, to, cards: [{ employee, store, inAt, outAt }] }
//      — the Loyverse Timecards export, read in the browser by finance/timecards.js. Every
//        saved timecard from `from` to `to` is replaced by these, so uploading an overlapping
//        week again (or one with timecards fixed in Back Office) never duplicates anything.
// Loyverse's API has no timecards, so the owner exports them from Back Office and uploads.
// Saved in the Finance sheet, tab "Timecards". Owner login only.
const { SHEET_ID, MOCK, getSheetsClient, checkPin } = require('./_google');
const { localDate } = require('./_loyverse');
const { businessDay } = require('../finance/timecards');

const STOCK_SHEET_ID = process.env.STOCK_SHEET_ID || '1RsicbmRnmQYRZJE37sydQ2sxMxIzQXfk5ke4aB6ATBM';

const TAB = 'Timecards';
const HEADERS = ['Day', 'Employee', 'Shop', 'Clock in', 'Clock out', 'Hours', 'Loyverse store', 'Uploaded'];
const SHOPS = ['Bicasso 1', 'Bicasso 2', 'Nana', 'Palladium'];
// Loyverse store names that don't say which shop they are (owner, 13 Nov 2026)
const ALIASES = { burmelin: 'Bicasso 1' };
const MAX_CARDS = 3000;
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Loyverse store name -> shop: LOYVERSE_STORE_MAP first (as the sales import), then the
// known aliases ("Burmelin" is Bicasso 1), the same name ignoring spaces and case, then a
// store name that contains the shop's name.
function shopFor(store) {
  let overrides = {};
  try { overrides = JSON.parse(process.env.LOYVERSE_STORE_MAP || '{}'); } catch (e) { /* ignore */ }
  const s = String(store || '').trim();
  for (const [k, v] of Object.entries(overrides)) if (k.trim().toLowerCase() === s.toLowerCase() && v) return String(v);
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ALIASES[norm(s)]) return ALIASES[norm(s)];
  return SHOPS.find((sh) => norm(sh) === norm(s)) || SHOPS.find((sh) => norm(s).includes(norm(sh))) || s;
}
const hoursOf = (a, b) => {
  if (!b) return '';
  const m = (st) => Date.parse(st.replace(' ', 'T') + ':00Z') / 60000;
  return Math.round(((m(b) - m(a)) / 60) * 100) / 100;
};

// Keeps the saved rows outside from..to and adds the new cards; header first, sorted by day
function mergeRows(values, from, to, cards, uploaded) {
  const keep = (values || []).slice(1).filter((r) => r[0] && (String(r[0]) < from || String(r[0]) > to));
  const add = cards.map((c) => [businessDay(c.inAt), c.employee, shopFor(c.store), c.inAt, c.outAt || '', hoursOf(c.inAt, c.outAt), c.store || '', uploaded]);
  const rows = keep.concat(add).sort((a, b) => (String(a[0]) + String(a[3]) < String(b[0]) + String(b[3]) ? -1 : 1));
  return [HEADERS].concat(rows);
}

function rowsToCards(values, from, to) {
  return (values || []).slice(1).filter((r) => r[0] && r[3] && (!from || r[0] >= from) && (!to || r[0] <= to))
    .map((r) => ({ day: String(r[0]), employee: String(r[1] || ''), shop: String(r[2] || ''), inAt: String(r[3]), outAt: String(r[4] || '') }));
}

// The month's leave per person from the Stock sheet's Leave tab (staff app requests):
// approved days off, approved sick leave, and requests still waiting for the owner.
// A half day counts 0.5; a date asked twice counts once.
function leaveFromRows(values, month) {
  const head = (values[0] || []).map((h) => String(h).trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const [nameC, typeC, dateC, statusC, halfC] = [col('name'), col('type'), col('date'), col('status'), col('half day')];
  if (nameC < 0 || dateC < 0 || statusC < 0) return [];
  const people = new Map(), seen = new Set();
  for (const r of values.slice(1)) {
    const name = String(r[nameC] || '').trim(), date = String(r[dateC] || '').trim().slice(0, 10);
    const status = String(r[statusC] || '').trim();
    if (!name || date.slice(0, 7) !== month || (status !== 'Approved' && status !== 'Pending')) continue;
    const sick = /sick/i.test(String(r[typeC] || ''));
    const kind = status === 'Pending' ? 'pending' : sick ? 'sick' : 'dayOff';
    const key = `${name}|${date}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const half = halfC > -1 && /half|morning|afternoon/i.test(String(r[halfC] || ''));
    const p = people.get(name) || { name, dayOff: 0, sick: 0, pending: 0, dates: { dayOff: [], sick: [], pending: [] } };
    p[kind] += half ? 0.5 : 1;
    p.dates[kind].push({ date, half, sick });
    people.set(name, p);
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readAll(sheets) {
  try {
    return (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A1:H` })).data.values || [];
  } catch (err) {
    if (/Unable to parse range/i.test(err.message || '')) return null;   // no tab yet
    throw err;
  }
}

async function save(req, res) {
  const b = req.body || {};
  const from = String(b.from || ''), to = String(b.to || '');
  if (!DAY.test(from) || !DAY.test(to) || from > to) return res.status(400).json({ error: 'The file has no usable dates' });
  const cards = (Array.isArray(b.cards) ? b.cards : []).filter((c) => c && String(c.employee || '').trim() && STAMP.test(c.inAt) && (!c.outAt || STAMP.test(c.outAt)))
    .map((c) => ({ employee: String(c.employee).trim().slice(0, 100), store: String(c.store || '').trim().slice(0, 100), inAt: c.inAt, outAt: c.outAt || '' }))
    .filter((c) => { const d = businessDay(c.inAt); return d >= from && d <= to; });
  if (!cards.length) return res.status(400).json({ error: 'No timecards to save' });
  if (cards.length > MAX_CARDS) return res.status(400).json({ error: `Too many timecards in one file (most ${MAX_CARDS})` });
  const uploaded = localDate(Date.now());
  if (MOCK) return res.json({ ok: true, mock: true, saved: cards.length });
  try {
    const sheets = getSheetsClient();
    let values = await readAll(sheets);
    if (values === null) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
      values = [HEADERS];
    }
    const next = mergeRows(values, from, to, cards, uploaded);
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A1`, valueInputOption: 'RAW', requestBody: { values: next } });
    // the list can only shrink when timecards were deleted in Back Office: clear what's left below
    if (next.length < values.length) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A${next.length + 1}:H${values.length}` });
    }
    res.json({ ok: true, saved: cards.length, replaced: values.length - 1 - (next.length - 1 - cards.length) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the timecards: ' + err.message });
  }
}

function mockCards(from, to) {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
    const next = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
    out.push(
      { day: d, employee: 'Aye', shop: 'Bicasso 1', inAt: `${d} 09:52`, outAt: `${d} 21:34` },
      { day: d, employee: 'Mon', shop: 'Bicasso 1', inAt: `${d} 10:25`, outAt: `${d} 21:31` },
      { day: d, employee: 'Pyone Cho', shop: 'Bicasso 1', inAt: `${d} 13:00`, outAt: `${d} 21:00` },
      { day: d, employee: 'Sub Kumar', shop: 'Nana', inAt: `${d} 12:58`, outAt: `${next} 00:05` },
    );
    if (out.length > 200) break;
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method === 'POST') return save(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST only' });
  const q = req.query || {};
  const to = String(q.to || localDate(Date.now()));
  const from = String(q.from || to);
  if (!DAY.test(from) || !DAY.test(to)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  const month = to.slice(0, 7);
  if (MOCK) {
    const leave = leaveFromRows([['Request ID', 'Requested', 'Employee ID', 'Name', 'Type', 'Date', 'Reason', 'Status', 'Decided', 'Owner note', 'Half day'],
      ['1', '', 'S1', 'Aye', 'Day off', `${month}-04`, '', 'Approved', '', '', ''], ['2', '', 'S1', 'Aye', 'Sick leave', `${month}-09`, '', 'Approved', '', '', 'First half'],
      ['3', '', 'S2', 'Mon', 'Day off', `${month}-20`, '', 'Pending', '', '', '']], month);
    return res.json({ ok: true, mock: true, from, to, cards: mockCards(from, to), lastDay: to, uploaded: to, month, leave });
  }
  try {
    const sheets = getSheetsClient();
    const leaveRead = sheets.spreadsheets.values.get({ spreadsheetId: STOCK_SHEET_ID, range: "'Leave'!A1:K" }).then((r) => r, (err) => ({ err }));
    const values = (await readAll(sheets)) || [];
    const lv = await leaveRead;
    if (lv.err) console.error('Leave tab:', lv.err.message);
    const leave = lv.err ? null : leaveFromRows(lv.data.values || [], month);
    const all = values.slice(1).filter((r) => r[0]);
    const lastDay = all.reduce((m, r) => (String(r[0]) > m ? String(r[0]) : m), '');
    const uploaded = all.reduce((m, r) => (String(r[7] || '') > m ? String(r[7]) : m), '');
    res.json({ ok: true, from, to, cards: rowsToCards(values, from, to), lastDay, uploaded, month, leave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not read the timecards: ' + err.message });
  }
};
module.exports.mergeRows = mergeRows;
module.exports.shopFor = shopFor;
module.exports.leaveFromRows = leaveFromRows;
