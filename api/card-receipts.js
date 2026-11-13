// GET /api/card-receipts?from=YYYY-MM-DD&to=YYYY-MM-DD — every Bicasso 1 / Bicasso 2 receipt
// (and Nana's QR receipts from 13 Nov 2026, which land in the same bank account)
// paid (partly) by card or QR in those dates, read live from Loyverse. The sheet keeps only
// one Retail Sale row per shop per day, so the single receipts behind its Bank In come from here.
// Owner login only. At most 31 days per request.
const { MOCK, checkPin } = require('./_google');
const { lvGetAll, localDate, addDays, mapStores, cardReceipts } = require('./_loyverse');

const SHOPS = ['Bicasso 1', 'Bicasso 2', 'Nana'];

// Sample lines for local development without a Loyverse token.
function mockLines(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(
      { date: d, time: '11:42', shop: 'Bicasso 1', number: '1-1001', amount: 1200, qr: 0, methods: ['Card'], refund: false },
      { date: d, time: '15:05', shop: 'Bicasso 1', number: '1-1002', amount: 850, qr: 850, methods: ['QR PromptPay'], refund: false },
      { date: d, time: '19:30', shop: 'Bicasso 1', number: '1-1003', amount: 3350, qr: 0, methods: ['Card'], refund: false },
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
    if (MOCK) return res.status(200).json({ ok: true, mock: true, from, to, receipts: mockLines(from, to) });
    return res.status(400).json({ error: 'Loyverse is not connected — add LOYVERSE_TOKEN in Vercel → Settings → Environment Variables' });
  }

  const dates = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) dates.add(d);
  try {
    // Same widened window as the import (timezone offsets, tills that synced late).
    const window = { created_at_min: `${addDays(from, -1)}T00:00:00.000Z`, created_at_max: `${addDays(to, 3)}T00:00:00.000Z` };
    const [stores, receipts] = await Promise.all([
      lvGetAll('/stores', 'stores'),
      lvGetAll('/receipts', 'receipts', window),
    ]);
    const { map } = mapStores(stores, SHOPS);
    return res.status(200).json({ ok: true, from, to, receipts: cardReceipts(receipts, map, dates) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
