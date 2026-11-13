// GET /api/staff-times?from=YYYY-MM-DD&to=YYYY-MM-DD — who opened and closed each till, and
// each staff member's first and last sale, per shop per day, read live from Loyverse for the
// daily statement. Loyverse's API has no timecards (Time clock is Back Office only), so these
// are the closest times it records. Owner login only. At most 31 days per request.
const { MOCK, checkPin } = require('./_google');
const { lvGetAll, localDate, addDays, mapStores, staffDays } = require('./_loyverse');

const SHOPS = ['Bicasso 1', 'Bicasso 2', 'Nana', 'Palladium'];

// Sample days for local development without a Loyverse token.
function mockDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(
      { date: d, shop: 'Bicasso 1', hours: '10:00–21:30', tills: [{ opened: '10:24', openedBy: 'Aye', closed: '21:35', closedBy: 'Aye', hours: 11.2, late: 24, early: 0, openDays: 0 }],
        staff: [{ name: 'Aye', firstSale: '10:41', lastSale: '21:20', receipts: 23 }, { name: 'Mon', firstSale: '13:05', lastSale: '20:55', receipts: 9 }] },
      { date: d, shop: 'Nana', hours: '13:00–24:00', tills: [{ opened: '12:55', openedBy: 'Sub Kumar', closed: '23:20', closedBy: 'Sub Kumar', hours: 10.4, late: 0, early: 40, openDays: 0 }],
        staff: [{ name: 'Sub Kumar', firstSale: '13:30', lastSale: '23:10', receipts: 14 }] },
    );
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const today = localDate(Date.now());
  const to = String((req.query || {}).to || today);
  const from = String((req.query || {}).from || to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: 'The first date must be before the second' });
  if (addDays(from, 30) < to) return res.status(400).json({ error: 'Pick 31 days or fewer' });

  if (!process.env.LOYVERSE_TOKEN) {
    if (MOCK) return res.status(200).json({ ok: true, mock: true, from, to, days: mockDays(from, to) });
    return res.status(400).json({ error: 'Loyverse is not connected — add LOYVERSE_TOKEN in Vercel → Settings → Environment Variables' });
  }

  const dates = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) dates.add(d);
  try {
    // A day runs to 05:00 next morning, and a till opened one day can close the next, so
    // ask for a day either side.
    const window = { created_at_min: `${addDays(from, -1)}T00:00:00.000Z`, created_at_max: `${addDays(to, 2)}T00:00:00.000Z` };
    const [stores, employees, shifts, receipts] = await Promise.all([
      lvGetAll('/stores', 'stores'),
      lvGetAll('/employees', 'employees', { show_deleted: true }),
      lvGetAll('/shifts', 'shifts', window),
      lvGetAll('/receipts', 'receipts', window),
    ]);
    const { map } = mapStores(stores, SHOPS);
    return res.status(200).json({ ok: true, from, to, days: staffDays(shifts, receipts, employees, map, dates) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
