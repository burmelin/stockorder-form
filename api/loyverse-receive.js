// POST /api/loyverse-receive { orderId } — adds a Burmelin delivery from Palladium to the Burmelin
// store's stock in Loyverse, right after Palladium taps Done (the app calls this by itself; the
// order card also has a "Try again" button if it failed).
//
// Steps, so a delivery is never added twice:
//   1. Apps Script "claims" the order (Orders tab, Loyverse column: To add -> Adding <time>). It
//      refuses an order that is not a Completed Burmelin order, or one being added / already added.
//   2. Read Burmelin's current stock for those pieces from Loyverse and set it to now + delivery.
//   3. Tell Apps Script how it went: Added <time> · N pcs (lines Loyverse doesn't have are listed,
//      to add by hand), or Failed: <reason>, which can be tried again.
// If step 3 can't be reached the order stays "Adding", and the card asks to check Loyverse by hand.
//
// Open to the Palladium login only (x-staff-token). Token: LOYVERSE_STAFF_TOKEN, else LOYVERSE_TOKEN.
const { lvGetAll, lvPost } = require('./_loyverse');
const { loginOfToken, askScript } = require('./_google');
const { variantIndex, planReceive, storeIds } = require('./_shopstock');

const token = () => process.env.LOYVERSE_STAFF_TOKEN || process.env.LOYVERSE_TOKEN || '';
const CHUNK = 100;   // stock levels per Loyverse request

async function addToLoyverse(lines) {
  const t = token();
  const [stores, items] = await Promise.all([
    lvGetAll('/stores', 'stores', {}, t),
    lvGetAll('/items', 'items', {}, t),
  ]);
  const storeId = storeIds(stores).burmelin;
  if (!storeId) throw new Error('Loyverse has no store called "Burmelin"');
  const levels = await lvGetAll('/inventory', 'inventory_levels', { store_ids: storeId }, t);
  const plan = planReceive(variantIndex(items), levels, lines, storeId);
  if (!plan.updates.length) return { pcs: 0, missing: plan.missing, written: 0 };
  // Several requests only for a very big delivery. If a later one fails after an earlier one
  // went through, the pieces already added are kept and the rest are listed to add by hand.
  let written = 0, pcs = 0;
  const left = [];
  for (let i = 0; i < plan.updates.length; i += CHUNK) {
    const part = plan.updates.slice(i, i + CHUNK);
    try {
      if (left.length) throw new Error('skipped');
      await lvPost('/inventory', { inventory_levels: part }, t);
      written += part.length;
    } catch (err) {
      if (!written) throw err;
      left.push(...part.map((u) => u.variant_id));
    }
  }
  if (!left.length) pcs = plan.pcs;
  else {
    const before = new Map(levels.filter((l) => l.store_id === storeId).map((l) => [l.variant_id, Number(l.in_stock) || 0]));
    for (const u of plan.updates) if (!left.includes(u.variant_id)) pcs += u.stock_after - (before.get(u.variant_id) || 0);
    plan.missing.push(`${left.length} more size(s) could not be saved`);
  }
  return { pcs, missing: plan.missing, written };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const staffToken = String(req.headers['x-staff-token'] || '').trim();
  const login = await loginOfToken(staffToken);
  if (!login) return res.status(401).json({ error: 'Please log out and log in again.', needLogin: true });
  if (login !== 'Palladium') return res.status(403).json({ error: 'Only Palladium adds deliveries to Loyverse.' });
  if (!token()) return res.status(500).json({ error: 'The Loyverse token is not set up yet (Vercel setting LOYVERSE_STAFF_TOKEN).' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const orderId = String((body && body.orderId) || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId is missing' });

  let claim;
  try { claim = await askScript('loyverseClaim', { token: staffToken, orderId }); } catch (err) {
    return res.status(502).json({ error: 'Could not reach the order list: ' + err.message });
  }
  if (!claim || claim.success !== true) {
    return res.status(409).json({ error: (claim && claim.error) || 'Could not start', already: !!(claim && claim.already), busy: !!(claim && claim.busy) });
  }

  let result;
  try {
    const done = await addToLoyverse(claim.lines || []);
    result = { ok: true, pcs: done.pcs, missing: done.missing };
  } catch (err) {
    console.error(err);
    result = { ok: false, error: err.message };
  }
  let saved = null;
  try { saved = await askScript('loyverseResult', { token: staffToken, orderId, result }); } catch (err) { console.error(err); }
  const note = saved && saved.success ? saved.loyverse : null;
  if (!result.ok) return res.status(502).json({ error: 'Not added to Loyverse: ' + result.error, loyverse: note || ('Failed: ' + result.error) });
  return res.json({
    success: true, pcs: result.pcs, missing: result.missing,
    loyverse: note || 'Adding',
    warning: note ? '' : 'Added to Loyverse, but the order could not be marked. Please do not add it again.',
  });
};
