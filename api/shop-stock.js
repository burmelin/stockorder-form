// /api/shop-stock?store=burmelin|nana[&fresh=1] — a shop's stock and last 7 days' sales, read from
// Loyverse for the staff app (see _shopstock.js for how items become product / colour / size).
// Open to every staff-app login (x-staff-token) and the owner. Answers are kept for 10 minutes;
// fresh=1 (the Refresh button) reads Loyverse again if the kept copy is over a minute old.
// Token: LOYVERSE_STAFF_TOKEN (its own token, so it can be switched off alone), else LOYVERSE_TOKEN.
const { lvGetAll, localDate, addDays, TIMEZONE } = require('./_loyverse');
const { loginOfToken, isOwnerRequest } = require('./_google');
const { variantIndex, buildStock, salesLines, salesMoney, storeIds, tillShops, STORE_SHOP } = require('./_shopstock');

const KEEP_MS = 10 * 60 * 1000;
const FRESH_MIN_MS = 60 * 1000;
const DAYS = 7;
const SALES_FROM = process.env.SHOP_SALES_FROM || '2026-11-18';
const kept = new Map();   // store key -> { at, data }

const token = () => process.env.LOYVERSE_STAFF_TOKEN || process.env.LOYVERSE_TOKEN || '';

async function readStore(key) {
  const t = token();
  const [stores, devices, items] = await Promise.all([
    lvGetAll('/stores', 'stores', {}, t),
    lvGetAll('/pos_devices', 'pos_devices', {}, t),
    lvGetAll('/items', 'items', {}, t),
  ]);
  const id = storeIds(stores)[key];
  if (!id) throw new Error(`Loyverse has no store for "${key}"`);
  // Last 7 days, but never before the switch to Loyverse stock (18 Nov 2026): older receipts are for
  // the old items without sizes, so the list fills up day by day from then
  const weekAgo = addDays(localDate(Date.now()), -(DAYS - 1));
  const since = weekAgo > SALES_FROM ? weekAgo : SALES_FROM;
  const sinceIso = new Date(`${since}T00:00:00+07:00`).toISOString();   // midnight Bangkok
  const [levels, receipts] = await Promise.all([
    lvGetAll('/inventory', 'inventory_levels', { store_ids: id }, t),
    lvGetAll('/receipts', 'receipts', { store_id: id, created_at_min: sinceIso }, t),
  ]);
  const idx = variantIndex(items);
  const tills = tillShops(devices);
  const shopOf = (r) => tills.get(r.pos_device_id) || STORE_SHOP[key];
  const stock = buildStock(idx, levels.filter((l) => l.store_id === id));
  const mine = receipts.filter((r) => r.store_id === id && localDate(r.receipt_date || r.created_at) >= since);
  return {
    store: key, updatedAt: new Date().toISOString(), since,
    sized: stock.sized, totals: stock.totals,
    sales: salesLines(mine, idx, shopOf, TIMEZONE),
    money: salesMoney(mine, shopOf, TIMEZONE),   // per day and shop (POS): cash / card / QR
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const login = await loginOfToken(req.headers['x-staff-token']);
  if (!login && !(await isOwnerRequest(req))) {
    return res.status(401).json({ error: 'Please log out and log in again.', needLogin: true });
  }
  const key = String((req.query && req.query.store) || '').toLowerCase();
  if (key !== 'burmelin' && key !== 'nana') return res.status(400).json({ error: 'store must be burmelin or nana' });
  if (!token()) return res.status(500).json({ error: 'The Loyverse token is not set up yet (Vercel setting LOYVERSE_STAFF_TOKEN).' });

  const hit = kept.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  const fresh = req.query && req.query.fresh === '1';
  if (hit && (age < (fresh ? FRESH_MIN_MS : KEEP_MS))) return res.json(hit.data);
  try {
    const data = await readStore(key);
    kept.set(key, { at: Date.now(), data });
    return res.json(data);
  } catch (err) {
    console.error(err);
    // Loyverse down: the last copy is better than nothing, and it says how old it is
    if (hit) return res.json({ ...hit.data, stale: true, error: err.message });
    return res.status(502).json({ error: 'Could not read Loyverse: ' + err.message });
  }
};
