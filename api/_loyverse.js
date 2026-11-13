// Loyverse POS helpers: API client, receipts -> daily sales totals, shift pay-ins/pay-outs
// -> expense/collection rows, and the sheet upsert plan.
// Files starting with "_" are not exposed as routes on Vercel.
const { num } = require('./_google');

// Overridable only so the sync can be tested against a fake server locally.
const API = process.env.LOYVERSE_API_URL || 'https://api.loyverse.com/v1.0';
const TAG = 'Loyverse'; // value written to Master Entry column K (Entered By)
const TIMEZONE = process.env.LOYVERSE_TIMEZONE || 'Asia/Bangkok';

// Optional JSON env var: { "Loyverse name": "value" }, matched case-insensitively.
function jsonMap(envName) {
  const raw = process.env[envName];
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`${envName} is not valid JSON`); }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) out[k.trim().toLowerCase()] = v;
  return out;
}

async function lvGet(path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${process.env.LOYVERSE_TOKEN}` } });
    if (resp.status === 429 && attempt < 3) {
      const wait = (parseInt(resp.headers.get('retry-after'), 10) || 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10000)));
      continue;
    }
    if (resp.status === 401) throw new Error('Loyverse rejected the token — create a new one in Back Office → Access tokens');
    if (!resp.ok) throw new Error(`Loyverse ${path} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  }
}

// Follows Loyverse's cursor pagination and returns every item under `key`.
async function lvGetAll(path, key, params) {
  const items = [];
  let cursor;
  for (let page = 0; page < 200; page++) {
    const data = await lvGet(path, { ...params, limit: 250, cursor });
    items.push(...(data[key] || []));
    cursor = data.cursor;
    if (!cursor) return items;
  }
  throw new Error(`Too many pages from Loyverse ${path}`);
}

// ---- dates (all YYYY-MM-DD strings) ----
function localDate(instant, tz = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function localTime(instant, tz = TIMEZONE) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const round2 = (n) => Math.round(n * 100) / 100;

// Loyverse store id -> sheet shop name. Stores are matched to the sheet's shop list by
// name, unless LOYVERSE_STORE_MAP says otherwise ("" or null there = ignore that store).
function mapStores(stores, sheetShops) {
  const overrides = jsonMap('LOYVERSE_STORE_MAP');
  const byLower = new Map(sheetShops.map((s) => [s.toLowerCase(), s]));
  const map = new Map();
  const unmatched = [];
  for (const st of stores) {
    const key = String(st.name || '').trim().toLowerCase();
    if (key in overrides) {
      const target = overrides[key];
      if (!target) continue; // deliberately ignored
      const shop = byLower.get(String(target).trim().toLowerCase());
      if (shop) map.set(st.id, shop);
      else unmatched.push({ store: st.name, reason: `LOYVERSE_STORE_MAP points to "${target}", which is not in the sheet's shop list` });
      continue;
    }
    if (byLower.has(key)) map.set(st.id, byLower.get(key));
    else unmatched.push({ store: st.name, reason: 'no shop with this name in the sheet' });
  }
  return { map, unmatched };
}

// Shop -> its neighbour-card credit account: a credit customer kept at a shop other than
// Palladium (Lists column F). Card payments at that shop go through the neighbour's machine,
// so they are owed by the neighbour, not banked.
function neighbourAccounts(customerShops) {
  const out = {};
  for (const [customer, shop] of Object.entries(customerShops)) if (shop && shop !== 'Palladium') out[shop] = customer;
  return out;
}

// Cash payments go to Cash In, everything else (card, QR, transfer) to Bank In.
// LOYVERSE_PAYMENT_MAP can force a payment type, by name, to "cash", "bank" or "skip".
function paymentKind(p, overrides) {
  const o = overrides[String(p.name || '').trim().toLowerCase()];
  if (o === 'cash' || o === 'bank' || o === 'skip') return o;
  return p.type === 'CASH' ? 'cash' : 'bank';
}

// Sums receipts into one { cash, bank, credit } total per shop per local date; at a shop
// with a neighbour-card account, non-cash payments are credit instead of bank.
// Refunds subtract; cancelled receipts are ignored.
function dailyTotals(receipts, storeShop, dates, accounts = {}, tz = TIMEZONE) {
  const overrides = jsonMap('LOYVERSE_PAYMENT_MAP');
  const totals = new Map();
  const cardRefunds = new Map(); // "date|shop" -> amounts of non-cash refunds
  const warnings = [];
  const skippedPayments = {};
  let mismatched = 0;

  for (const r of receipts) {
    if (r.cancelled_at) continue;
    const date = localDate(r.receipt_date || r.created_at, tz);
    if (!dates.has(date)) continue;
    const shop = storeShop.get(r.store_id);
    if (!shop) continue;

    let cash = 0, bank = 0, card = 0, skipped = 0;
    for (const p of r.payments || []) {
      const amt = num(p.money_amount);
      const kind = paymentKind(p, overrides);
      if (kind === 'cash') cash += amt;
      else if (kind === 'bank') { bank += amt; if (!isQr(p.name || p.type)) card += amt; }
      else { skipped += amt; skippedPayments[p.name] = (skippedPayments[p.name] || 0) + amt; }
    }
    // If payments add up to more than the receipt (e.g. cash handed over before change),
    // trust the receipt total and take the excess off the cash part.
    const excess = cash + bank + skipped - (num(r.total_money) + num(r.tip));
    if (excess > 0.005 && cash > 0) cash -= Math.min(excess, cash);
    else if (Math.abs(excess) > 0.005) mismatched++;

    const sign = r.receipt_type === 'REFUND' ? -1 : 1;
    const key = `${date}|${shop}`;
    if (sign < 0 && bank > 0) cardRefunds.set(key, [...(cardRefunds.get(key) || []), round2(bank)]);
    const t = totals.get(key) || { date, shop, cash: 0, bank: 0, card: 0, credit: 0, account: accounts[shop] || null, receipts: 0, refunds: 0 };
    t.cash += sign * cash;
    // card: the card part of bank (QR / PromptPay excluded), the part the bank takes a fee on
    if (t.account) t.credit += sign * bank; else { t.bank += sign * bank; t.card += sign * card; }
    if (sign < 0) t.refunds++; else t.receipts++;
    totals.set(key, t);
  }

  for (const [name, amt] of Object.entries(skippedPayments)) {
    warnings.push(`"${name}" payments (฿${round2(amt)}) were skipped as set in LOYVERSE_PAYMENT_MAP — record them separately`);
  }
  if (mismatched) warnings.push(`${mismatched} receipt(s) had payments that did not add up to the receipt total`);

  const list = [...totals.values()].map((t) => ({ ...t, cash: round2(t.cash), bank: round2(t.bank), card: round2(t.card), credit: round2(t.credit) }));
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.shop.localeCompare(b.shop)));
  return { totals: list, warnings, cardRefunds };
}

// One line per receipt that has a card / QR part (whatever dailyTotals counts as bank), for
// the "Bicasso card sales" report: { date, time, shop, number, amount, qr, methods, refund }.
// qr is the part paid by QR / PromptPay (amount includes it), so card = amount - qr.
// Refunds come out negative, so the lines add up to the day's Bank In the import wrote.
// A payment type that is QR / PromptPay rather than a card, by its Loyverse name. The shops'
// "SCAN" type is a PromptPay QR scan (owner, 12 Nov 2026).
function isQr(name) { return /\bqr\b|prompt\s*pay|^\s*scan\s*$/i.test(String(name || '')); }

function cardReceipts(receipts, storeShop, dates, tz = TIMEZONE) {
  const overrides = jsonMap('LOYVERSE_PAYMENT_MAP');
  const out = [];
  for (const r of receipts) {
    if (r.cancelled_at) continue;
    const at = r.receipt_date || r.created_at;
    const date = localDate(at, tz);
    if (!dates.has(date)) continue;
    const shop = storeShop.get(r.store_id);
    if (!shop) continue;
    let bank = 0, qr = 0;
    const methods = [];
    for (const p of r.payments || []) {
      if (paymentKind(p, overrides) !== 'bank') continue;
      bank += num(p.money_amount);
      const name = String(p.name || p.type || 'Card').trim();
      if (isQr(name)) qr += num(p.money_amount);
      if (!methods.includes(name)) methods.push(name);
    }
    if (!(bank > 0.005)) continue;
    const refund = r.receipt_type === 'REFUND';
    out.push({ date, time: localTime(at, tz), at: new Date(at).getTime(), shop, number: r.receipt_number || '', amount: round2(refund ? -bank : bank), qr: round2(refund ? -qr : qr), methods, refund });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(({ at, ...x }) => x);
}

// Every sales row the import writes ends its note with the amounts it wrote, e.g.
// "Loyverse · 12 receipts [3000|1500|0]" (cash|bank|credit). If the sheet's amounts no
// longer match that stamp, someone corrected the row by hand, and the import keeps it.
function stampOf(p) { return `[${round2(p.cash)}|${round2(p.bank)}|${round2(p.credit || 0)}]`; }
function readStamp(notes) {
  const m = String(notes || '').match(/\[(-?[\d.]+)\|(-?[\d.]+)\|(-?[\d.]+)\]\s*$/);
  return m ? { cash: +m[1], bank: +m[2], credit: +m[3] } : null;
}

// Decides, per shop-day, whether to add a new row, update the existing Loyverse row,
// or leave the sheet alone — for the day's Retail Sale and, at a shop with a
// neighbour-card account, its Credit Sale. One source per shop-day: if any of that
// day's sales rows was entered by hand, the whole day is left alone.
// recentFrom (YYYY-MM-DD): older Loyverse rows written before the stamp existed are never
// overwritten, because the import can't tell whether they were corrected by hand.
function planSync(totals, existingRows, recentFrom = '') {
  const actions = [];
  for (const t of totals) {
    const base = { date: t.date, shop: t.shop, receipts: t.receipts, refunds: t.refunds };
    const day = existingRows.filter((r) => r.date === t.date && r.shop === t.shop
      && (r.category === 'Retail Sale' || (t.account && r.category === 'Credit Sale' && r.customer === t.account)));
    const manual = day.find((r) => r.enteredBy !== TAG);
    const auto = (category) => day.filter((r) => r.enteredBy === TAG && r.category === category);
    const recent = t.date >= recentFrom;
    actions.push(planRow({ ...base, kind: 'sale', cash: t.cash, bank: t.bank, credit: 0 }, auto('Retail Sale'), manual, 'sales', recent));
    if (t.account) {
      actions.push(planRow({ ...base, kind: 'credit', account: t.account, cash: 0, bank: 0, credit: t.credit }, auto('Credit Sale'), manual, 'neighbour card sales', recent));
    }
  }
  return actions.filter(Boolean);
}

function planRow(p, auto, manual, what, recent = true) {
  const empty = p.cash === 0 && p.bank === 0 && p.credit === 0;
  const total = (x) => fmtBaht(x.cash + x.bank + (x.credit || 0));
  if (manual) {
    // A hand row and a Loyverse row for the same shop-day both count: say so loudly
    if (auto.length) {
      return { ...p, action: 'skip', row: manual.row, reason: `row ${manual.row} (typed by hand) and row ${auto.map((r) => r.row).join(', ')} (Loyverse) both count ${what} for this day — delete one of them` };
    }
    if (empty) return null;
    return { ...p, action: 'skip', row: manual.row, reason: `sales already entered by hand (row ${manual.row}) — delete that row to let Loyverse fill this day` };
  }
  if (p.cash < 0 || p.bank < 0 || p.credit < 0) {
    return { ...p, action: 'skip', reason: `refunds are larger than ${what} — enter this day by hand` };
  }
  if (!auto.length) return empty ? null : { ...p, action: 'add', stamp: stampOf(p) };
  const cur = auto[0];
  const sheet = { cash: round2(cur.cashIn), bank: round2(cur.bankIn), credit: round2(cur.credit) };
  const dupNote = auto.length > 1 ? `duplicate Loyverse rows ${auto.slice(1).map((r) => r.row).join(', ')} — delete them` : undefined;
  if (sheet.cash === p.cash && sheet.bank === p.bank && sheet.credit === p.credit) {
    return { ...p, action: 'unchanged', row: cur.row, reason: dupNote };
  }
  // The row differs from Loyverse. Was it corrected by hand?
  const stamp = readStamp(cur.notes);
  const corrected = stamp ? (stamp.cash !== sheet.cash || stamp.bank !== sheet.bank || stamp.credit !== sheet.credit) : !recent;
  if (corrected) {
    return { ...p, action: 'skip', row: cur.row, kept: true,
      reason: `row ${cur.row} ${stamp ? 'was corrected by hand' : 'may have been corrected by hand'} (sheet ${total(sheet)}, Loyverse ${total(p)}) — kept as it is. To take Loyverse's number instead, delete the row and import again` };
  }
  if (empty) {
    return { ...p, action: 'skip', row: cur.row, reason: `Loyverse now shows no ${what} but row ${cur.row} has some — check and fix by hand` };
  }
  return { ...p, action: 'update', row: cur.row, stamp: stampOf(p), was: { cash: cur.cashIn, bank: cur.bankIn, credit: cur.credit }, reason: dupNote };
}

const fmtBaht = (n) => '฿' + Math.round(n).toLocaleString('en-US');

// ---- pay-ins / pay-outs (shift cash movements) ----

// Categories a drawer pay-out can become; a hand-typed cash row in one of these means the
// owner already entered that shop-day's pay-outs.
const PAYOUT_CATEGORIES = ['Collection (to Palladium)', 'Salary', 'Wages', 'Commission', 'Rent', 'Gov Tax',
  'Home Expenses', 'Supplier Pay', 'Other Expense'];
const BIG_EXPENSE = 5000; // an "Other Expense" this large is probably something else: flag it

// What a pay-in/pay-out becomes in Master Entry, decided from the note staff type in Loyverse.
// Returns { category, cashIn, cashOut, bankIn, customer, note, review } or { refund: true }.
function classifyMovement(m, account) {
  const type = String(m.type || '').toUpperCase().replace(/[^A-Z]/g, '');
  const comment = String(m.comment || '').trim();
  const c = comment.toLowerCase();
  const amount = round2(Math.abs(num(m.money_amount)));
  if (type === 'PAYIN') {
    if (account && c.includes('card')) return { category: 'Customer Payment', customer: account, cashIn: amount, note: comment || 'Card' };
    return { category: 'Adjustment', cashIn: amount, note: `Pay in: ${comment || 'no note'}`, review: 'pay-in with no known reason — check it' };
  }
  if (type !== 'PAYOUT') return null;
  if (/collect|sonu|received by|brought/.test(c)) return { category: 'Collection (to Palladium)', cashOut: amount, note: comment };
  // A salary advance ("Kumar Advance") is salary paid early: Finance → Staff finds it by the
  // word "advance" and the person's name in the note, and keeps track of what they owe.
  if (/salar|advance/.test(c)) return { category: 'Salary', cashOut: amount, note: comment };
  if (c.includes('refund')) return { refund: true, amount, note: comment };
  // Other words staff can put in the note to pick an expense category. Home/house comes
  // before rent: "House rent" is the owner's home, not a shop's rent.
  const byWord = [
    [/\bhome\b|\bhouse\b/, 'Home Expenses'],
    [/\brent/, 'Rent'],
    [/\bwage/, 'Wages'],
    [/commission|bonus/, 'Commission'],
    [/\btax\b|\bgov/, 'Gov Tax'], // \b keeps "taxi" out
    [/supplier|\bstock\b/, 'Supplier Pay'],
  ].find(([re]) => re.test(c));
  if (byWord) return { category: byWord[1], cashOut: amount, note: comment };
  return {
    category: 'Other Expense', cashOut: amount, note: comment || 'no note',
    review: amount >= BIG_EXPENSE ? `large pay-out booked as Other Expense — check the category` : undefined,
  };
}

// Turns shift cash movements into planned Master Entry rows. Each movement is one row; its
// note carries the time it was made, so re-runs find it again instead of adding it twice.
// One source per shop-day: if the owner already typed that day's cash expenses/collections
// (or, for pay-ins, the neighbour's payment) by hand, Loyverse leaves them alone.
function planMovements(shifts, storeShop, dates, accounts, cardRefunds, existingRows, tz = TIMEZONE) {
  const planned = [];
  const warnings = [];
  const refundsLeft = new Map([...cardRefunds].map(([k, v]) => [k, [...v]]));
  for (const s of shifts) {
    const shop = storeShop.get(s.store_id);
    if (!shop) continue;
    for (const m of s.cash_movements || []) {
      const at = m.created_at || s.opened_at;
      const date = localDate(at, tz);
      if (!dates.has(date)) continue;
      const time = localTime(at, tz);
      const account = accounts[shop] || null;
      const cls = classifyMovement(m, account);
      if (!cls) { warnings.push(`${shop} ${date} ${time}: unknown cash movement "${m.type}" ฿${num(m.money_amount)} — not imported`); continue; }
      const base = { kind: 'movement', date, shop, time };
      if (cls.refund) {
        const key = `${date}|${shop}`;
        const left = refundsLeft.get(key) || [];
        const i = account ? -1 : left.indexOf(cls.amount);
        if (i >= 0) {
          left.splice(i, 1);
          // The refund was rung up as card/QR (so the sales import took it off the bank) but
          // was really paid from the drawer: move it back from bank to cash.
          planned.push({ ...base, category: 'Adjustment', cashOut: cls.amount, bankIn: cls.amount, note: `Refund paid from the drawer (rung up as card/QR) · ${time}` });
        } else {
          planned.push({ ...base, category: 'Adjustment', cashOut: cls.amount, note: `${cls.note} · ${time}`, action: 'skip', reason: `refund ฿${cls.amount} paid from the drawer — check how it was refunded and enter it by hand` });
        }
        continue;
      }
      planned.push({ ...base, ...cls, note: `${cls.note} · ${time}` });
    }
  }

  const sameDay = (p) => existingRows.filter((r) => r.date === p.date && r.shop === p.shop);
  const handPayouts = (p) => sameDay(p).find((r) => r.enteredBy !== TAG && PAYOUT_CATEGORIES.includes(r.category) && r.cashOut > 0);
  const handPayins = (p) => sameDay(p).find((r) => r.enteredBy !== TAG && r.category === 'Customer Payment' && r.customer === p.customer && r.cashIn > 0);
  const amountsOf = (x) => [round2(x.cashIn || 0), round2(x.bankIn || 0), round2(x.cashOut || 0)].join('/');
  // A movement is found again by its day, shop and note (the note ends with the time it was
  // made), not by its amounts — so a row whose amount or category was corrected by hand is
  // recognised and kept, instead of a second copy being added next to it.
  const idOf = (x) => [x.date, x.shop, x.notes ?? x.note].join('|');
  const existingById = new Map();
  for (const r of existingRows) {
    if (r.enteredBy !== TAG || !PAYOUT_CATEGORIES.concat(['Customer Payment', 'Adjustment']).includes(r.category)) continue;
    if (!existingById.has(idOf(r))) existingById.set(idOf(r), []);
    existingById.get(idOf(r)).push(r);
  }

  const actions = planned.map((p) => {
    if (p.action) return p;
    const found = (existingById.get(idOf(p)) || []).shift();
    const hand = p.category === 'Customer Payment' ? handPayins(p) : handPayouts(p);
    if (hand) {
      if (found) return { ...p, action: 'skip', row: hand.row, reason: `row ${hand.row} (typed by hand) and row ${found.row} (Loyverse) may both record the same money — check for double counting` };
      return { ...p, action: 'skip', row: hand.row, reason: `already entered by hand (row ${hand.row})` };
    }
    if (!found) return { ...p, action: 'add' };
    if (found.category === p.category && amountsOf(found) === amountsOf(p)) return { ...p, action: 'unchanged', row: found.row };
    return { ...p, action: 'skip', row: found.row, kept: true, reason: `row ${found.row} was corrected by hand — kept as it is` };
  });
  actions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.shop.localeCompare(b.shop) || a.time.localeCompare(b.time)));
  return { actions, warnings };
}

// Card fees. The bank pays card sales in less its fee (one deposit a day, QR money comes in
// whole), so each day the import also writes a "Card Fee" row with the estimated fee as Bank
// Out. Bank then shows what actually arrives, the sale itself stays at full value, and the fee
// counts as an expense. The rate is an estimate (see api/_cardfees.js learnedRate); the note
// says so and ends with "[fee X]", the amount written, so a fee corrected by hand is kept.
const FEE_CATEGORY = 'Card Fee';
const FEE_SHOPS = (process.env.CARD_FEE_SHOPS || 'Bicasso 1,Bicasso 2').split(',').map((s) => s.trim()).filter(Boolean);
function readFeeStamp(notes) {
  const m = String(notes || '').match(/\[fee (-?[\d.]+)\]\s*$/);
  return m ? +m[1] : null;
}

// totals: from dailyTotals. rate: fee % (e.g. 2.89). Returns movement-shaped actions
// ({ kind: 'movement', category: 'Card Fee', bankOut, action, ... }) for loyverse-sync.
function planFees(totals, existingRows, rate, shops = FEE_SHOPS) {
  const pct = round2(rate);
  const actions = [];
  for (const t of totals) {
    if (!shops.includes(t.shop) || t.account) continue;
    const card = round2(t.card || 0);
    const fee = round2((card * pct) / 100);
    const p = {
      kind: 'movement', date: t.date, shop: t.shop, time: '23:59', category: FEE_CATEGORY, bankOut: fee, card, rate: pct,
      note: `Card fee (estimate) ${pct}% of card sales ${fmtBaht(card)} · QR has no fee [fee ${fee}]`,
    };
    const day = existingRows.filter((r) => r.date === t.date && r.shop === t.shop && r.category === FEE_CATEGORY);
    const hand = day.find((r) => r.enteredBy !== TAG);
    const auto = day.filter((r) => r.enteredBy === TAG);
    if (hand) {
      if (auto.length) actions.push({ ...p, action: 'skip', row: hand.row, reason: `card fee in row ${hand.row} (typed by hand) and row ${auto[0].row} (Loyverse) — delete one of them` });
      else if (fee) actions.push({ ...p, action: 'skip', row: hand.row, kept: true, reason: `card fee already entered by hand (row ${hand.row})` });
      continue;
    }
    if (fee < 0) { actions.push({ ...p, action: 'skip', reason: 'card refunds are larger than card sales — enter the card fee by hand' }); continue; }
    if (!auto.length) { if (fee > 0) actions.push({ ...p, action: 'add' }); continue; }
    const cur = auto[0];
    const sheet = round2(cur.bankOut);
    const dup = auto.length > 1 ? `duplicate card fee rows ${auto.slice(1).map((r) => r.row).join(', ')} — delete them` : undefined;
    if (sheet === fee) { actions.push({ ...p, action: 'unchanged', row: cur.row, reason: dup }); continue; }
    const stamp = readFeeStamp(cur.notes);
    if (stamp === null || stamp !== sheet) {
      actions.push({ ...p, action: 'skip', row: cur.row, kept: true, reason: `card fee in row ${cur.row} was changed by hand (${fmtBaht(sheet)}) — kept as it is` });
      continue;
    }
    actions.push({ ...p, action: 'update', row: cur.row, was: { bankOut: sheet }, reason: dup });
  }
  return actions;
}

// Used by the manual entry endpoints: once Loyverse has filled a shop-day's pay-outs, a
// hand-typed cash expense or collection for it is probably the same money again. Returns a
// message to confirm (the caller lets the owner save anyway), or null. Bank-paid expenses
// never come from the drawer, so they are not checked.
function payoutClash(existingRows, entries) {
  for (const e of entries) {
    if (!PAYOUT_CATEGORIES.includes(e.category) || !(num(e.cashOut) > 0)) continue;
    const imported = existingRows.filter((r) => r.enteredBy === TAG && r.date === e.date && r.shop === e.shop && PAYOUT_CATEGORIES.includes(r.category));
    if (imported.length) {
      const [y, m, d] = e.date.split('-');
      const list = imported.slice(0, 6).map((r) => `${r.notes.replace(/ · \d\d:\d\d$/, '')} ฿${r.cashOut}`).join(', ');
      return `Loyverse already recorded ${imported.length} pay-out${imported.length === 1 ? '' : 's'} for ${e.shop} on ${+d}/${+m}/${y}: ${list}. Save your entries anyway?`;
    }
  }
  return null;
}

// Used by the manual entry endpoints: once Loyverse has filled a shop-day's sales, refuses
// hand-typed sales rows for it — a Retail Sale, or a Credit Sale at a shop other than
// Palladium (only neighbour-card accounts live there) — so nothing is counted twice.
function loyverseClash(existingRows, entries) {
  for (const e of entries) {
    const neighbourCard = e.category === 'Credit Sale' && e.shop !== 'Palladium';
    if (e.category !== 'Retail Sale' && !neighbourCard) continue;
    const hit = existingRows.find((r) => r.enteredBy === TAG && r.date === e.date && r.shop === e.shop
      && (r.category === 'Retail Sale' || r.category === 'Credit Sale'));
    if (hit) {
      const [y, m, d] = e.date.split('-');
      return `${e.shop} sales for ${+d}/${+m}/${y} were already imported from Loyverse (row ${hit.row}). Leave Sales empty and save only expenses, collection and neighbour payments.`;
    }
  }
  return null;
}

module.exports = { TAG, TIMEZONE, lvGetAll, localDate, addDays, mapStores, neighbourAccounts, dailyTotals, cardReceipts, isQr, planSync, planMovements, planFees, FEE_CATEGORY, FEE_SHOPS, loyverseClash, payoutClash };
