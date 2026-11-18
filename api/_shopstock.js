// Shop stock from Loyverse, in the staff app's shape. Since 18 Nov 2026 Loyverse is the only stock
// record for the shops: Bicasso 1 + Bicasso 2 share the store "Burmelin" (one stock number, a till
// each), Nana is the store "BICASSO 3 Nana". Palladium (the warehouse) keeps its own stock in the
// Stock sheet. Everything here is pure (no network) so it can be tested.
//
// A Loyverse item is turned into Palladium's product / colour / size like this:
//   "4002 Cotton Shirt", options Colour 1 + Size M     -> 4002, colour 1, size M
//   "T9027-43 Pant", option Size 50 (one item a colour) -> T9027, colour 43, size 50
//   anything else (one stock number for the item)     -> a "total only" line
//   "... (Nana old stock)"                             -> a "total only" line, marked old
// The item NAME and its options decide, never the SKU: split items' SKUs run the parts together
// (FL1167129 could be colour 1 size 29 or colour 12 size 9).
const { localDate, localTime, mapDevices } = require('./_loyverse');

// Old product numbers -> the number Palladium uses (owner, 16-18 Nov 2026).
// LOYVERSE_CODE_MAP (JSON, {"OLD":"NEW"}) adds to or replaces these.
const CODE_MAP = { S152: 'B152', F9027: 'T9027', FD9039: 'T9039' };

function codeMap() {
  const out = { ...CODE_MAP };
  if (process.env.LOYVERSE_CODE_MAP) {
    let extra;
    try { extra = JSON.parse(process.env.LOYVERSE_CODE_MAP); } catch (e) { throw new Error('LOYVERSE_CODE_MAP is not valid JSON'); }
    for (const [k, v] of Object.entries(extra)) out[String(k).trim().toUpperCase()] = String(v).trim().toUpperCase();
  }
  return out;
}

const clean = (v) => String(v == null ? '' : v).trim();

// One Loyverse item + one of its variants -> { kind, pid, col, sz, name }
//   kind 'sized' (has colour and size), 'total' (one number), 'old' (Nana old stock), 'other' (no product code)
function parseVariant(item, variant, map = codeMap()) {
  const name = clean(item.item_name);
  const first = name.split(/\s+/)[0].toUpperCase();
  const hasCode = /\d/.test(first);
  const opts = [1, 2, 3].map((i) => ({ name: clean(item[`option${i}_name`]).toLowerCase(), value: clean(variant && variant[`option${i}_value`]) }));
  const colour = opts.find((o) => /colou?r/.test(o.name) && o.value);
  const size = opts.find((o) => /size/.test(o.name) && o.value);
  const mapped = (code) => map[code] || code;

  if (/\(nana old stock\)/i.test(name)) return { kind: 'old', pid: hasCode ? mapped(first) : name, name };
  if (!hasCode) return { kind: 'other', pid: name, name };
  if (colour && size) return { kind: 'sized', pid: mapped(first), col: colour.value, sz: size.value, name };
  const split = /^(.*\d.*?)-(\d+#?)$/.exec(first);   // T9027-43, B01-2, F1165-3#
  if (split && size && !colour) return { kind: 'sized', pid: mapped(split[1]), col: split[2], sz: size.value, name };
  return { kind: 'total', pid: mapped(split ? split[1] : first), name };
}

// variant_id -> parsed variant, for every variant of every item
function variantIndex(items, map = codeMap()) {
  const idx = new Map();
  for (const item of items || []) {
    if (item.deleted_at) continue;
    for (const v of item.variants || []) idx.set(v.variant_id, parseVariant(item, v, map));
  }
  return idx;
}

// levels: GET /inventory rows for ONE store ({ variant_id, in_stock }).
// Returns { sized: { pid: { 'Color c': { size: qty } } }, totals: [{ pid, name, kind, qty }] }.
// "sized" has the same shape the app already uses for a shop's stock sheet.
function buildStock(idx, levels) {
  const sized = {};
  const totals = new Map();   // name -> line
  for (const lv of levels || []) {
    const p = idx.get(lv.variant_id);
    if (!p) continue;
    const qty = Math.round(Number(lv.in_stock) || 0);
    if (p.kind === 'sized') {
      const ck = 'Color ' + p.col;
      sized[p.pid] = sized[p.pid] || {};
      sized[p.pid][ck] = sized[p.pid][ck] || {};
      sized[p.pid][ck][p.sz] = (sized[p.pid][ck][p.sz] || 0) + qty;
    } else {
      const line = totals.get(p.name) || { pid: p.pid, name: p.name, kind: p.kind, qty: 0 };
      line.qty += qty;
      totals.set(p.name, line);
    }
  }
  const list = [...totals.values()].filter((l) => l.qty !== 0).sort((a, b) => a.pid.localeCompare(b.pid));
  return { sized, totals: list };
}

// Receipts -> one line per item sold (refunds negative), newest first.
// shopOf(receipt) names the shop (Bicasso 1 / Bicasso 2 / Bicasso Nana).
function salesLines(receipts, idx, shopOf, tz) {
  const map = codeMap();
  const out = [];
  for (const r of receipts || []) {
    if (r.cancelled_at) continue;
    const sign = r.receipt_type === 'REFUND' ? -1 : 1;
    const at = r.receipt_date || r.created_at;
    for (const li of r.line_items || []) {
      const p = idx.get(li.variant_id) || parseVariant({ item_name: li.item_name }, null, map);
      const qty = sign * (Number(li.quantity) || 0);
      if (!qty) continue;
      out.push({
        day: localDate(at, tz), time: localTime(at, tz), at, shop: shopOf(r) || '',
        pid: p.pid, col: p.col || '', sz: p.sz || '', kind: p.kind, name: p.name || clean(li.item_name),
        variant: clean(li.variant_name), qty, receipt: clean(r.receipt_number),
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// The two shop stores and which staff-app shop each till belongs to.
const STORES = { burmelin: 'Burmelin', nana: 'BICASSO 3 Nana' };
const STORE_SHOP = { burmelin: 'Bicasso 1', nana: 'Bicasso Nana' };   // a till not named below
function storeIds(stores) {
  const names = { ...STORES };
  if (process.env.LOYVERSE_STAFF_STORES) {
    try { Object.assign(names, JSON.parse(process.env.LOYVERSE_STAFF_STORES)); } catch (e) { throw new Error('LOYVERSE_STAFF_STORES is not valid JSON'); }
  }
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    const st = (stores || []).find((s) => clean(s.name).toLowerCase() === clean(name).toLowerCase());
    if (st) out[key] = st.id;
  }
  return out;
}
// Till -> shop: "B2 POS" is Bicasso 2 (same rule as Finance, see mapDevices); others stay with the store
function tillShops(devices) {
  return mapDevices(devices, ['Bicasso 1', 'Bicasso 2', 'Bicasso Nana']).map;
}

module.exports = { CODE_MAP, codeMap, parseVariant, variantIndex, buildStock, salesLines, STORES, STORE_SHOP, storeIds, tillShops };
