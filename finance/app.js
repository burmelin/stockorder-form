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

// ---- PIN handling (the PIN is in the finance sheet: Lists tab, cell K2) ----
function getPin() { return localStorage.getItem('appPin') || ''; }
async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-app-pin': getPin() }, opts.headers);
  let resp = await fetch(path, opts);
  if (resp.status === 401) {
    const pin = prompt('Enter your PIN (it is in your finance Google Sheet: Lists tab, cell K2)');
    if (pin === null) throw new Error('PIN required');
    localStorage.setItem('appPin', pin);
    opts.headers['x-app-pin'] = pin;
    resp = await fetch(path, opts);
    if (resp.status === 401) { localStorage.removeItem('appPin'); throw new Error('Wrong PIN'); }
  }
  return resp;
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

// ---- tabs ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (editingRow !== null) {
      editingRow = null;
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
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('page-dashboard').hidden = btn.dataset.page !== 'dashboard';
    $('page-daily').hidden = btn.dataset.page !== 'daily';
    $('page-record').hidden = btn.dataset.page !== 'record';
    $('page-detail').hidden = true;
    $('page-commission').hidden = true;
  });
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
    populateForm();
    loadCommissionCard();
    initBankCard();
    load.hidden = true;
    $('dashContent').hidden = false;
  } catch (err) {
    load.classList.add('error');
    load.textContent = 'Could not load: ' + err.message;
  }
}

function renderDashboard(d) {
  $('mockBanner').hidden = !d.mock;
  $('totalCash').textContent = fmt(d.totals.cash);
  $('totalBank').textContent = fmt(d.totals.bank);
  $('totalGrand').textContent = fmt(d.totals.grand);

  $('shopList').innerHTML = d.shops.map((s) => `
    <li><div class="row tappable" data-shop="${esc(s.name)}">
      <span class="name">${esc(s.name)}</span>
      <span class="amount ${s.cash < 0 ? 'neg' : 'pos'}">${fmt(s.cash)}<span class="chevron">›</span></span>
    </div></li>`).join('');

  $('creditList').innerHTML = d.credit.map((c) => {
    let sub = 'no payment recorded';
    let overdue = true;
    if (c.daysSince !== null && c.daysSince !== undefined) {
      sub = c.daysSince === 0 ? 'paid today' : `last paid ${c.daysSince} day${c.daysSince === 1 ? '' : 's'} ago`;
      overdue = c.daysSince > (c.overdueDays || 30);
    }
    if (c.balance === 0) { sub = 'settled'; overdue = false; }
    return `
    <li><div class="row tappable" data-customer="${esc(c.name)}">
      <span class="name">${esc(c.name)}<span class="sub ${overdue ? 'overdue' : ''}">${sub}</span></span>
      <span class="amount ${c.balance < 0 ? 'neg' : 'pos'}">${fmt(c.balance)}<span class="chevron">›</span></span>
    </div></li>`;
  }).join('');

  $('totalCredit').textContent = fmt(d.totalCredit);
  $('updatedAt').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
}

function esc(s) { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; }

$('refreshBtn').addEventListener('click', () => { TX = null; loadDashboard(); });

// ---- Bicasso bank sales: card / QR money from the Retail Sale rows (Bank In) of
// Bicasso 1 and 2, for the dates picked. Defaults to this month so far. ----
const BANK_SHOPS = ['Bicasso 1', 'Bicasso 2'];
function initBankCard() {
  if (!$('bankFrom').value) {
    const now = new Date();
    $('bankFrom').value = isoOf(new Date(now.getFullYear(), now.getMonth(), 1));
    $('bankTo').value = isoOf(now);
  }
  loadBankCard();
}
async function loadBankCard() {
  const r = { from: $('bankFrom').value || null, to: $('bankTo').value || null };
  if (r.from && r.to && r.from > r.to) {
    $('bankList').innerHTML = '<li><div class="row"><span class="name sub overdue">The first date must be before the second</span></div></li>';
    $('bankTotal').textContent = '—'; $('bankDays').textContent = ''; $('bankDaily').hidden = true;
    return;
  }
  $('bankList').innerHTML = '<li><div class="row"><span class="name sub">Loading…</span></div></li>';
  let tx;
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
  const days = [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  $('bankDaily').hidden = !days.length;
  $('bankDayList').innerHTML = days.map(([date, d]) => `
    <li><div class="row"><span class="name">${fmtDate(date)}<span class="sub">${BANK_SHOPS.map((s) => `${s.replace('Bicasso ', 'B')} ${fmt(d[s])}`).join(' · ')}</span></span>
      <span class="amount">${fmt(BANK_SHOPS.reduce((n, s) => n + d[s], 0))}</span></div></li>`).join('');
}
$('bankFrom').addEventListener('change', loadBankCard);
$('bankTo').addEventListener('change', loadBankCard);

// ================= per-shop / per-customer detail =================
let TX = null;
async function loadTx(force) {
  if (TX && !force) return TX;
  const resp = await api('/api/transactions');
  if (!resp.ok) throw new Error((await resp.json()).error || 'Server error');
  TX = (await resp.json()).transactions;
  return TX;
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
  $('page-dashboard').hidden = true;
  $('page-record').hidden = true;
  $('page-detail').hidden = false;
  $('page-detail').scrollTop = 0;
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

$('backBtn').addEventListener('click', () => {
  $('page-detail').hidden = true;
  $('page-dashboard').hidden = false;
});
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
  updateCollectionVisibility();
}

// ---- expense categories for the Daily screen (everything the sheet marks "Expense") ----
function expenseCategories() {
  const fromList = (LISTS && LISTS.categories || [])
    .filter((c) => c.type === 'Expense')
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
  if (isEdit) body.row = editingRow;

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

function startEdit(tx) {
  editingRow = tx.row;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.page === 'record'));
  $('page-dashboard').hidden = true;
  $('page-detail').hidden = true;
  $('page-record').hidden = false;
  $('page-record').scrollTop = 0;

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
    $('page-record').hidden = true;
    $('page-detail').hidden = false;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.page === 'dashboard'));
    openDetail(currentDetail.kind, currentDetail.name);
  }
}

$('cancelEdit').addEventListener('click', cancelEdit);

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
$('dShop').addEventListener('change', updateCollectionVisibility);
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

async function loadCommissionCard() {
  try {
    const c = await fetchCommission(thisMonth());
    $('commHint').textContent = `${monthLabel(c.month)} so far`;
    $('commEach').textContent = fmt(c.commissionEach + c.bonusEach);
    $('commSub').textContent = `commission ${fmt(c.commissionEach)} + bonus ${fmt(c.bonusEach)} · sales ${fmt(c.totalSales)}`;
    $('commNanaEach').textContent = fmt(c.nana.commissionEach);
    $('commNanaSub').textContent = `1% of sales ${fmt(c.nana.totalSales)}` + (c.nana.staff.length ? '' : ' · no Nana staff found');
  } catch (err) {
    $('commSub').textContent = 'Could not load: ' + err.message;
  }
}

// Days off are only needed at month end; remember what was typed per month on this phone.
const offKey = (month, name) => `commOff:${month}:${name}`;
function getOff(month, name) { try { return parseInt(localStorage.getItem(offKey(month, name)), 10) || 0; } catch (e) { return 0; } }
function setOff(month, name, n) { try { localStorage.setItem(offKey(month, name), String(n)); } catch (e) { /* private mode: fine */ } }

let COMM = null;
async function openCommission(month) {
  $('page-dashboard').hidden = true;
  $('page-commission').hidden = false;
  $('page-commission').scrollTop = 0;
  $('commMonth').value = month;
  $('commPeriod').textContent = 'Loading…';
  $('commSummary').innerHTML = ''; $('commStaff').innerHTML = ''; $('commDays').innerHTML = '';
  $('commNanaSummary').innerHTML = ''; $('commNanaStaff').innerHTML = ''; $('commStaffNote').hidden = true;
  try {
    COMM = await fetchCommission(month);
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
  $('commSummary').innerHTML = `
    ${c.shops.map((s) => `<div class="total-card"><span class="label">${esc(s)} sales</span><span class="value">${fmt(c.sales[s])}</span></div>`).join('')}
    <div class="total-card"><span class="label">${Math.round(c.rate * 100)}% pool</span><span class="value">${fmt(c.pool)}</span></div>
    <div class="total-card in"><span class="label">Commission each</span><span class="value">${fmt(c.commissionEach)}</span></div>
    <div class="total-card in"><span class="label">Bonus each</span><span class="value">${fmt(c.bonusEach)}</span></div>
    <div class="total-card"><span class="label">Staff</span><span class="value">${c.staff.length}</span></div>
    <div class="total-card grand wide"><span class="label">Each person (before days off)</span><span class="value">${fmt(each)}</span></div>`;
  const n = c.nana;
  $('commNanaSummary').innerHTML = `
    <div class="total-card"><span class="label">Cash sales</span><span class="value">${fmt(n.cash)}</span></div>
    <div class="total-card"><span class="label">Card (neighbour)</span><span class="value">${fmt(n.card)}</span></div>
    <div class="total-card"><span class="label">${Math.round(n.rate * 100)}% of ${fmt(n.totalSales)}</span><span class="value">${fmt(n.pool)}</span></div>
    <div class="total-card"><span class="label">Staff</span><span class="value">${n.staff.length}</span></div>
    <div class="total-card grand wide"><span class="label">Each person (before days off)</span><span class="value">${fmt(n.commissionEach)}</span></div>`;
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

// One staff list with days off and the amount to pay; group is 't21' or 'nana'
function commStaffRows(group, names, each) {
  if (!names.length) return '<li><div class="row"><span class="name">No staff found<span class="sub">Add them in Burmelin Office: Settings → Staff.</span></span></div></li>';
  return names.map((name, i) => {
    const off = getOff(COMM.month, name);
    const extra = Math.max(0, off - COMM_ALLOWED_OFF);
    const cut = Math.round((each / 30) * extra);
    return `<li><div class="row comm-staff">
      <span class="name">${esc(name)}<span class="sub">${extra ? `${extra} extra day${extra === 1 ? '' : 's'} off: −${fmt(cut)}` : 'no deduction'}</span></span>
      <label class="comm-off-wrap">days off <input type="number" inputmode="numeric" min="0" max="31" class="comm-off" data-group="${group}" data-i="${i}" value="${off || ''}" placeholder="0"></label>
      <span class="amount">${fmt(each - cut)}</span>
    </div></li>`;
  }).join('');
}
function renderCommissionStaff() {
  const c = COMM;
  $('commStaff').innerHTML = commStaffRows('t21', c.staff, c.commissionEach + c.bonusEach);
  $('commNanaStaff').innerHTML = commStaffRows('nana', c.nana.staff, c.nana.commissionEach);
}

$('commRow').addEventListener('click', () => openCommission(thisMonth()));
$('commNanaRow').addEventListener('click', () => openCommission(thisMonth()));
$('commMonth').addEventListener('change', () => { if ($('commMonth').value) openCommission($('commMonth').value); });
$('commBackBtn').addEventListener('click', () => { $('page-commission').hidden = true; $('page-dashboard').hidden = false; });
function onDaysOff(e) {
  const el = e.target.closest('.comm-off');
  if (!el || !COMM) return;
  const names = el.dataset.group === 'nana' ? COMM.nana.staff : COMM.staff;
  setOff(COMM.month, names[+el.dataset.i], Math.max(0, parseInt(el.value, 10) || 0));
  renderCommissionStaff();
}
$('commStaff').addEventListener('change', onDaysOff);
$('commNanaStaff').addEventListener('change', onDaysOff);


// go
loadDashboard();
