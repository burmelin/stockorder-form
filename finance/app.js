/* Burmelin Finance mobile app */

// ---- money field definitions per category (kept in sync with api/transaction.js) ----
const RULES = {
  'Retail Sale':               { fields: ['cashIn', 'bankIn'],  hint: 'Cash sales in Cash In, card/QR sales in Bank In. One row per shop per day.' },
  'Bank Received':             { fields: ['bankIn'],            hint: 'Money that arrived directly in the bank account.' },
  'Scan / QR Payment':         { fields: ['bankIn'],            hint: 'QR payment received at the shop (goes to the shared bank).' },
  'Credit Sale':               { fields: ['creditAmount'],      hint: 'Palladium → customer: goods given on credit, their debt goes UP. No cash moves now.' },
  'Customer Payment':          { fields: ['cashIn', 'bankIn'],  hint: 'Customer → Palladium: they pay their debt DOWN. Cash In if cash, Bank In if transfer.' },
  'Credit Opening Balance':    { fields: ['creditAmount'],      hint: 'The debt a customer ALREADY owes when you start tracking. Sets their starting balance (recorded as a credit sale, noted “Opening balance”).' },
  'Supplier Pay':              { fields: ['cashOut', 'bankOut'], hint: 'Paying for stock/production. Use whichever account it left from.' },
  'Salary':                    { fields: ['cashOut', 'bankOut'], hint: 'Monthly staff salary. If paid from collected cash, use Shop = Palladium.' },
  'Wages':                     { fields: ['cashOut', 'bankOut'], hint: 'Daily helpers or casual staff.' },
  'Commission':                { fields: ['cashOut', 'bankOut'], hint: 'Staff performance bonuses.' },
  'Rent':                      { fields: ['cashOut', 'bankOut'], hint: 'Shop, warehouse or office rent.' },
  'Gov Tax':                   { fields: ['cashOut', 'bankOut'], hint: 'Government taxes and fees.' },
  'Home Expenses':             { fields: ['cashOut', 'bankOut'], hint: 'Personal / home spending taken from the business.' },
  'Other Expense':             { fields: ['cashOut', 'bankOut'], hint: 'Small daily costs — tea, water, electricity…' },
  'Card Fee':                  { fields: ['bankOut'],           hint: 'The bank’s fee on card sales. The Loyverse import adds it for Bicasso every day (an estimate); change it here only if you know the real fee.' },
  'Collection (to Palladium)': { fields: ['cashOut'],           hint: 'You physically take cash FROM this shop’s drawer to Palladium. Shop = the shop you collected from. The dashboard adds it to Palladium automatically.' },
  'Cash to Bank Deposit':      { fields: ['cashOut', 'bankIn'], hint: 'Depositing drawer cash into the bank: fill BOTH Cash Out and Bank In with the same amount.' },
  'Bank to Cash (ATM)':        { fields: ['cashIn', 'bankOut'], hint: 'ATM withdrawal into a shop’s till: fill BOTH Cash In and Bank Out.' },
  'Collection to Bank':        { fields: ['cashOut', 'bankIn'], hint: 'Collected cash at Palladium deposited to the bank: fill BOTH Cash Out and Bank In.' },
  'Opening Balance':           { fields: ['cashIn', 'bankIn'],  hint: 'Only when setting up a shop for the first time.' },
  'Adjustment':                { fields: ['cashIn', 'bankIn', 'cashOut', 'bankOut'], hint: 'Fix a mismatch. If the real amount is HIGHER than the app, add it in Cash In / Bank In. If it is LOWER, put the difference in Cash Out / Bank Out. Always explain why in Notes.' },
};
const NEEDS_CUSTOMER = ['Credit Sale', 'Customer Payment', 'Credit Opening Balance'];
const FIELD_LABELS = {
  cashIn: 'Cash In', bankIn: 'Bank In', cashOut: 'Cash Out', bankOut: 'Bank Out', creditAmount: 'Credit Sale Amount',
};

const $ = (id) => document.getElementById(id);
let LISTS = null;
let CREDIT = [];

// Credit rows belong to the customer's shop (Lists column F): Palladium, except Nana's
// neighbour-card account, whose card sales and repayments both happen at Nana.
function customerShop(name) { return (LISTS && LISTS.customerShops && LISTS.customerShops[name]) || 'Palladium'; }
function neighbourAccount(shop) {
  if (!LISTS || shop === 'Palladium') return null;
  return (LISTS.customers || []).find((c) => customerShop(c) === shop) || null;
}

// ---- Who may open Finance ----
// Signed in to the staff app through its admin login ("Settings")? Its token, kept by the
// staff app on this same site, is the only way into Finance. Shop logins don't count.
function ownerToken() {
  try {
    const s = JSON.parse(localStorage.getItem('burmelin_session') || 'null');
    return s && s.isOwner && s.token ? String(s.token) : '';
  } catch (e) { return ''; }
}
// No owner login on this phone (or it ran out): show how to sign in, instead of the app.
function showOwnerGate() {
  $('ownerGate').hidden = false;
  $('shell').hidden = true;
}
async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  const owner = ownerToken();
  if (owner) opts.headers['x-owner-token'] = owner;
  const resp = await fetch(path, opts);
  if (resp.status === 401) {
    showOwnerGate();
    throw new Error('Owner login required');
  }
  return resp;
}

// The owner login lasts 30 days from when it was last renewed, and the staff app renews it
// when it's used. Someone who only opens Finance would be signed out after 30 days, so Finance
// renews it too, at most once a day, by asking the staff app's server.
const OFFICE_API = 'https://script.google.com/macros/s/AKfycby-5YfvPpePbg1ni36sL5AI-DelH_I5qHgm1mkmAKqBSsopJPn-YWi24kXDMPMFkD-v/exec';
async function renewOwnerToken() {
  try {
    const s = JSON.parse(localStorage.getItem('burmelin_session') || 'null');
    if (!s || !s.isOwner || !s.token) return;
    const issued = JSON.parse(atob(String(s.token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).t;
    if (!(Date.now() - issued > 86400000)) return;
    const resp = await fetch(OFFICE_API, { method: 'POST', body: JSON.stringify({ action: 'verifyOwner', token: s.token }) });
    const data = await resp.json();
    if (data && data._token) {
      s.token = data._token;
      localStorage.setItem('burmelin_session', JSON.stringify(s));
    }
  } catch (e) { /* offline or an old token: the next request says if a login is needed */ }
}

// Saves through the API; when the server asks for confirmation (e.g. Loyverse already
// imported that day's pay-outs) the owner decides, and a yes resends with confirmDuplicates.
async function saveJSON(path, method, body) {
  let resp = await api(path, { method, body: JSON.stringify(body) });
  let data = await resp.json();
  if (resp.status === 409 && data.needsConfirm) {
    // Typing YES (not just tapping OK) so a duplicate is never saved by accident
    const answer = prompt(`${data.error}\n\nThis may count the same money twice. Type YES to save anyway.`);
    if (String(answer || '').trim().toUpperCase() !== 'YES') throw new Error('Not saved — nothing was changed');
    resp = await api(path, { method, body: JSON.stringify({ ...body, confirmDuplicates: true }) });
    data = await resp.json();
  }
  if (!resp.ok) throw new Error(data.error || 'Server error');
  return data;
}

// ---- formatting ----
const fmt = (n) => '฿' + Math.round(n).toLocaleString('en-US');

// ---- tabs: Home · Add (day sheet / one-off entry) · Staff · Reports ----
const PAGES = ['dashboard', 'daily', 'record', 'detail', 'commission', 'statement'];
function showPage(id) {
  PAGES.forEach((p) => { $('page-' + p).hidden = p !== id; });
  $('page-' + id).scrollTop = 0;
}
function setTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
}
// Leaving the one-off form while editing drops the edit
function dropEdit() {
  if (editingRow === null) return;
  editingRow = null;
  editingTx = null;
  $('deleteBtn').hidden = true;
  $('saveBtn').textContent = 'Save Transaction';
  $('editBanner').hidden = true;
  $('fCategory').value = '';
  $('amountFields').innerHTML = '';
  $('ruleHint').textContent = '';
  $('fNotes').value = '';
  $('fDate').value = todayLocalISO();
  $('rowCustomer').hidden = true;
  $('rowShop').hidden = false;
}
let addSub = 'daily';   // which half of Add was open last
function openAdd(sub) {
  addSub = sub;
  showPage(sub);
  if (sub === 'daily') refreshSavedDots();
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    dropEdit();
    const page = btn.dataset.page;
    setTab(page);
    if (page === 'dashboard') showPage('dashboard');
    if (page === 'add') openAdd(addSub);
    if (page === 'staff') openCommission(COMM ? COMM.month : thisMonth());
    if (page === 'statement') { showPage('statement'); openStatement(); }
  });
});
document.querySelectorAll('.seg [data-sub]').forEach((b) => {
  b.addEventListener('click', () => { dropEdit(); openAdd(b.dataset.sub); });
});

// ---- dashboard ----
async function loadDashboard() {
  const load = $('loadState');
  load.hidden = false; load.classList.remove('error'); load.textContent = 'Loading…';
  $('dashContent').hidden = true;
  try {
    const resp = await api('/api/dashboard');
    if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
    const d = await resp.json();
    LISTS = d.lists;
    CREDIT = d.credit || [];
    // The Loyverse import only shows once LOYVERSE_TOKEN is set on the server.
    $('lvCard').hidden = !d.loyverse;
    $('dSalesHint').textContent = d.loyverse ? 'only for shops not on Loyverse' : 'retail sale for the day';
    // With Loyverse on, drawer pay-outs/pay-ins import by themselves too.
    $('dCollectionHint').textContent = d.loyverse ? 'imported from Loyverse pay-outs' : 'cash taken to Palladium';
    $('dExpensesHint').textContent = d.loyverse ? 'only bank-paid, or missing in Loyverse' : 'add as many as you need';
    $('dNeighbourHint').textContent = d.loyverse ? "imported from Loyverse 'Card' pay-ins" : 'cash for earlier card sales';
    renderDashboard(d);
    renderSyncStatus(d);
    populateForm();
    initBankCard();
    refreshSavedDots();
    load.hidden = true;
    $('dashContent').hidden = false;
  } catch (err) {
    load.classList.add('error');
    load.textContent = 'Could not load: ' + err.message;
  }
}

let DASH = null;
let showAllCustomers = false;
function renderDashboard(d) {
  DASH = d;
  $('mockBanner').hidden = !d.mock;
  $('totalCash').textContent = fmt(d.totals.cash);
  $('totalBank').textContent = fmt(d.totals.bank);
  $('totalGrand').textContent = fmt(d.totals.grand);
  $('heroCredit').textContent = fmt(d.totalCredit);
  $('drawerTotal').textContent = fmt(d.shops.reduce((n, s) => n + s.cash, 0));

  $('shopList').innerHTML = d.shops.map((s) => `
    <li><div class="row tappable" data-shop="${esc(s.name)}">
      <span class="name">${esc(s.name)}</span>
      <span class="amount ${s.cash < 0 ? 'neg' : 'pos'}">${fmt(s.cash)}<span class="chevron">›</span></span>
    </div></li>`).join('');

  renderCredit();
  $('totalCredit').textContent = fmt(d.totalCredit);
  $('updatedAt').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
}

// "Last Loyverse import" line on Home. Red when the last run failed, or when nothing has run
// for over a day and a half (the job runs every morning at 6:00), so a missed day is noticed.
function renderSyncStatus(d) {
  const el = $('syncStatus');
  el.hidden = !d.loyverse;
  if (!d.loyverse) return;
  const s = d.lastSync;
  if (!s) { el.className = 'sync-status'; el.textContent = 'Loyverse import: no run recorded yet'; return; }
  const when = new Date(s.when);
  const hours = (Date.now() - when.getTime()) / 3600000;
  const stale = !(hours < 36);
  const at = when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let text = `Last Loyverse import: ${at} · `;
  if (!s.ok) text += `FAILED: ${s.message} · open Add → Day sheet → Check Loyverse to retry`;
  else text += `OK${s.added || s.updated ? ` (${s.added} added, ${s.updated} updated)` : ''}${s.message && s.message !== 'nothing new' ? ` · ${s.message}` : ''}`;
  if (s.ok && stale) text += ' · no import for over a day: check it ran';
  el.className = 'sync-status' + (!s.ok || stale ? ' bad' : '');
  el.textContent = text;
}

// Credit customers: the overdue ones with the most money owed first, three on Home until
// "All customers" is tapped.
function renderCredit() {
  const items = DASH.credit.map((c) => {
    let sub = 'no payment recorded';
    let overdue = true;
    let wait = Infinity;
    if (c.daysSince !== null && c.daysSince !== undefined) {
      sub = c.daysSince === 0 ? 'paid today' : `last paid ${c.daysSince} day${c.daysSince === 1 ? '' : 's'} ago`;
      overdue = c.daysSince > (c.overdueDays || 30);
      wait = c.daysSince;
    }
    if (c.balance === 0) { sub = 'settled'; overdue = false; }
    return { c, sub, overdue, wait };
  });
  const overdue = items.filter((x) => x.overdue).sort((a, b) => b.c.balance - a.c.balance || b.wait - a.wait);
  const short = !showAllCustomers && overdue.length > 0 && items.length > 3;
  const shown = short ? overdue.slice(0, 3) : items;
  $('overduePill').hidden = !overdue.length;
  $('overduePill').textContent = `${overdue.length} overdue`;
  $('creditTitle').textContent = short ? 'Chase these first' : 'Credit customers';
  $('creditToggle').hidden = !(overdue.length > 0 && items.length > 3);
  $('creditToggle').textContent = short ? `All ${items.length} customers ›` : 'Overdue only';
  $('creditTotalRow').hidden = short;
  $('creditList').innerHTML = shown.map(({ c, sub, overdue: od }) => `
    <li><div class="row tappable" data-customer="${esc(c.name)}">
      <span class="name">${esc(c.name)}<span class="sub ${od ? 'overdue' : ''}">${sub}</span></span>
      <span class="amount ${c.balance < 0 ? 'neg' : 'pos'}">${fmt(c.balance)}<span class="chevron">›</span></span>
    </div></li>`).join('');
}
$('creditToggle').addEventListener('click', () => { showAllCustomers = !showAllCustomers; renderCredit(); });

function esc(s) { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; }

$('refreshBtn').addEventListener('click', () => { TX = null; loadDashboard(); });

// ---- Bicasso bank sales: card / QR money from the Retail Sale rows (Bank In) of
// Bicasso 1 and 2, for the dates picked. Defaults to this month so far. The bank's card
// deposit goes to someone else's account and is only checked now and then, so each day's
// bank-in is estimated: card sales less the fee rate learned from the days checked (typed by
// the owner, "Bank Deposits" tab; see api/_cardfees.js). ----
const BANK_SHOPS = ['Bicasso 1', 'Bicasso 2'];
// Does the bank's card deposit also pay the QR / PromptPay money? If not, QR arrives on its
// own and the fee is worked out on card sales only.
const DEPOSIT_WITH_QR = false;
// KBank's dearest card (foreign platinum+, 3.15%) plus 7% VAT: a fee above this is wrong
const MAX_FEE_PCT = 3.15 * 1.07, MIN_FLAG_BAHT = 20;
const fmt2 = (n) => (n < 0 ? '−฿' : '฿') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n == null ? '—' : `${n.toFixed(2)}%`);
let BANK_DEPOSITS = {};
let BANK_RATE = { rate: 2.89, days: 0 };   // replaced by the server's learned rate
let BANK_QR = new Map();      // date -> that day's QR / Scan receipts (each lands in the bank on its own)
let BANK_SPLIT = new Map();   // date -> { card, qr } from the Loyverse receipts
let BANK_SEQ = 0;
function initBankCard() {
  if (!$('bankFrom').value) {
    const now = new Date();
    $('bankFrom').value = isoOf(new Date(now.getFullYear(), now.getMonth(), 1));
    $('bankTo').value = isoOf(now);
  }
  loadBankCard();
}
const daySales = (sp) => Math.round((DEPOSIT_WITH_QR ? sp.card + sp.qr : sp.card) * 100) / 100;
// Same rules as feeSummary in api/_cardfees.js (tested there): change both together
function bankFees(dates) {
  const rate = BANK_RATE.rate;
  const rows = dates.map((date) => {
    const sp = BANK_SPLIT.get(date);
    const dep = BANK_DEPOSITS[date];
    const received = dep ? dep.amount : null;
    if (!sp) return { date, sales: null, received, fee: null, pct: null, expected: null, flag: '' };
    const sales = daySales(sp);
    const fee = received == null ? null : Math.round((sales - received) * 100) / 100;
    const r = { date, card: sp.card, qr: sp.qr, sales, received, fee, pct: received == null || !(sales > 0) ? null : (fee / sales) * 100 };
    r.expected = sales * (1 - rate / 100);
    r.flag = '';
    if (received != null) {
      if (fee < -0.5) r.flag = 'more';
      else if (received < sales * (1 - MAX_FEE_PCT / 100) - MIN_FLAG_BAHT) { r.flag = 'short'; r.short = sales * (1 - MAX_FEE_PCT / 100) - received; }
    }
    return r;
  });
  return new Map(rows.map((r) => [r.date, r]));
}
async function loadBankCard() {
  const r = { from: $('bankFrom').value || null, to: $('bankTo').value || null };
  if (r.from && r.to && r.from > r.to) {
    $('bankList').innerHTML = '<li><div class="row"><span class="name sub overdue">The first date must be before the second</span></div></li>';
    $('bankTotal').textContent = '—'; $('bankDays').textContent = ''; $('bankDaily').hidden = true; $('bankFees').hidden = true;
    return;
  }
  $('bankList').innerHTML = '<li><div class="row"><span class="name sub">Loading…</span></div></li>';
  let tx;
  // Deposits and the card / QR split load alongside; the sales show even if they fail.
  const extras = loadBankExtras(r);
  try { tx = await loadTx(); } catch (err) {
    $('bankList').innerHTML = `<li><div class="row"><span class="name sub overdue">Could not load: ${esc(err.message)}</span></div></li>`;
    return;
  }
  const rows = tx.filter((t) => t.category === 'Retail Sale' && BANK_SHOPS.includes(t.shop) && t.bankIn && inRange(t.date, r));
  const byShop = Object.fromEntries(BANK_SHOPS.map((s) => [s, 0]));
  const byDay = new Map();
  for (const t of rows) {
    byShop[t.shop] += t.bankIn;
    const d = byDay.get(t.date) || Object.fromEntries(BANK_SHOPS.map((s) => [s, 0]));
    d[t.shop] += t.bankIn;
    byDay.set(t.date, d);
  }
  const total = BANK_SHOPS.reduce((n, s) => n + byShop[s], 0);
  $('bankList').innerHTML = BANK_SHOPS.map((s) => `
    <li><div class="row"><span class="name">${esc(s)}</span><span class="amount">${fmt(byShop[s])}</span></div></li>`).join('');
  $('bankTotal').textContent = fmt(total);
  $('bankDays').textContent = byDay.size ? `${byDay.size} day${byDay.size === 1 ? '' : 's'} with card sales` : 'no card sales in these dates';
  const seq = ++BANK_SEQ;   // the dates can change again before this finishes
  BANK_DAYS = new Map([...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)));
  BANK_SPLIT = new Map(); BANK_DEPOSITS = {}; BANK_QR = new Map();
  renderBankDays();
  const x = await extras;
  if (seq !== BANK_SEQ) return;
  BANK_DEPOSITS = x.deposits; BANK_SPLIT = x.split; BANK_RATE = x.rate; BANK_QR = x.qr;
  renderBankDays(x.note);
}
// The bank deposits for the dates, and every card / QR receipt (to split card from QR).
// Returns a note to show if something couldn't be loaded.
async function loadBankExtras(r) {
  const from = r.from || isoOf(new Date()), to = r.to || isoOf(new Date());
  const notes = [];
  let deposits = {}, rate = BANK_RATE;
  const deps = api(`/api/bank-deposits?from=${from}&to=${to}`).then(async (resp) => {
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server error');
    deposits = data.deposits || {};
    if (data.rate > 0) rate = { rate: data.rate, days: data.rateDays || 0 };
  }).catch((err) => notes.push(`Could not load the checked bank deposits: ${err.message}`));
  const splitMap = new Map(), qrMap = new Map();
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  const split = days > 30
    ? Promise.resolve(notes.push('Pick 31 days or fewer to see card vs QR and the bank fee'))
    : api(`/api/card-receipts?from=${from}&to=${to}`).then(async (resp) => {
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Server error');
      const byDate = new Map();
      for (const l of data.receipts) {
        const sp = splitMap.get(l.date) || { card: 0, qr: 0 };
        sp.qr += l.qr || 0; sp.card += l.amount - (l.qr || 0);
        splitMap.set(l.date, sp);
        byDate.set(l.date, [...(byDate.get(l.date) || []), l]);
        if (l.qr) qrMap.set(l.date, [...(qrMap.get(l.date) || []), l]);
      }
      // the day lists below then open without asking Loyverse again
      for (let d = from; d <= to; d = isoOf(new Date(Date.parse(d + 'T12:00:00') + 86400000))) {
        if (!CARD_RECEIPTS.has(d)) CARD_RECEIPTS.set(d, Promise.resolve(byDate.get(d) || []));
      }
    }).catch((err) => notes.push(`Could not split card from QR (Loyverse): ${err.message}`));
  await Promise.all([deps, split]);
  return { note: notes.join(' · '), deposits, rate, split: splitMap, qr: qrMap };
}
function renderBankDays(note) {
  const dates = [...new Set([...BANK_DAYS.keys(), ...BANK_SPLIT.keys(), ...Object.keys(BANK_DEPOSITS)])].sort().reverse();
  const fees = bankFees(dates);
  const all = [...fees.values()].filter((f) => f.sales != null);
  const sum = (xs, k) => xs.reduce((n, f) => n + f[k], 0);
  const sales = sum(all, 'sales'), fee = sales - sum(all, 'expected');
  const dayTotal = (date) => { const d = BANK_DAYS.get(date); return d ? BANK_SHOPS.reduce((n, s) => n + d[s], 0) : 0; };
  // the card + QR total shown above, for the days whose card / QR split is known
  const total = all.reduce((n, f) => n + dayTotal(f.date), 0);
  const qrTotal = sum(all, 'qr'), cardIn = sales - fee;
  const rateNote = BANK_RATE.days
    ? `${pct(BANK_RATE.rate)}, learned from ${BANK_RATE.days} checked day${BANK_RATE.days === 1 ? '' : 's'}`
    : `${pct(BANK_RATE.rate)} fee`;
  $('bankFees').hidden = note === undefined;
  $('bankFees').innerHTML = all.length ? `
    <li><div class="row"><span class="name">Card deposits (estimated)<span class="sub">card ${fmt(sales)} − ${rateNote}</span></span><span class="amount">${fmt2(cardIn)}</span></div></li>
    <li><div class="row"><span class="name">QR / Scan<span class="sub">no fee, each one arrives on its own</span></span><span class="amount">${fmt2(qrTotal)}</span></div></li>
    <li><div class="row total-row"><span class="name">Bank in (estimated)</span><strong>${fmt2(cardIn + qrTotal)}</strong></div></li>`
    : '<li><div class="row"><span class="name sub">No card sales in these dates</span></div></li>';
  if (note) $('bankFees').innerHTML += `<li><div class="row"><span class="name sub overdue">${esc(note)}</span></div></li>`;
  $('bankDaily').hidden = !dates.length;
  if (note !== undefined) $('bankDaily').open = true;
  // Each day lists what the bank app should show for it, newest first like the bank: the
  // card deposit (dated 23:59), then each QR / Scan payment with its time.
  $('bankDayList').innerHTML = dates.map((date) => {
    const d = BANK_DAYS.get(date) || Object.fromEntries(BANK_SHOPS.map((s) => [s, 0]));
    const f = fees.get(date);
    const dep = BANK_DEPOSITS[date];
    const qrs = [...(BANK_QR.get(date) || [])].reverse();
    const lines = note === undefined || !f || f.sales == null ? '' : `
      <li class="bank-line"><div class="row"><span class="name">Card deposit · 23:59<span class="sub">card ${fmt2(f.card)} − ${pct(BANK_RATE.rate)} fee (est.)${dep ? ` · bank paid ${fmt2(dep.amount)}` : ''}</span></span><span class="amount">≈ ${fmt2(f.expected)}</span></div></li>
      ${qrs.map((l) => `<li class="bank-line"><div class="row"><span class="name">QR / Scan · ${esc(l.time)}<span class="sub">${esc(l.shop.replace('Bicasso ', 'B'))} #${esc(l.number)}${l.refund ? ' · refund' : ''}</span></span><span class="amount">${fmt2(l.qr)}</span></div></li>`).join('')}`;
    return `
    <li class="bank-day-block"><div class="row bank-day-head"><span class="name">${fmtDate(date)}<span class="sub">${BANK_SHOPS.map((s) => `${s.replace('Bicasso ', 'B')} ${fmt(d[s])}`).join(' · ')}</span></span>
      <span class="amount">${f && f.sales != null ? fmt2(f.expected + f.qr) : fmt(BANK_SHOPS.reduce((n, s) => n + d[s], 0))}</span></div>
      <ul class="rows bank-lines">${lines}</ul>
      <details class="bank-day" data-date="${date}"><summary class="link-btn">All receipts</summary>
      <ul class="rows bank-receipts"></ul></details></li>`;
  }).join('');
}
let BANK_DAYS = new Map();
// Tap a day: its single card / QR receipts, read live from Loyverse (the sheet keeps only
// the day's total). Fetched once per day and kept until the page reloads.
const CARD_RECEIPTS = new Map();
async function loadCardReceipts(date) {
  if (CARD_RECEIPTS.has(date)) return CARD_RECEIPTS.get(date);
  const p = (async () => {
    const resp = await api(`/api/card-receipts?from=${date}&to=${date}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server error');
    return data.receipts;
  })();
  CARD_RECEIPTS.set(date, p);
  p.catch(() => CARD_RECEIPTS.delete(date));
  return p;
}
async function showCardReceipts(det) {
  const date = det.dataset.date;
  const list = det.querySelector('.bank-receipts');
  if (list.dataset.done) return;
  list.innerHTML = '<li><div class="row"><span class="name sub">Loading receipts from Loyverse…</span></div></li>';
  let lines;
  try { lines = await loadCardReceipts(date); } catch (err) {
    list.innerHTML = `<li><div class="row"><span class="name sub overdue">Could not load receipts: ${esc(err.message)}</span></div></li>`;
    return;
  }
  list.dataset.done = '1';
  if (!lines.length) {
    list.innerHTML = '<li><div class="row"><span class="name sub">No card / QR receipts in Loyverse for this day</span></div></li>';
    return;
  }
  // If someone corrected the day's Bank In by hand, the receipts won't add up to it: say so.
  const sheet = BANK_DAYS.get(date) || {};
  const notes = BANK_SHOPS.map((s) => {
    const sum = lines.filter((l) => l.shop === s).reduce((n, l) => n + l.amount, 0);
    return Math.abs(sum - (sheet[s] || 0)) > 0.5 ? `${s}: receipts add up to ${fmt(sum)}, the sheet has ${fmt(sheet[s] || 0)}` : '';
  }).filter(Boolean);
  list.innerHTML = lines.map((l) => `
    <li><div class="row"><span class="name">${esc(l.time)} · ${esc(l.shop.replace('Bicasso ', 'B'))}<span class="sub">${l.number ? `#${esc(l.number)} · ` : ''}${esc(l.methods.join(', '))}${l.refund ? ' · refund' : ''}</span></span>
      <span class="amount${l.refund ? ' overdue' : ''}">${l.refund ? '−' : ''}${fmt(Math.abs(l.amount))}</span></div></li>`).join('')
    + `<li><div class="row"><span class="name sub">${lines.length} receipt${lines.length === 1 ? '' : 's'}</span></div></li>`
    + notes.map((n) => `<li><div class="row"><span class="name sub overdue">${esc(n)}</span></div></li>`).join('');
}
$('bankDayList').addEventListener('toggle', (e) => {
  if (e.target.matches('.bank-day') && e.target.open) showCardReceipts(e.target);
}, true);
$('bankFrom').addEventListener('change', loadBankCard);
$('bankTo').addEventListener('change', loadBankCard);

// ================= per-shop / per-customer detail =================
let TX = null;
let TX_LOADING = null;   // shared, so Home, the day sheet and Reports don't each fetch it
async function loadTx(force) {
  if (TX && !force) return TX;
  if (TX_LOADING && !force) return TX_LOADING;
  const p = (async () => {
    const resp = await api('/api/transactions');
    if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
    TX = (await resp.json()).transactions;
    return TX;
  })();
  TX_LOADING = p;
  p.catch(() => {}).finally(() => { if (TX_LOADING === p) TX_LOADING = null; });
  return p;
}

function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${+d}/${+m}/${y}`;
}
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.row - b.row);
const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row);

function pad(n) { return String(n).padStart(2, '0'); }
function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function periodRange(preset) {
  const now = new Date();
  if (preset === 'month') return { from: isoOf(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoOf(new Date(now.getFullYear(), now.getMonth() + 1, 0)), label: 'This month' };
  if (preset === 'lastmonth') return { from: isoOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoOf(new Date(now.getFullYear(), now.getMonth(), 0)), label: 'Last month' };
  if (preset === 'year') return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31`, label: 'This year' };
  if (preset === 'custom') return { from: $('fromDate').value || null, to: $('toDate').value || null, label: 'Custom', custom: true };
  return { from: null, to: null, label: 'All time' };
}
function inRange(dateStr, r) {
  if (r.from && dateStr < r.from) return false;
  if (r.to && dateStr > r.to) return false;
  return true;
}

let currentDetail = null;

async function openDetail(kind, name) {
  showPage('detail');
  $('detailTitle').textContent = name;
  $('detailSub').textContent = 'Loading…';
  $('detailSummary').innerHTML = '';
  $('detailList').innerHTML = '';
  $('detailEmpty').hidden = true;
  $('detailFilter').hidden = true;
  $('detailPeriod').value = 'all';
  $('customRange').hidden = true;
  $('shareBtn').hidden = kind !== 'customer';
  currentDetail = { kind, name, allRows: [], headline: 0 };
  try {
    const tx = await loadTx();
    const rows = tx.filter((t) => (kind === 'shop' ? t.shop === name : t.customer === name)).sort(byDateAsc);
    // running total computed cumulatively over ALL of this shop's/customer's rows
    let run = 0;
    rows.forEach((t) => {
      if (kind === 'shop') run += t.cashIn - t.cashOut;
      else if (t.category === 'Credit Sale') run += t.creditAmount;
      else if (t.category === 'Customer Payment') run -= (t.cashIn + t.bankIn);
      t._run = run;
    });
    currentDetail.allRows = rows;
    currentDetail.headline = rows.length ? rows[rows.length - 1]._run : 0;
    $('detailFilter').hidden = false;
    renderDetail();
  } catch (e) {
    $('detailSub').textContent = 'Could not load: ' + e.message;
  }
}

function renderDetail() {
  const { kind, headline, allRows } = currentDetail;
  const r = periodRange($('detailPeriod').value);
  const filtered = allRows.filter((t) => inRange(t.date, r));
  $('detailSub').textContent = `${r.label} · ${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`;

  if (kind === 'shop') {
    let cashIn = 0, cashOut = 0, bankIn = 0, bankOut = 0;
    filtered.forEach((t) => { cashIn += t.cashIn; cashOut += t.cashOut; bankIn += t.bankIn; bankOut += t.bankOut; });
    $('detailListLabel').textContent = 'In & Out';
    $('detailSummary').innerHTML = `
      <div class="total-card in"><span class="label">Cash In</span><span class="value">${fmt(cashIn)}</span></div>
      <div class="total-card out"><span class="label">Cash Out</span><span class="value">${fmt(cashOut)}</span></div>
      <div class="total-card in"><span class="label">Bank In</span><span class="value">${fmt(bankIn)}</span></div>
      <div class="total-card out"><span class="label">Bank Out</span><span class="value">${fmt(bankOut)}</span></div>
      <div class="total-card grand wide"><span class="label">Net Cash in Drawer (all-time)</span><span class="value">${fmt(headline)}</span></div>`;
  } else {
    let charged = 0, paid = 0;
    filtered.forEach((t) => { if (t.category === 'Credit Sale') charged += t.creditAmount; if (t.category === 'Customer Payment') paid += t.cashIn + t.bankIn; });
    $('detailListLabel').textContent = 'Statement';
    $('detailSummary').innerHTML = `
      <div class="total-card"><span class="label">Charged</span><span class="value" style="color:var(--amber)">${fmt(charged)}</span></div>
      <div class="total-card in"><span class="label">Paid</span><span class="value">${fmt(paid)}</span></div>
      <div class="total-card grand wide"><span class="label">Balance Owed (all-time)</span><span class="value">${fmt(headline)}</span></div>`;
  }

  if (!filtered.length) { $('detailList').innerHTML = ''; $('detailEmpty').hidden = false; return; }
  $('detailEmpty').hidden = true;
  const runLabel = kind === 'shop' ? 'drawer' : 'balance';
  $('detailList').innerHTML = filtered.slice().sort(byDateDesc).map((t) => {
    const amts = [];
    if (kind === 'shop') {
      if (t.cashIn) amts.push(`<span class="amt in">+${fmt(t.cashIn)} cash</span>`);
      if (t.bankIn) amts.push(`<span class="amt in">+${fmt(t.bankIn)} bank</span>`);
      if (t.cashOut) amts.push(`<span class="amt out">−${fmt(t.cashOut)} cash</span>`);
      if (t.bankOut) amts.push(`<span class="amt out">−${fmt(t.bankOut)} bank</span>`);
    } else if (t.category === 'Credit Sale') amts.push(`<span class="amt credit">+${fmt(t.creditAmount)}</span>`);
    else if (t.category === 'Customer Payment') amts.push(`<span class="amt pay">−${fmt(t.cashIn + t.bankIn)}</span>`);
    const opening = /opening/i.test(t.notes);
    const label = (kind === 'customer' && opening) ? 'Opening balance' : t.category;
    const meta = fmtDate(t.date) + (t.notes && !(kind === 'customer' && opening) ? ' · ' + esc(t.notes) : '');
    return `<li><div class="tx tappable" data-row="${t.row}">
      <div class="tx-left"><div class="tx-cat">${esc(label)}</div><div class="tx-meta">${meta}</div></div>
      <div class="tx-amounts">${amts.join('') || '<span class="amt">—</span>'}<span class="amt-run">${runLabel} ${fmt(t._run)}</span><span class="chevron">›</span></div>
    </div></li>`;
  }).join('');
}

function buildStatement() {
  const { name, allRows, headline } = currentDetail;
  const r = periodRange($('detailPeriod').value);
  const filtered = allRows.filter((t) => inRange(t.date, r)).sort(byDateAsc);
  const body = filtered.map((t) => {
    const opening = /opening/i.test(t.notes);
    let charge = '', payment = '', desc = '';
    if (t.category === 'Credit Sale') { charge = fmt(t.creditAmount); desc = opening ? 'Opening balance' : 'Credit sale' + (t.notes ? ' — ' + esc(t.notes) : ''); }
    else if (t.category === 'Customer Payment') { payment = fmt(t.cashIn + t.bankIn); desc = 'Payment received' + (t.notes ? ' — ' + esc(t.notes) : ''); }
    else return '';
    return `<tr><td>${fmtDate(t.date)}</td><td>${desc}</td><td class="num">${charge}</td><td class="num">${payment}</td><td class="num">${fmt(t._run)}</td></tr>`;
  }).join('');
  const periodLine = r.from || r.to ? `<br>Period: ${r.label}${r.from ? ' (' + fmtDate(r.from) + ' – ' + fmtDate(r.to || isoOf(new Date())) + ')' : ''}` : '';
  $('printArea').innerHTML = `
    <h1>Burmelin Finance</h1>
    <div class="ph-sub">Customer Statement — <strong>${esc(name)}</strong><br>Generated ${new Date().toLocaleDateString()}${periodLine}</div>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Charge</th><th class="num">Payment</th><th class="num">Balance</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="total-line"><td colspan="4">Balance Owed (total)</td><td class="num">${fmt(headline)}</td></tr></tfoot>
    </table>
    <div class="ph-foot">Generated from Burmelin Finance records.</div>`;
}

$('detailPeriod').addEventListener('change', () => {
  const custom = $('detailPeriod').value === 'custom';
  $('customRange').hidden = !custom;
  if (!custom || $('fromDate').value || $('toDate').value) renderDetail();
});
$('fromDate').addEventListener('change', renderDetail);
$('toDate').addEventListener('change', renderDetail);

$('backBtn').addEventListener('click', () => showPage('dashboard'));
$('shareBtn').addEventListener('click', () => {
  if (!currentDetail || currentDetail.kind !== 'customer') return;
  buildStatement();
  window.print();
});
$('shopList').addEventListener('click', (e) => { const el = e.target.closest('[data-shop]'); if (el) openDetail('shop', el.dataset.shop); });
$('creditList').addEventListener('click', (e) => { const el = e.target.closest('[data-customer]'); if (el) openDetail('customer', el.dataset.customer); });

// ---- record form ----
function populateForm() {
  if (!LISTS) return;
  const cat = $('fCategory');
  if (cat.options.length <= 1) {
    const groups = { Income: [], Expense: [], Transfer: [] };
    LISTS.categories.forEach((c) => (groups[c.type] || (groups[c.type] = [])).push(c.name));
    for (const [type, names] of Object.entries(groups)) {
      if (!names.length) continue;
      const og = document.createElement('optgroup');
      og.label = type;
      names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; og.appendChild(o); });
      cat.appendChild(og);
    }
    // The import's card fee rows: editable even if the sheet's Lists tab doesn't name the category.
    if (![...cat.options].some((o) => o.value === 'Card Fee')) {
      const og = cat.querySelector('optgroup[label="Expense"]') || cat.appendChild(Object.assign(document.createElement('optgroup'), { label: 'Expense' }));
      const o = document.createElement('option'); o.value = o.textContent = 'Card Fee'; og.appendChild(o);
    }
    // App-only shortcut for setting a credit customer's starting debt.
    const ogSetup = document.createElement('optgroup');
    ogSetup.label = 'Setup';
    const oOpen = document.createElement('option');
    oOpen.value = 'Credit Opening Balance';
    oOpen.textContent = 'Credit Opening Balance';
    ogSetup.appendChild(oOpen);
    cat.appendChild(ogSetup);
    // App-only correction entry (only add if the sheet's Lists doesn't already have it).
    if (![...cat.options].some((o) => o.value === 'Adjustment')) {
      const ogFix = document.createElement('optgroup');
      ogFix.label = 'Correction';
      const oAdj = document.createElement('option');
      oAdj.value = 'Adjustment';
      oAdj.textContent = 'Adjustment';
      ogFix.appendChild(oAdj);
      cat.appendChild(ogFix);
    }
  }
  const shop = $('fShop');
  if (!shop.options.length) {
    LISTS.shops.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; shop.appendChild(o); });
  }
  const cust = $('fCustomer');
  if (!cust.options.length) {
    LISTS.customers.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; cust.appendChild(o); });
  }
  const dShop = $('dShop');
  if (!dShop.options.length) {
    LISTS.shops.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; dShop.appendChild(o); });
  }
  renderShopChips();
  updateCollectionVisibility();
}

// ---- expense categories for the Daily screen (everything the sheet marks "Expense") ----
function expenseCategories() {
  const fromList = (LISTS && LISTS.categories || [])
    .filter((c) => c.type === 'Expense' && c.name !== 'Card Fee')   // the import writes card fees
    .map((c) => c.name);
  return fromList.length ? fromList : ['Supplier Pay', 'Salary', 'Wages', 'Commission', 'Rent', 'Gov Tax', 'Home Expenses', 'Other Expense'];
}

function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
$('fDate').value = todayLocalISO();

$('fCategory').addEventListener('change', () => {
  const rule = RULES[$('fCategory').value];
  if (!rule) return;

  // amount inputs
  $('amountFields').innerHTML = rule.fields.map((f) => `
    <label class="amount-field">
      <span>${FIELD_LABELS[f]}</span>
      <span class="currency-wrap"><input type="number" inputmode="decimal" min="0" step="any" id="amt_${f}" placeholder="0"></span>
    </label>`).join('');

  // Credit rows always use the customer's own shop: show the customer, hide the redundant Shop.
  const needsCust = NEEDS_CUSTOMER.includes($('fCategory').value);
  $('rowCustomer').hidden = !needsCust;
  $('rowShop').hidden = needsCust;
  if (needsCust) $('fShop').value = customerShop($('fCustomer').value);
  $('fShop').disabled = false;

  $('ruleHint').textContent = rule.hint;
});

$('fCustomer').addEventListener('change', () => {
  if (NEEDS_CUSTOMER.includes($('fCategory').value)) $('fShop').value = customerShop($('fCustomer').value);
});

$('txForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const category = $('fCategory').value;
  const rule = RULES[category];
  if (!rule) return showToast('Pick a category first', 'error');

  // "Credit Opening Balance" is an app-only shortcut. It's written to the sheet as a
  // Credit Sale (what the Credit Aging tab counts), tagged in Notes so it stays distinguishable.
  let apiCategory = category;
  let notes = $('fNotes').value.trim();
  if (category === 'Credit Opening Balance') {
    apiCategory = 'Credit Sale';
    if (!notes) notes = 'Opening balance';
  }
  // An adjustment must always say why, so the correction is traceable later.
  if (category === 'Adjustment' && !notes) {
    return showToast('Add a note explaining the adjustment', 'error');
  }

  const body = {
    category: apiCategory,
    shop: $('fShop').value,
    customer: NEEDS_CUSTOMER.includes(category) ? $('fCustomer').value : '',
    date: $('fDate').value,
    notes,
  };
  let any = false;
  for (const f of rule.fields) {
    const v = parseFloat(($(`amt_${f}`) || {}).value || '0') || 0;
    body[f] = v;
    if (v > 0) any = true;
  }
  if (!any) return showToast('Enter an amount', 'error');

  const isEdit = editingRow !== null;
  if (isEdit) { body.row = editingRow; body.original = originalOf(editingTx); }

  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = isEdit ? 'Updating…' : 'Saving…';
  try {
    const data = await saveJSON('/api/transaction', isEdit ? 'PUT' : 'POST', body);
    if (isEdit) {
      showToast(`Updated ✓ ${category} — ${body.shop}${data.mock ? ' (sample mode)' : ''}`, 'success');
      cancelEdit();
      loadDashboardSoon();
    } else {
      showToast(`Saved ✓ ${category} — ${body.shop}${data.mock ? ' (sample mode)' : ''}`, 'success');
      rule.fields.forEach((f) => { const el = $(`amt_${f}`); if (el) el.value = ''; });
      $('fNotes').value = '';
      loadDashboardSoon();
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = isEdit ? 'Update Transaction' : 'Save Transaction';
  }
});

let dashTimer = null;
function loadDashboardSoon() { TX = null; clearTimeout(dashTimer); dashTimer = setTimeout(loadDashboard, 400); }

let toastTimer = null;
function showToast(msg, kind, id = 'toast') {
  const t = $(id);
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---- edit transaction ----
let editingRow = null;
let editingTx = null;   // the entry as the app showed it, so the server can check the row still holds it

// What the server compares with the sheet row before changing or deleting it
function originalOf(tx) {
  if (!tx) return null;
  const { date, shop, customer, category, cashIn, bankIn, cashOut, bankOut, creditAmount } = tx;
  return { date, shop, customer, category, cashIn, bankIn, cashOut, bankOut, creditAmount };
}

function startEdit(tx) {
  editingRow = tx.row;
  editingTx = tx;
  $('deleteBtn').hidden = false;
  setTab('add');
  addSub = 'record';
  showPage('record');

  const isOpeningBalance = tx.category === 'Credit Sale' && /opening/i.test(tx.notes);
  const catValue = isOpeningBalance ? 'Credit Opening Balance' : tx.category;
  $('fCategory').value = catValue;
  $('fCategory').dispatchEvent(new Event('change'));

  $('fShop').value = tx.shop;
  if (NEEDS_CUSTOMER.includes(catValue) || NEEDS_CUSTOMER.includes(tx.category)) {
    $('fCustomer').value = tx.customer;
  }
  $('fDate').value = tx.date;
  $('fNotes').value = isOpeningBalance && tx.notes.toLowerCase() === 'opening balance' ? '' : tx.notes;

  const rule = RULES[catValue];
  if (rule) {
    rule.fields.forEach((f) => {
      const el = $(`amt_${f}`);
      if (el && tx[f]) el.value = tx[f];
    });
  }

  $('saveBtn').textContent = 'Update Transaction';
  $('editBanner').hidden = false;
}

function cancelEdit() {
  editingRow = null;
  editingTx = null;
  $('deleteBtn').hidden = true;
  $('saveBtn').textContent = 'Save Transaction';
  $('editBanner').hidden = true;
  $('fCategory').value = '';
  $('amountFields').innerHTML = '';
  $('ruleHint').textContent = '';
  $('fNotes').value = '';
  $('fDate').value = todayLocalISO();
  $('rowCustomer').hidden = true;
  $('rowShop').hidden = false;

  if (currentDetail) {
    setTab('dashboard');
    openDetail(currentDetail.kind, currentDetail.name);
  }
}

$('cancelEdit').addEventListener('click', cancelEdit);

// Delete the entry being edited (instead of deleting rows in the sheet by hand)
$('deleteBtn').addEventListener('click', async () => {
  if (editingRow === null || !editingTx) return;
  const t = editingTx;
  const amount = t.cashIn + t.bankIn + t.cashOut + t.bankOut + t.creditAmount;
  if (!confirm(`Delete this entry?\n\n${t.category} · ${t.shop} · ${fmtDate(t.date)} · ${fmt(amount)}\n\nIt is removed from the sheet.`)) return;
  const btn = $('deleteBtn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    const data = await saveJSON('/api/transaction', 'DELETE', { row: editingRow, original: originalOf(t) });
    showToast(`Deleted ✓ ${t.category} — ${t.shop}${data.mock ? ' (sample mode)' : ''}`, 'success');
    TX = null;
    cancelEdit();
    loadDashboardSoon();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Delete entry';
  }
});

$('detailList').addEventListener('click', (e) => {
  const el = e.target.closest('[data-row]');
  if (!el || !TX) return;
  const row = parseInt(el.dataset.row, 10);
  const tx = TX.find((t) => t.row === row);
  if (tx) startEdit(tx);
});

// ================= Daily entry (sales + expenses per shop per date) =================
$('dDate').value = todayLocalISO();

function addExpenseLine() {
  const cats = expenseCategories();
  const line = document.createElement('div');
  line.className = 'exp-line';
  line.innerHTML = `
    <div class="exp-top">
      <select class="exp-cat" aria-label="Expense category">
        ${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
      <button type="button" class="exp-remove" aria-label="Remove expense">&times;</button>
    </div>
    <div class="exp-bottom">
      <span class="currency-wrap"><input type="number" inputmode="decimal" min="0" step="any" class="exp-amt" placeholder="0"></span>
      <div class="exp-pay">
        <label><input type="radio" class="exp-cash" checked> Cash</label>
        <label><input type="radio" class="exp-bank"> Bank</label>
      </div>
    </div>
    <input type="text" class="exp-note" maxlength="200" placeholder="Note (optional) — e.g. July rent">`;
  // give this line's two radios a shared, unique name so exactly one stays selected
  const name = 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  line.querySelector('.exp-cash').name = name;
  line.querySelector('.exp-bank').name = name;
  $('expLines').appendChild(line);
  updateDailySummary();
}

$('addExpBtn').addEventListener('click', addExpenseLine);

$('expLines').addEventListener('click', (e) => {
  const rm = e.target.closest('.exp-remove');
  if (rm) { rm.closest('.exp-line').remove(); updateDailySummary(); }
});
$('expLines').addEventListener('input', updateDailySummary);
$('dSaleCash').addEventListener('input', updateDailySummary);
$('dSaleBank').addEventListener('input', updateDailySummary);
$('dShop').addEventListener('change', () => { updateCollectionVisibility(); renderShopChips(); });

// Shop buttons drive the (hidden) shop list, so everything else reads $('dShop') as before.
// A green dot marks a shop that already has entries on the chosen day.
let SAVED_SHOPS = new Set();
function renderShopChips() {
  const shops = (LISTS && LISTS.shops) || [];
  const cur = $('dShop').value;
  $('dShopChips').innerHTML = shops.map((s) => `<button type="button" class="chip${s === cur ? ' on' : ''}" data-shop="${esc(s)}">${esc(s)}${SAVED_SHOPS.has(s) ? '<i class="dot" title="already has entries for this day"></i>' : ''}</button>`).join('');
  $('dSavedHint').hidden = !SAVED_SHOPS.size;
}
$('dShopChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shop]');
  if (!b || b.dataset.shop === $('dShop').value) return;
  $('dShop').value = b.dataset.shop;
  $('dShop').dispatchEvent(new Event('change'));
});
async function refreshSavedDots() {
  const date = $('dDate').value;
  try {
    const tx = await loadTx();
    if ($('dDate').value !== date) return;   // the day changed while loading
    SAVED_SHOPS = new Set(tx.filter((t) => t.date === date).map((t) => t.shop));
  } catch (e) { SAVED_SHOPS = new Set(); }
  renderShopChips();
}
function shiftDailyDate(n) {
  const d = $('dDate').value || todayLocalISO();
  $('dDate').value = shiftISO(d, n);
  $('dDate').dispatchEvent(new Event('change'));
}
$('dPrev').addEventListener('click', () => shiftDailyDate(-1));
$('dNext').addEventListener('click', () => shiftDailyDate(1));
$('dDate').addEventListener('change', refreshSavedDots);
$('dNeighbourPaid').addEventListener('input', updateDailySummary);

function readDaily() {
  const sale = {
    cash: parseFloat($('dSaleCash').value || '0') || 0,
    bank: parseFloat($('dSaleBank').value || '0') || 0,
  };
  const collection = parseFloat($('dCollection').value || '0') || 0;
  const neighbourPaid = parseFloat($('dNeighbourPaid').value || '0') || 0;
  const expenses = [...$('expLines').querySelectorAll('.exp-line')].map((line) => ({
    category: line.querySelector('.exp-cat').value,
    amount: parseFloat(line.querySelector('.exp-amt').value || '0') || 0,
    fromBank: line.querySelector('.exp-bank').checked,
    note: line.querySelector('.exp-note').value.trim(),
  })).filter((x) => x.amount > 0);
  return { sale, collection, neighbourPaid, expenses };
}

// Collection means "cash carried from this shop to Palladium", so it only
// applies to the other shops. Hide the card when Palladium itself is selected.
// A shop with a neighbour-card account (Nana) takes card payments on the neighbour's
// machine: that money is owed, not in the bank, until the neighbour pays it in cash.
function updateCollectionVisibility() {
  const shop = $('dShop').value;
  const isHub = shop === 'Palladium';
  $('collectionCard').hidden = isHub;
  if (isHub) $('dCollection').value = '';

  const acct = neighbourAccount(shop);
  $('dSaleBankLabel').innerHTML = acct ? "Card <em>(neighbour's machine — they owe it)</em>" : 'Bank In <em>(card / QR)</em>';
  $('neighbourCard').hidden = !acct;
  if (!acct) $('dNeighbourPaid').value = '';
  const owed = acct && CREDIT.find((c) => c.name === acct);
  $('neighbourOwes').textContent = owed ? `(they owe ${fmt(owed.balance)})` : '';
}

function updateDailySummary() {
  const { sale, expenses } = readDaily();
  const sales = sale.cash + sale.bank;
  const exp = expenses.reduce((s, x) => s + x.amount, 0);
  $('dSumSales').textContent = fmt(sales);
  $('dSumExp').textContent = fmt(exp);
  $('dSumNet').textContent = fmt(sales - exp);
}

$('dailySaveBtn').addEventListener('click', async () => {
  const shop = $('dShop').value;
  const date = $('dDate').value;
  if (!shop) return showToast('Pick a shop', 'error', 'dailyToast');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showToast('Pick a date', 'error', 'dailyToast');

  const { sale, collection, neighbourPaid, expenses } = readDaily();
  const acct = neighbourAccount(shop);
  if (collection > 0 && shop === 'Palladium') {
    return showToast('Collection is cash taken from a shop TO Palladium — pick a different shop', 'error', 'dailyToast');
  }
  const rows = [];
  if (acct) {
    if (sale.cash > 0) rows.push({ category: 'Retail Sale', shop, date, cashIn: sale.cash, notes: '' });
    if (sale.bank > 0) rows.push({ category: 'Credit Sale', shop, customer: acct, date, creditAmount: sale.bank, notes: "Card sales on neighbour's machine" });
    if (neighbourPaid > 0) rows.push({ category: 'Customer Payment', shop, customer: acct, date, cashIn: neighbourPaid, notes: 'Cash from neighbour for card sales' });
  } else if (sale.cash > 0 || sale.bank > 0) {
    rows.push({ category: 'Retail Sale', shop, date, cashIn: sale.cash, bankIn: sale.bank, notes: '' });
  }
  if (collection > 0) {
    rows.push({ category: 'Collection (to Palladium)', shop, date, cashOut: collection, notes: '' });
  }
  expenses.forEach((x) => {
    rows.push({
      category: x.category,
      shop,
      date,
      cashOut: x.fromBank ? 0 : x.amount,
      bankOut: x.fromBank ? x.amount : 0,
      notes: x.note,
    });
  });
  if (!rows.length) return showToast('Enter a sale, collection or expense', 'error', 'dailyToast');

  const btn = $('dailySaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const data = await saveJSON('/api/batch', 'POST', { rows });
    const n = data.count || rows.length;
    showToast(`Saved ✓ ${n} entr${n === 1 ? 'y' : 'ies'} — ${shop}${data.mock ? ' (sample mode)' : ''}`, 'success', 'dailyToast');
    // clear for the next shop/day, keep shop + date
    $('dSaleCash').value = ''; $('dSaleBank').value = '';
    $('dCollection').value = '';
    $('dNeighbourPaid').value = '';
    $('expLines').innerHTML = '';
    updateDailySummary();
    loadDashboardSoon();
  } catch (err) {
    showToast(err.message, 'error', 'dailyToast');
  } finally {
    btn.disabled = false; btn.textContent = 'Save day';
  }
});

// ================= Loyverse import (check first, then save) =================
$('lvFrom').value = todayLocalISO();
$('lvTo').value = todayLocalISO();

const LV_MAX_DAYS = 92;
const shiftISO = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// The server handles up to 31 days per call; asking a week at a time keeps each call
// well inside Vercel's time limit even on busy days.
function lvChunks(from, to) {
  const dates = [];
  for (let d = from; d <= to && dates.length <= LV_MAX_DAYS; d = shiftISO(d, 1)) dates.push(d);
  const chunks = [];
  for (let i = 0; i < dates.length; i += 7) {
    const week = dates.slice(i, i + 7);
    chunks.push({ date: week[week.length - 1], days: week.length });
  }
  return { chunks, count: dates.length };
}

async function runLoyverse(dryRun) {
  const from = $('lvFrom').value, to = $('lvTo').value;
  if (!from || !to) return showToast('Pick both dates', 'error', 'dailyToast');
  if (from > to) return showToast('The first date must be before the second', 'error', 'dailyToast');
  const { chunks, count } = lvChunks(from, to);
  if (count > LV_MAX_DAYS) return showToast('Pick at most 3 months at a time', 'error', 'dailyToast');

  const btn = dryRun ? $('lvCheckBtn') : $('lvSaveBtn');
  const label = btn.textContent;
  btn.disabled = true;
  const merged = { dryRun, mock: false, from, to, results: [], unmatchedStores: [], warnings: [], added: 0, updated: 0 };
  try {
    for (let i = 0; i < chunks.length; i++) {
      btn.textContent = `${dryRun ? 'Checking Loyverse' : 'Saving'}…${chunks.length > 1 ? ` ${i + 1}/${chunks.length}` : ''}`;
      const resp = await api('/api/loyverse-sync', { method: 'POST', body: JSON.stringify({ ...chunks[i], dryRun }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Server error');
      merged.mock = data.mock;
      merged.results.push(...data.results);
      merged.added += data.added;
      merged.updated += data.updated;
      data.warnings.forEach((w) => { if (!merged.warnings.includes(w)) merged.warnings.push(w); });
      data.unmatchedStores.forEach((u) => {
        const seen = merged.unmatchedStores.find((x) => x.store === u.store);
        if (seen) seen.receipts += u.receipts; else merged.unmatchedStores.push({ ...u });
      });
    }
    renderLoyverse(merged);
    if (!dryRun) {
      const n = merged.added + merged.updated;
      showToast(`Saved ✓ ${n} entr${n === 1 ? 'y' : 'ies'} from Loyverse${merged.mock ? ' (sample mode)' : ''}`, 'success', 'dailyToast');
      loadDashboardSoon();
    }
  } catch (err) {
    // Every save is safe to repeat (rows are updated, never duplicated), so just retry.
    showToast(`${err.message}${dryRun ? '' : ' — part may be saved; tap Check again'}`, 'error', 'dailyToast');
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// One line per shop with its totals for the whole period (to compare with Loyverse's
// own report), what will happen to its days, and any day that needs attention.
function renderLoyverse(d) {
  const verb = d.dryRun ? { add: 'will add', update: 'will update' } : { add: 'added ✓', update: 'updated ✓' };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const entries = (n) => (n === 1 ? '1 entry' : `${n} entries`);
  const total = (x) => x.cash + x.bank + (x.credit || 0);
  const shops = new Map();
  const bucket = { 'Collection (to Palladium)': 'collections', Salary: 'salary', Adjustment: 'adjustments' };
  d.results.forEach((p) => {
    const s = shops.get(p.shop) || { cash: 0, bank: 0, credit: 0, receipts: 0, refunds: 0, n: {}, notes: [], out: {}, paidIn: 0 };
    shops.set(p.shop, s);
    const note = (text, warn) => { if (!s.notes.some((x) => x.text === text)) s.notes.push({ text, warn }); };
    if (p.kind === 'movement') {
      // drawer pay-outs / pay-ins: shown apart from the sales totals
      s.n[p.action] = (s.n[p.action] || 0) + 1;
      if (p.cashOut && p.action !== 'skip') { const b = bucket[p.category] || 'expenses'; s.out[b] = (s.out[b] || 0) + p.cashOut; }
      if (p.cashIn && p.action !== 'skip') s.paidIn += p.cashIn;
      if (p.category === 'Card Fee') {
        // the bank's estimated fee on the day's card sales (Bank Out)
        if (p.action !== 'skip') s.out['card fee (est.)'] = (s.out['card fee (est.)'] || 0) + p.bankOut;
        if (p.reason) note(`${fmtDate(p.date)} card fee: ${p.reason}`, p.action === 'skip' && !p.kept);
        return;
      }
      if (p.action === 'skip') note(p.row ? `${fmtDate(p.date)} pay-outs: ${p.reason}` : `${fmtDate(p.date)} ${p.time}: ${p.reason}`, !p.kept);
      else if (p.review) note(`${fmtDate(p.date)} ${p.note}: ${p.review}`, true);
      return;
    }
    s.cash += p.cash; s.bank += p.bank; s.credit += p.credit || 0;
    // receipts/refunds are per day; count them once (on the sales row) when a day also has a card row
    if (p.kind !== 'credit') { s.receipts += p.receipts; s.refunds += p.refunds; }
    s.n[p.action] = (s.n[p.action] || 0) + 1;
    const label = p.kind === 'credit' ? `${fmtDate(p.date)} neighbour card` : fmtDate(p.date);
    if (p.action === 'update') note(`${label}: sheet had ${fmt(total(p.was))}, Loyverse says ${fmt(total(p))}`);
    // a day typed by hand skips both of its rows: say it once
    if (p.reason) note(`${p.action === 'skip' && p.row ? fmtDate(p.date) : label}: ${p.reason}`, p.action === 'skip' && !p.kept);
  });

  const items = [...shops].map(([shop, s]) => {
    const status = [
      s.n.add && `${verb.add} ${entries(s.n.add)}`,
      s.n.update && `${verb.update} ${entries(s.n.update)}`,
      s.n.unchanged && `${entries(s.n.unchanged)} already in the sheet`,
      s.n.skip && `${entries(s.n.skip)} skipped`,
    ].filter(Boolean).join(' · ');
    const counts = plural(s.receipts, 'receipt') + (s.refunds ? `, ${plural(s.refunds, 'refund')}` : '');
    const outs = Object.entries(s.out).map(([k, v]) => `${k} ${fmt(v)}`);
    const moves = [outs.length && `pay-outs: ${outs.join(' · ')}`, s.paidIn && `pay-ins ${fmt(s.paidIn)}`].filter(Boolean).join(' · ');
    const notes = s.notes.map((x) => `<span class="sub ${x.warn ? 'overdue' : ''}">${esc(x.text)}</span>`).join('');
    return `<li><div class="row">
      <span class="name">${esc(shop)}<span class="sub">cash ${fmt(s.cash)} · ${s.credit ? `card owed by neighbour ${fmt(s.credit)}` : `bank ${fmt(s.bank)}`} · ${counts}</span>${moves ? `<span class="sub">${esc(moves)}</span>` : ''}<span class="sub">${esc(status)}</span>${notes}</span>
      <span class="amount">${fmt(total(s))}</span>
    </div></li>`;
  });
  d.unmatchedStores.forEach((u) => {
    items.push(`<li><div class="row"><span class="name">${esc(u.store)}<span class="sub overdue">Loyverse store not linked to a shop: ${esc(u.reason)} (${plural(u.receipts, 'receipt')} left out)</span></span></div></li>`);
  });
  if (!items.length) items.push('<li><div class="row"><span class="name">No Loyverse sales or pay-outs on these dates</span></div></li>');

  const period = d.from === d.to ? fmtDate(d.from) : `${fmtDate(d.from)} – ${fmtDate(d.to)}`;
  $('lvPeriod').textContent = `${period} · compare each shop with Loyverse → Reports → Sales by payment type for the same dates`;
  $('lvList').innerHTML = items.join('');
  $('lvNotes').textContent = d.warnings.join(' · ');
  $('lvNotes').hidden = !d.warnings.length;
  $('lvSaveBtn').hidden = !(d.dryRun && d.results.some((p) => p.action === 'add' || p.action === 'update'));
  $('lvResult').hidden = false;
}

$('lvCheckBtn').addEventListener('click', () => runLoyverse(true));
$('lvSaveBtn').addEventListener('click', () => runLoyverse(false));
$('lvFrom').addEventListener('change', () => { $('lvResult').hidden = true; });
$('lvTo').addEventListener('change', () => { $('lvResult').hidden = true; });

// ================= Staff commission =================
// Terminal 21: 3% of the month's Bicasso 1 + Bicasso 2 sales split between the staff, plus each
// shop's daily bonus. Nana: 1% of Nana's sales split between Nana's staff, no bonus.
// Days off beyond 2 take 1/30 of the total each (entered here by the owner).
const COMM_ALLOWED_OFF = 2;
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const thisMonth = () => todayLocalISO().slice(0, 7);

async function fetchCommission(month) {
  const resp = await api(`/api/commission?month=${month}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Server error');
  return data;
}

// Days off: what the owner set (saved in the finance sheet, the same on every phone), otherwise
// the person's approved leave that month from the Leave screen.
function getOff(month, name) {
  const d = (COMM && COMM.month === month && COMM.daysOff) || { leave: {}, saved: {} };
  if (name in d.saved) return d.saved[name];
  return d.leave[name] || 0;
}
function offSource(name) {
  const d = (COMM && COMM.daysOff) || { leave: {}, saved: {} };
  if (name in d.saved) return 'set by you';
  return d.leave[name] ? 'from approved leave' : '';
}
const offSaving = {};
function setOff(month, name, n) {
  if (!COMM || COMM.month !== month) return;
  COMM.daysOff = COMM.daysOff || { leave: {}, saved: {} };
  COMM.daysOff.saved[name] = n;
  // Wait for the taps to settle, then save once
  clearTimeout(offSaving[name]);
  offSaving[name] = setTimeout(() => saveOff(month, name, n), 700);
}
async function saveOff(month, name, n) {
  try {
    const resp = await api('/api/commission', { method: 'POST', body: JSON.stringify({ month, name, days: n }) });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
  } catch (err) {
    const note = $('commStaffNote');
    note.textContent = `Days off for ${name} were not saved (${err.message}). Change the number again to retry.`;
    note.hidden = false;
  }
}
// Days off typed before they were saved to the sheet lived only on that phone: move them over once.
function moveOldDaysOff(c) {
  const names = c.staff.concat(c.nana.staff);
  for (const name of names) {
    const key = `commOff:${c.month}:${name}`;
    let old = null;
    try { old = localStorage.getItem(key); } catch (e) { return; }
    if (old === null) continue;
    if (!(name in c.daysOff.saved)) {
      const n = Math.max(0, Math.round((parseFloat(old) || 0) * 2) / 2);
      c.daysOff.saved[name] = n;
      saveOff(c.month, name, n);
    }
    try { localStorage.removeItem(key); } catch (e) { /* fine */ }
  }
}

let COMM = null;
async function openCommission(month) {
  showPage('commission');
  $('commMonth').value = month;
  $('commPeriod').textContent = 'Loading…';
  $('commSummary').innerHTML = ''; $('commStaff').innerHTML = ''; $('commDays').innerHTML = '';
  $('commNanaSummary').innerHTML = ''; $('commNanaStaff').innerHTML = ''; $('commStaffNote').hidden = true;
  $('commTotal').textContent = '—'; $('commNanaTotal').textContent = '—';
  loadAdvances(month);
  try {
    COMM = await fetchCommission(month);
    COMM.daysOff = COMM.daysOff || { leave: {}, saved: {} };
    moveOldDaysOff(COMM);
    renderCommission();
  } catch (err) {
    $('commPeriod').textContent = 'Could not load: ' + err.message;
  }
}

function renderCommission() {
  const c = COMM;
  const each = c.commissionEach + c.bonusEach;
  const inProgress = c.month === thisMonth();
  $('commPeriod').textContent = `${monthLabel(c.month)}${inProgress ? ` · so far, to ${fmtDate(todayLocalISO())}` : ''}${c.mock ? ' · sample data' : ''}`;
  // The answer first (each person), the working beside it in one line
  const split = (people) => (people ? ` ÷ ${people}` : '');
  $('commSummary').innerHTML = `
    <div><span class="label">Each person</span><span class="comm-each">${fmt(each)}</span></div>
    <div class="comm-calc">${c.shops.map((s) => `${esc(s)} ${fmt(c.sales[s])}`).join(' · ')}<br>
      ${Math.round(c.rate * 100)}% of ${fmt(c.totalSales)}${split(c.staff.length)} = ${fmt(c.commissionEach)}<br>
      + daily bonus ${fmt(c.bonusEach)}</div>`;
  const n = c.nana;
  $('commNanaSummary').innerHTML = `
    <div><span class="label">Each person</span><span class="comm-each">${fmt(n.commissionEach)}</span></div>
    <div class="comm-calc">cash ${fmt(n.cash)} · card ${fmt(n.card)}<br>
      ${Math.round(n.rate * 100)}% of ${fmt(n.totalSales)}${split(n.staff.length)}</div>`;
  $('commStaffNote').textContent = c.staffNote || '';
  $('commStaffNote').hidden = !c.staffNote;
  renderCommissionStaff();

  const bonusDays = c.days.filter((d) => d.total > 0);
  $('commNoDays').hidden = c.days.length > 0;
  $('commDays').innerHTML = (bonusDays.length ? bonusDays : []).map((d) => `
    <li><div class="row"><span class="name">${fmtDate(d.date)}<span class="sub">${c.shops.map((s) => `${esc(s)} ${fmt(d.sales[s])} → ${d.bonus[s]}`).join(' · ')}</span></span>
      <span class="amount">${fmt(d.total)}</span></div></li>`).join('')
    + (c.days.length ? `<li><div class="row total-row"><span>${bonusDays.length} of ${c.days.length} days earned a bonus</span><strong>${fmt(c.bonusEach)}</strong></div></li>` : '');
}

// One staff list with days off (− / + or type it) and the amount to pay; group is 't21' or 'nana'
function commStaffRows(group, names, each) {
  if (!names.length) return { html: '<li><div class="row"><span class="name">No staff found<span class="sub">Add them in Burmelin Office: Settings → Staff.</span></span></div></li>', total: 0 };
  let total = 0;
  const html = names.map((name, i) => {
    const off = getOff(COMM.month, name);
    const extra = Math.max(0, off - COMM_ALLOWED_OFF);
    const cut = Math.round((each / 30) * extra);
    total += each - cut;
    return `<li><div class="row comm-staff">
      <span class="name">${esc(name)}<span class="sub ${extra ? 'overdue' : ''}">${extra ? `${extra} extra day${extra === 1 ? '' : 's'} off: −${fmt(cut)}` : 'no deduction'}${offSource(name) ? ` · ${offSource(name)}` : ''}</span></span>
      <span class="stepper">
        <button type="button" data-step="-1" data-group="${group}" data-i="${i}" aria-label="One day off less">−</button>
        <input type="number" inputmode="decimal" min="0" max="31" step="0.5" class="comm-off" data-group="${group}" data-i="${i}" value="${off}" aria-label="Days off for ${esc(name)}">
        <button type="button" data-step="1" data-group="${group}" data-i="${i}" aria-label="One day off more">+</button>
      </span>
      <span class="amount">${fmt(each - cut)}</span>
    </div></li>`;
  }).join('');
  return { html, total };
}
function renderCommissionStaff() {
  const c = COMM;
  const t21 = commStaffRows('t21', c.staff, c.commissionEach + c.bonusEach);
  const nana = commStaffRows('nana', c.nana.staff, c.nana.commissionEach);
  $('commStaff').innerHTML = t21.html;
  $('commNanaStaff').innerHTML = nana.html;
  $('commTotal').textContent = fmt(t21.total);
  $('commNanaTotal').textContent = fmt(nana.total);
  renderPayday();
}

$('commMonth').addEventListener('change', () => { if ($('commMonth').value) openCommission($('commMonth').value); });
function shiftMonth(n) {
  const [y, m] = ($('commMonth').value || thisMonth()).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  openCommission(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
}
$('commPrev').addEventListener('click', () => shiftMonth(-1));
$('commNext').addEventListener('click', () => shiftMonth(1));
function onDaysOff(e) {
  const el = e.target.closest('.comm-off');
  if (!el || !COMM) return;
  const names = el.dataset.group === 'nana' ? COMM.nana.staff : COMM.staff;
  setOff(COMM.month, names[+el.dataset.i], Math.min(31, Math.max(0, Math.round((parseFloat(el.value) || 0) * 2) / 2)));
  renderCommissionStaff();
}
function onDaysOffStep(e) {
  const b = e.target.closest('[data-step]');
  if (!b || !COMM) return;
  const names = b.dataset.group === 'nana' ? COMM.nana.staff : COMM.staff;
  const name = names[+b.dataset.i];
  setOff(COMM.month, name, Math.min(31, Math.max(0, getOff(COMM.month, name) + Number(b.dataset.step))));
  renderCommissionStaff();
}
['commStaff', 'commNanaStaff'].forEach((id) => {
  $(id).addEventListener('change', onDaysOff);
  $(id).addEventListener('click', onDaysOffStep);
});

// ================= Salary and advances =================
// Each staff member's monthly salary (shops and Palladium), the advances they took (Salary rows with "advance" and
// their name in the note) and what they owe. The Payday card below does the cut and the pay.
// The server does the counting (api/_advances.js); salaries and amounts taken off are saved
// in the finance sheet so every phone shows the same.
let ADV = null;
async function loadAdvances(month) {
  $('advStaff').innerHTML = '<li><div class="row"><span class="name">Loading…</span></div></li>';
  $('advList').innerHTML = ''; $('advNote').hidden = true;
  try {
    const resp = await api(`/api/advances?month=${month}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server error');
    if ($('commMonth').value !== month) return;   // the month changed while loading
    ADV = data;
    renderAdvances();
  } catch (err) {
    $('advStaff').innerHTML = `<li><div class="row"><span class="name">Could not load: ${esc(err.message)}</span></div></li>`;
  }
}

function advTotal() {
  const missing = ADV.staff.filter((p) => !p.salary).length;
  $('advMissing').textContent = missing ? `${missing} ${missing === 1 ? 'person has' : 'people have'} no salary typed yet.` : '';
  renderPayday();
}
function renderAdvances() {
  const a = ADV;
  $('advNote').textContent = a.staffNote || '';
  $('advNote').hidden = !a.staffNote;
  if (!a.staff.length) {
    $('advStaff').innerHTML = '<li><div class="row"><span class="name">No staff found<span class="sub">Add them in Burmelin Office: Settings → Staff.</span></span></div></li>';
  } else {
    $('advStaff').innerHTML = a.staff.map((p, i) => {
      return `<li><div class="row adv-row">
        <span class="name">${esc(p.name)}<span class="sub ${p.owes ? 'overdue' : ''}">${p.owes ? `owes ${fmt(p.owes)} in advances` : 'no advance owed'}</span></span>
        <input type="number" inputmode="numeric" min="0" step="1" class="adv-salary" data-i="${i}" value="${p.salary || ''}" placeholder="0" aria-label="Monthly salary for ${esc(p.name)}">
      </div></li>`;
    }).join('');
  }
  advTotal();

  const items = a.staff.flatMap((p) => p.items.map((it) => ({ ...it, who: p.name })))
    .concat(a.unmatched.map((it) => ({ ...it, who: '' })))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.row - y.row));
  $('advList').innerHTML = items.length ? items.map((it) => `
    <li><div class="row"><span class="name">${it.who ? esc(it.who) : '<span class="overdue">Whose advance?</span>'}
      <span class="sub ${it.who ? '' : 'overdue'}">${fmtDate(it.date)} · ${esc(it.shop)} · “${esc(String(it.notes).replace(/ · \d\d:\d\d$/, ''))}”${it.who ? '' : ` · no name found: fix the note in Master Entry row ${it.row}`}</span></span>
      <span class="amount">${fmt(it.amount)}</span></div></li>`).join('')
    : '<li><div class="row"><span class="name sub">No advances this month.</span></div></li>';

  const sel = $('advName');
  const was = sel.value;
  sel.innerHTML = a.staff.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  if (was) sel.value = was;
  if (!$('advDate').value) $('advDate').value = todayLocalISO();
}

// Saves a salary or an advance cut a moment after the last key press
const advSaving = {};
function saveAdvField(kind, p) {
  const month = ADV.month, key = kind + '|' + p.name;
  clearTimeout(advSaving[key]);
  advSaving[key] = setTimeout(async () => {
    try {
      const resp = await api('/api/advances', { method: 'POST', body: JSON.stringify({ kind, month, name: p.name, amount: kind === 'salary' ? p.salary : p.deduct }) });
      if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
    } catch (err) {
      $('advNote').textContent = `${kind === 'salary' ? 'Salary' : 'Advance cut'} for ${p.name} was not saved (${err.message}). Type it again to retry.`;
      $('advNote').hidden = false;
    }
  }, 700);
}
function onSalaryInput(e) {
  const el = e.target.closest('.adv-salary');
  if (!el || !ADV) return;
  const p = ADV.staff[+el.dataset.i];
  p.salary = Math.max(0, Math.round(parseFloat(el.value) || 0));
  p.pay = Math.max(0, p.salary - p.deduct);
  saveAdvField('salary', p);
  advTotal();
}
$('advStaff').addEventListener('input', onSalaryInput);

// The owner paid an advance by hand (from Palladium's cash or the bank): a Salary row whose
// note is "<name> Advance", so it's counted like the ones staff type in Loyverse.
$('advForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!ADV) return;
  const name = $('advName').value, amount = Math.round(parseFloat($('advAmount').value) || 0), date = $('advDate').value;
  if (!name || amount <= 0 || !date) return showToast('Pick a person, an amount and a date', 'error', 'advToast');
  const bank = $('advFrom').value === 'bank';
  const btn = $('advSave');
  btn.disabled = true;
  try {
    await saveJSON('/api/transaction', 'POST', { category: 'Salary', shop: 'Palladium', date, notes: `${name} Advance`,
      cashOut: bank ? 0 : amount, bankOut: bank ? amount : 0 });
    showToast(`Saved: ${name} advance ${fmt(amount)}`, 'success', 'advToast');
    $('advAmount').value = '';
    loadDashboardSoon();
    loadAdvances(ADV.month);
  } catch (err) {
    showToast(err.message, 'error', 'advToast');
  } finally {
    btn.disabled = false;
  }
});

// ================= Payday: salary − advance + commission, and "Mark as paid" =================
// Commission per person for the month, as the Terminal 21 and Nana cards show it
function commissionByName() {
  const out = {};
  if (!COMM || !ADV || COMM.month !== ADV.month) return null;
  const add = (names, each) => names.forEach((name) => {
    const extra = Math.max(0, getOff(COMM.month, name) - COMM_ALLOWED_OFF);
    out[name] = (out[name] || 0) + each - Math.round((each / 30) * extra);
  });
  add(COMM.staff, COMM.commissionEach + COMM.bonusEach);
  add(COMM.nana.staff, COMM.nana.commissionEach);
  return out;
}
// Today's figures for everyone with a salary, commission or an advance owed
function paydayNow() {
  const comm = commissionByName();
  if (!comm) return null;
  const people = new Map();
  for (const p of ADV.staff) people.set(p.name, { name: p.name, salary: p.salary, deduct: p.deduct, owes: p.owes, commission: 0 });
  for (const [name, c] of Object.entries(comm)) {
    const p = people.get(name) || { name, salary: 0, deduct: 0, owes: 0, commission: 0 };
    p.commission = Math.round(c);
    people.set(name, p);
  }
  return [...people.values()].map((p) => ({ ...p, pay: Math.max(0, p.salary - p.deduct) + p.commission }))
    .filter((p) => p.salary || p.owes || p.commission);
}
const payParts = (p) => [p.salary ? `salary ${fmt(p.salary)}` : '', p.commission ? `+ commission & bonus ${fmt(p.commission)}` : '', p.deduct ? `− advance ${fmt(p.deduct)}` : '']
  .filter(Boolean).join(' ').replace(/^[+−] /, '') || 'nothing';
// The text part of one person's row and their button (the cut box is left alone while typing)
function payRowBits(name) {
  const now = paydayNow() || [];
  const live = now.find((p) => p.name === name);
  const saved = (ADV.payroll || []).find((p) => p.name === name);
  const shown = saved || live;
  const changed = saved && (!live || live.pay !== saved.pay);
  const owes = live && live.owes ? `<span class="sub overdue">owes ${fmt(live.owes)} in advances${live.deduct ? `, ${fmt(live.owes - live.deduct)} left after this cut` : ''}</span>` : '';
  const status = saved ? `<span class="sub paid-tag">Paid ${saved.paidAt ? fmtDate(saved.paidAt) : ''}: ${fmt(saved.pay)}</span>${changed ? `<span class="sub overdue">changed since: now ${fmt(live ? live.pay : 0)}</span>` : ''}` : '';
  return {
    text: `${esc(name)}<span class="sub">${payParts(live || saved)}</span>${owes}${status}`,
    pay: fmt(live ? live.pay : shown.pay),
    btn: !saved ? `<button type="button" class="pay-one" data-name="${esc(name)}">Pay</button>`
      : changed && live ? `<button type="button" class="pay-one ghost" data-name="${esc(name)}">Update</button>`
      : '<span class="pay-done">✓</span>',
  };
}
function renderPayday() {
  const now = paydayNow();
  if (!now) { $('payList').innerHTML = ''; $('payTotal').textContent = '—'; $('payStatus').textContent = 'Loading…'; return; }
  const saved = ADV.payroll || [];
  const names = now.map((p) => p.name).concat(saved.map((p) => p.name).filter((n) => !now.some((p) => p.name === n)));
  $('payList').innerHTML = names.length ? names.map((name) => {
    const live = now.find((p) => p.name === name);
    const bits = payRowBits(name);
    return `<li><div class="pay-row" data-name="${esc(name)}">
      <span class="name pay-text">${bits.text}</span>
      <div class="pay-ctl">
        <label class="pay-cut-l"><span>Advance cut</span>
          <input type="number" inputmode="numeric" min="0" step="1" class="pay-cut" value="${live && live.deduct ? live.deduct : ''}" placeholder="0" ${live && live.owes ? '' : 'disabled'} aria-label="Advance to cut from ${esc(name)}'s pay"></label>
        <span class="amount pay-amt">${bits.pay}</span>
        <span class="pay-btn">${bits.btn}</span>
      </div></div></li>`;
  }).join('') : '<li><div class="row"><span class="name sub">Type salaries below to see the pay.</span></div></li>';
  payTotals();
}
function payTotals() {
  const now = paydayNow() || [];
  const savedBy = new Map((ADV.payroll || []).map((p) => [p.name, p]));
  $('payTotal').textContent = fmt(now.reduce((n, p) => n + p.pay, 0));
  const unpaid = now.filter((p) => !savedBy.has(p.name));
  const st = $('payStatus');
  st.classList.toggle('paid', savedBy.size > 0 && !unpaid.length);
  st.textContent = !unpaid.length ? `Everyone is paid for ${monthLabel(ADV.month)}.`
    : `${savedBy.size ? `${savedBy.size} paid, ${unpaid.length} still to pay. ` : ''}${ADV.month === thisMonth() ? 'This month is still running: commission can still go up.' : ''}`;
  $('payMark').hidden = unpaid.length < 2;
  $('payMark').textContent = savedBy.size ? `Pay the other ${unpaid.length}` : `Pay all ${unpaid.length}`;
}
// Typing the advance cut: work out the pay again in place, and save the cut
$('payList').addEventListener('input', (e) => {
  const el = e.target.closest('.pay-cut');
  if (!el || !ADV) return;
  const row = el.closest('.pay-row'), name = row.dataset.name;
  const p = ADV.staff.find((x) => x.name === name);
  if (!p) return;
  p.deduct = Math.min(Math.max(0, Math.round(parseFloat(el.value) || 0)), p.owes);
  p.pay = Math.max(0, p.salary - p.deduct);
  p.owesAfter = p.owes - p.deduct;
  saveAdvField('deduct', p);
  const bits = payRowBits(name);
  row.querySelector('.pay-text').innerHTML = bits.text;
  row.querySelector('.pay-amt').textContent = bits.pay;
  row.querySelector('.pay-btn').innerHTML = bits.btn;
  payTotals();
});
$('payList').addEventListener('change', (e) => {
  const el = e.target.closest('.pay-cut');
  if (!el || !ADV) return;
  const p = ADV.staff.find((x) => x.name === el.closest('.pay-row').dataset.name);
  if (p && String(p.deduct || '') !== el.value) el.value = p.deduct || '';   // more than owed: shows the most it can be
});
// Saves these people's pay as paid today (the others keep what was saved for them)
async function markPaid(people, btn) {
  const month = ADV.month;
  btn.disabled = true;
  try {
    const data = await saveJSON('/api/advances', 'POST', { kind: 'payroll', month, people });
    if (ADV.month === month) {
      const names = new Set(people.map((p) => p.name));
      ADV.payroll = (ADV.payroll || []).filter((p) => !names.has(p.name)).concat(people.map((p) => ({ ...p, paidAt: data.paidAt || todayLocalISO() })));
      renderPayday();
    }
    showToast(people.length === 1 ? `${people[0].name}: ${fmt(people[0].pay)} paid` : `${people.length} people paid`, 'success', 'payToast');
  } catch (err) {
    showToast(err.message, 'error', 'payToast');
    btn.disabled = false;
  }
}
$('payList').addEventListener('click', (e) => {
  const b = e.target.closest('.pay-one');
  if (!b || !ADV) return;
  const p = (paydayNow() || []).find((x) => x.name === b.dataset.name);
  if (p) markPaid([p], b);
});
$('payMark').addEventListener('click', () => {
  const savedBy = new Set((ADV.payroll || []).map((p) => p.name));
  const unpaid = (paydayNow() || []).filter((p) => !savedBy.has(p.name));
  if (unpaid.length && confirm(`Save ${unpaid.length} people as paid today?`)) markPaid(unpaid, $('payMark'));
});

// ================= daily statement =================
// Opening balance, each shop's drawer cash and bank, sales, every expense and pay-out, and
// the closing balance, for the dates picked (one day by default). The numbers come from
// finance/statement.js; this part only draws them, prints them and shares them as a PDF.
let ST = null;   // the last statement drawn

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function longDate(iso, withDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${withDay ? day + ' ' : ''}${d} ${MONTH_NAMES[m - 1]} ${y}`;
}
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTH_NAMES[m - 1]}`; };
// Table figures: no ฿ (the heading says so), a dash for nothing, a minus sign for less than zero
const n0 = (v) => { const r = Math.round(v); return r === 0 ? '–' : (r < 0 ? '−' : '') + Math.abs(r).toLocaleString('en-US'); };
const baht = (v) => { const r = Math.round(v); return (r < 0 ? '−฿' : '฿') + Math.abs(r).toLocaleString('en-US'); };
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? x - 1 : +x)))) / 86400000) + 1;

function setStRange(kind) {
  const now = new Date();
  let from = now, to = now;
  if (kind === 'yesterday') { from = to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); }
  if (kind === 'week') { from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6); }
  if (kind === 'month') { from = new Date(now.getFullYear(), now.getMonth(), 1); }
  $('stFrom').value = isoOf(from); $('stTo').value = isoOf(to);
  renderStatement();
}

async function openStatement() {
  if (!$('stFrom').value) { $('stFrom').value = $('stTo').value = todayLocalISO(); }
  TX = null;   // always fresh numbers on opening the tab
  renderStatement();
}

async function renderStatement() {
  const from = $('stFrom').value, to = $('stTo').value;
  document.querySelectorAll('.stmt-quick .chip').forEach((c) => c.classList.remove('on'));
  const state = $('stState');
  if (!from || !to) return;
  if (from > to) { state.hidden = false; state.classList.add('error'); state.textContent = 'The first date must be before the second.'; $('stDoc').innerHTML = ''; return; }
  // A statement already on screen just fades while the new one loads (no "Loading…" block above it)
  const redraw = !!$('stDoc').innerHTML;
  state.classList.remove('error');
  if (redraw) { state.hidden = true; $('stDoc').classList.add('stale'); }
  else { state.hidden = false; state.textContent = 'Loading…'; }
  try {
    const tx = await loadTx();
    if (!LISTS) {
      const resp = await api('/api/dashboard');
      if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
      LISTS = (await resp.json()).lists;
    }
    ST = Statement.build(tx, LISTS, from, to);
    ST.madeAt = new Date();
    $('stDoc').innerHTML = statementHtml(ST);
    state.hidden = true;
  } catch (err) {
    state.hidden = false; state.classList.add('error'); state.textContent = 'Could not load: ' + err.message;
  } finally {
    $('stDoc').classList.remove('stale');
  }
}

function statementHtml(s) {
  const one = s.from === s.to;
  const nDays = daysBetween(s.from, s.to);
  const period = one ? longDate(s.from, true) : `${longDate(s.from, true)} – ${longDate(s.to, true)} · ${nDays} days`;
  const cols = s.shops.concat(s.other ? ['Other'] : []);
  const colOf = (name) => (name === 'Other' ? s.other : s.per[name]);
  const head = `<tr><th></th>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num tot">Total</th></tr>`;
  // one line of the shop table; skipped when every shop has nothing (unless keep)
  const line = (label, key, sign, cls = '', keep = false) => {
    const vals = cols.map((c) => colOf(c)[key] || 0);
    const total = key === 'open' ? s.shops.reduce((n, c) => n + s.open.shop[c], 0) : s.totals[key] ?? vals.reduce((a, b) => a + b, 0);
    if (!keep && !vals.some((v) => Math.round(v)) && !Math.round(total)) return '';
    const fmtv = (v) => (sign && Math.round(v) ? sign + ' ' : '') + n0(v);
    return `<tr class="${cls}"><td>${label}</td>${vals.map((v) => `<td class="num">${fmtv(v)}</td>`).join('')}<td class="num tot">${fmtv(total)}</td></tr>`;
  };
  const shopSales = (c) => { const p = colOf(c); return p.cashSales + p.bankSales + p.credit; };
  const shopTable = `
    <table class="st-shops">
      <thead>${head}</thead>
      <tbody>
        <tr class="sect"><td colspan="${cols.length + 2}">Drawer cash (counter)</td></tr>
        ${line('Opening cash', 'open', '', 'strong', true)}
        ${line('Cash sales', 'cashSales', '+', '', true)}
        ${line('Customer payments (cash)', 'payIn', '+')}
        ${line('Collected from shops', 'collIn', '+')}
        ${line('Other cash in', 'otherIn', '+')}
        ${line('Expenses paid from drawer', 'expCash', '−', '', true)}
        ${line('Collection sent to Palladium', 'collOut', '−')}
        ${line('Deposited to bank', 'toBank', '−')}
        ${line('Adjustments / other out', 'otherOut', '−')}
        ${line('Closing cash', 'cash', '', 'strong rule', true)}
        <tr class="sect"><td colspan="${cols.length + 2}">Bank (card / QR / transfer)</td></tr>
        ${line('Card / QR sales', 'bankSales', '+', '', true)}
        ${line('Card fee (estimated)', 'cardFee', '−')}
        ${line('Other money into bank', 'bankOtherIn', '+')}
        ${line('Paid from bank', 'bankOut', '−')}
        <tr class="sect"><td colspan="${cols.length + 2}">Sales</td></tr>
        ${line('Credit sales', 'credit', '')}
        <tr class="strong rule"><td>Total sales</td>${cols.map((c) => `<td class="num">${n0(shopSales(c))}</td>`).join('')}<td class="num tot">${n0(s.sales.total)}</td></tr>
      </tbody>
    </table>`;

  const daily = one || !s.days.length ? '' : `
    <h3>Daily sales <span>cash + card/QR + credit</span></h3>
    <table class="st-days">
      <thead><tr><th>Date</th>${s.shops.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num tot">Total</th></tr></thead>
      <tbody>${s.days.map((d) => `<tr><td>${WEEKDAYS[new Date(d.date + 'T00:00').getDay()]} ${shortDate(d.date)}</td>${s.shops.map((c) => `<td class="num">${n0(d.byShop[c] || 0)}</td>`).join('')}<td class="num tot">${n0(d.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${s.shops.map((c) => `<td class="num">${n0(shopSales(c))}</td>`).join('')}<td class="num tot">${n0(s.sales.total)}</td></tr></tfoot>
    </table>`;

  const listTable = (rows, title, sub, empty) => {
    const cash = rows.reduce((n, r) => n + r.cash, 0), bank = rows.reduce((n, r) => n + r.bank, 0);
    if (!rows.length) return empty ? `<h3>${title}</h3><p class="st-none">${empty}</p>` : '';
    return `
    <h3>${title} <span>${sub}</span></h3>
    <table class="st-list">
      <thead><tr>${one ? '' : '<th>Date</th>'}<th>Shop</th><th>What</th><th class="num">Cash</th><th class="num">Bank</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${one ? '' : `<td class="nowrap">${shortDate(r.date)}</td>`}<td class="nowrap">${esc(r.shop)}</td>
        <td><b>${esc(r.category)}</b>${r.customer ? ' · ' + esc(r.customer) : ''}${r.notes ? `<br><span class="note">${esc(r.notes)}</span>` : ''}</td>
        <td class="num">${n0(r.cash)}</td><td class="num">${n0(r.bank)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="${one ? 2 : 3}">Total · ${rows.length} item${rows.length === 1 ? '' : 's'}</td><td class="num">${n0(cash)}</td><td class="num">${n0(bank)}</td></tr></tfoot>
    </table>`;
  };
  const byCat = Object.entries(s.expByCat).sort((a, b) => b[1] - a[1]);
  const catLine = byCat.length > 1 ? `<p class="st-cats">${byCat.map(([c, v]) => `${esc(c)} <b>${baht(v)}</b>`).join(' · ')}</p>` : '';

  const expTotal = s.expenseTotal.cash + s.expenseTotal.bank;
  return `
    <header class="st-head">
      <div><div class="st-brand">Burmelin</div><h2>${one ? 'Daily statement' : 'Statement'}</h2><div class="st-period">${period}</div></div>
      <div class="st-made">Made ${longDate(isoOf(s.madeAt))}, ${s.madeAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}<br>Amounts in Thai baht</div>
    </header>

    <table class="st-summary">
      <thead><tr><th></th><th class="num">Opening</th><th class="num">Change</th><th class="num">Closing</th></tr></thead>
      <tbody>
        <tr><td>Cash in all drawers</td><td class="num">${baht(s.open.cash)}</td><td class="num">${n0(s.close.cash - s.open.cash)}</td><td class="num">${baht(s.close.cash)}</td></tr>
        <tr><td>Bank (one shared account)${s.cardFee ? `<br><span class="note">after card fee ${baht(s.cardFee)} (estimate)</span>` : ''}</td><td class="num">${baht(s.open.bank)}</td><td class="num">${n0(s.close.bank - s.open.bank)}</td><td class="num">${baht(s.close.bank)}</td></tr>
        <tr class="strong"><td>Total cash + bank</td><td class="num">${baht(s.open.total)}</td><td class="num">${n0(s.close.total - s.open.total)}</td><td class="num">${baht(s.close.total)}</td></tr>
        <tr class="muted"><td>Credit customers owe</td><td class="num">${baht(s.open.credit)}</td><td class="num">${n0(s.close.credit - s.open.credit)}</td><td class="num">${baht(s.close.credit)}</td></tr>
      </tbody>
    </table>

    <div class="st-kpis">
      <div><span>Sales</span><b>${baht(s.sales.total)}</b><small>cash ${n0(s.sales.cash)} · bank ${n0(s.sales.bank)}${s.sales.credit ? ' · credit ' + n0(s.sales.credit) : ''}</small></div>
      <div><span>Expenses</span><b>${baht(expTotal)}</b><small>cash ${n0(s.expenseTotal.cash)} · bank ${n0(s.expenseTotal.bank)}</small></div>
    </div>

    <h3>By shop</h3>
    <div class="st-wide">${shopTable}</div>
    ${daily}
    ${listTable(s.expenses, 'Expenses and pay-outs', 'salary, rent, stock, small costs', 'No expenses in these dates.')}
    ${catLine}
    ${listTable(s.moves, 'Collections, deposits and adjustments', 'money moved, not spent')}
    ${listTable(s.incomes, 'Other money in', 'customer payments, adjustments')}
    <p class="st-foot">Opening = everything recorded before ${longDate(s.from)}. Closing = opening + this period. Drawer and bank figures match the Finance dashboard. Card sales count in full as sales; the bank's card fee (QR has none) is an estimate until the bank's statement is checked, booked each day as a Card Fee expense, so Bank shows what the bank pays in. The bank is one account shared by all shops, so per shop it shows only what came in or went out through that shop.</p>`;
}

$('reportSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-report]');
  if (!b) return;
  $('reportSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  $('stPanel').hidden = b.dataset.report !== 'statement';
  $('bankCard').hidden = b.dataset.report !== 'bank';
  if (b.dataset.report === 'bank') loadBankCard();
});

$('stFrom').addEventListener('change', renderStatement);
$('stTo').addEventListener('change', renderStatement);
document.querySelector('.stmt-quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (b) { setStRange(b.dataset.range); b.classList.add('on'); }
});

function statementFileName() {
  if (!ST) return 'Burmelin-statement';
  return 'Burmelin-statement-' + (ST.from === ST.to ? ST.from : ST.from + '_to_' + ST.to);
}

// Print: the statement alone, on A4 (see @media print in styles.css)
function printStatement() {
  if (!ST) return;
  // iOS home-screen apps ignore window.print(): the share sheet has Print instead
  if (window.navigator.standalone === true) { shareStatement(); return; }
  $('printArea').innerHTML = `<article class="stmt">${$('stDoc').innerHTML}</article>`;
  window.print();
}
$('stPrintBtn').addEventListener('click', printStatement);

// Share: an A4 PDF handed to the phone's share sheet (WhatsApp, LINE, Mail, Save to Files, Print).
// Where sharing files isn't possible (most computers) the PDF is downloaded instead.
function loadHtml2Pdf() {
  if (window.html2pdf) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    sc.onload = () => (window.html2pdf ? resolve() : reject(new Error('PDF tool did not load')));
    sc.onerror = () => reject(new Error('Could not load the PDF tool. Check the connection.'));
    document.head.appendChild(sc);
  });
}
async function statementPdf() {
  await loadHtml2Pdf();
  // Drawn off-screen at A4 width so the PDF looks the same from any phone
  const box = document.createElement('div');
  box.className = 'pdf-stage';
  box.innerHTML = `<article class="stmt pdf">${$('stDoc').innerHTML}</article>`;
  document.body.appendChild(box);
  try {
    const blob = await html2pdf().set({
      margin: [10, 10, 12, 10],
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'h3', '.st-kpis'] },
    }).from(box.firstElementChild).outputPdf('blob');
    return new File([blob], statementFileName() + '.pdf', { type: 'application/pdf' });
  } finally {
    box.remove();
  }
}
async function shareStatement() {
  if (!ST) return;
  const btn = $('stShareBtn');
  const label = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Making PDF…';
  try {
    const file = await statementPdf();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name.replace(/\.pdf$/, '') }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  } catch (err) {
    alert('Could not make the PDF: ' + err.message);
  } finally {
    btn.disabled = false; btn.innerHTML = label;
  }
}
$('stShareBtn').addEventListener('click', shareStatement);

// Signed in through the staff app's admin login: a way back to it
$('officeLink').hidden = !ownerToken();


// go
localStorage.removeItem('appPin');   // the old finance PIN is not used any more
if (!ownerToken()) showOwnerGate();
else renewOwnerToken().finally(loadDashboard);
