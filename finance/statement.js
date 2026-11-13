/* Daily statement: opening balance, every shop's drawer cash and bank, sales, expenses
   and the closing balance for the dates picked. Pure functions (no page access), so the
   same code runs in the browser and in a quick Node check.

   Balances follow the Dashboard exactly (api/dashboard.js):
   - a shop's drawer = its Cash In − Cash Out; a Collection (to Palladium) also adds the
     collected cash to Palladium's drawer;
   - total cash = all Cash In − all Cash Out except collections (they only move cash);
   - bank is ONE shared account = all Bank In − all Bank Out. Per shop we can only show the
     bank money that came in or went out through that shop, not a separate balance.
   Opening = every row before the first day; closing = opening + the period's rows. */
(function (root) {
  const COLLECTION = 'Collection (to Palladium)';
  const SALES = ['Retail Sale', 'Scan / QR Payment'];
  const TO_BANK = ['Cash to Bank Deposit', 'Collection to Bank'];
  const CARD_FEE = 'Card Fee';   // the bank's estimated fee on card sales (Bank Out), see api/_loyverse.js planFees
  const FALLBACK_EXPENSES = ['Supplier Pay', 'Salary', 'Wages', 'Commission', 'Rent', 'Gov Tax', 'Home Expenses', 'Other Expense'];
  // Columns appear in this order when present; any other shop in the Lists tab follows
  const SHOP_ORDER = ['Bicasso 1', 'Bicasso 2', 'Nana', 'Palladium'];

  const zero = () => ({
    cash: 0, cashSales: 0, payIn: 0, collIn: 0, otherIn: 0,
    expCash: 0, collOut: 0, toBank: 0, otherOut: 0,
    bankSales: 0, bankOtherIn: 0, bankOut: 0, cardFee: 0, credit: 0,
  });

  function build(tx, lists, from, to) {
    const listed = (lists && lists.shops) || [];
    const shops = SHOP_ORDER.filter((s) => listed.includes(s)).concat(listed.filter((s) => !SHOP_ORDER.includes(s)));
    const expenseCats = new Set(((lists && lists.categories) || []).filter((c) => c.type === 'Expense').map((c) => c.name));
    if (!expenseCats.size) FALLBACK_EXPENSES.forEach((c) => expenseCats.add(c));
    expenseCats.add(CARD_FEE);   // written by the import even if the Lists tab doesn't name it
    const customers = new Set((lists && lists.customers) || []);
    const hasPalladium = shops.includes('Palladium');

    const open = { cash: 0, bank: 0, credit: 0, shop: Object.fromEntries(shops.map((s) => [s, 0])) };
    const per = Object.fromEntries(shops.map((s) => [s, zero()]));
    const other = zero();          // rows whose shop isn't in the Lists tab (normally none)
    const days = new Map();        // date -> { shop: sales }
    const expenses = [];           // expense and adjustment rows that took money out
    const moves = [];              // collections, deposits, ATM: money moved, not spent
    const incomes = [];            // money in that isn't a sale: customer payments, adjustments, bank received
    let periodCash = 0, periodBank = 0, periodCredit = 0;

    const sorted = tx.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row));
    for (const t of sorted) {
      if (to && t.date > to) continue;
      const cashDelta = t.cashIn - (t.category === COLLECTION ? 0 : t.cashOut);
      const bankDelta = t.bankIn - t.bankOut;
      let creditDelta = 0;
      if (customers.has(t.customer)) {
        if (t.category === 'Credit Sale') creditDelta = t.creditAmount;
        else if (t.category === 'Customer Payment') creditDelta = -(t.cashIn + t.bankIn);
      }

      if (from && t.date < from) {
        open.cash += cashDelta; open.bank += bankDelta; open.credit += creditDelta;
        if (t.shop in open.shop) {
          open.shop[t.shop] += t.cashIn - t.cashOut;
          if (t.category === COLLECTION && t.shop !== 'Palladium' && hasPalladium) open.shop.Palladium += t.cashOut;
        }
        continue;
      }

      periodCash += cashDelta; periodBank += bankDelta; periodCredit += creditDelta;
      const p = per[t.shop] || other;
      const cat = t.category;
      const isOpeningCredit = cat === 'Credit Sale' && /opening/i.test(t.notes || '');

      // cash in
      if (SALES.includes(cat)) p.cashSales += t.cashIn;
      else if (cat === 'Customer Payment') p.payIn += t.cashIn;
      else p.otherIn += t.cashIn;
      // cash out
      if (cat === COLLECTION) {
        p.collOut += t.cashOut;
        if (t.shop !== 'Palladium' && hasPalladium) per.Palladium.collIn += t.cashOut;
      } else if (expenseCats.has(cat)) p.expCash += t.cashOut;
      else if (TO_BANK.includes(cat)) p.toBank += t.cashOut;
      else p.otherOut += t.cashOut;
      // bank and credit
      if (SALES.includes(cat)) p.bankSales += t.bankIn; else p.bankOtherIn += t.bankIn;
      if (cat === CARD_FEE) p.cardFee += t.bankOut; else p.bankOut += t.bankOut;
      if (cat === 'Credit Sale' && !isOpeningCredit) p.credit += t.creditAmount;

      // daily sales (cash + card/QR + credit)
      const sale = (SALES.includes(cat) ? t.cashIn + t.bankIn : 0) + (cat === 'Credit Sale' && !isOpeningCredit ? t.creditAmount : 0);
      if (sale) {
        const d = days.get(t.date) || {};
        d[t.shop] = (d[t.shop] || 0) + sale;
        days.set(t.date, d);
      }

      // the lists
      const line = { date: t.date, shop: t.shop, category: cat, customer: t.customer, notes: t.notes || '' };
      if (t.cashOut || t.bankOut) {
        const item = { ...line, cash: t.cashOut, bank: t.bankOut };
        if (expenseCats.has(cat)) expenses.push(item);
        else moves.push(item);
      }
      if ((t.cashIn || t.bankIn) && !SALES.includes(cat)) {
        // the other half of a deposit / ATM is already in "moves"
        if (!TO_BANK.includes(cat) && cat !== 'Bank to Cash (ATM)') incomes.push({ ...line, cash: t.cashIn, bank: t.bankIn });
      }
    }

    // each drawer's closing cash
    for (const s of shops) {
      const p = per[s];
      p.open = open.shop[s];
      p.cash = p.open + p.cashSales + p.payIn + p.collIn + p.otherIn - p.expCash - p.collOut - p.toBank - p.otherOut;
    }
    const otherUsed = Object.values(other).some((v) => v);

    const sum = (key) => shops.reduce((n, s) => n + per[s][key], 0) + (otherUsed ? other[key] : 0);
    const totals = {};
    Object.keys(zero()).forEach((k) => { totals[k] = sum(k); });

    const close = { cash: open.cash + periodCash, bank: open.bank + periodBank, credit: open.credit + periodCredit };
    const salesCash = totals.cashSales, salesBank = totals.bankSales, salesCredit = totals.credit;
    const expByCat = {};
    for (const e of expenses) expByCat[e.category] = (expByCat[e.category] || 0) + e.cash + e.bank;

    return {
      from, to, shops, per, other: otherUsed ? other : null, totals,
      open: { cash: open.cash, bank: open.bank, total: open.cash + open.bank, credit: open.credit, shop: open.shop },
      close: { cash: close.cash, bank: close.bank, total: close.cash + close.bank, credit: close.credit },
      sales: { cash: salesCash, bank: salesBank, credit: salesCredit, total: salesCash + salesBank + salesCredit },
      expenseTotal: { cash: expenses.reduce((n, e) => n + e.cash, 0), bank: expenses.reduce((n, e) => n + e.bank, 0) },
      expByCat,
      cardFee: totals.cardFee,   // estimated card fees in the period (already taken off Bank)
      days: [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, byShop]) => ({ date, byShop, total: Object.values(byShop).reduce((n, v) => n + v, 0) })),
      expenses, moves, incomes,
    };
  }

  const api = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Statement = api;
})(typeof window !== 'undefined' ? window : globalThis);
