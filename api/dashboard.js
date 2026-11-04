// GET /api/dashboard — live totals computed from the Master Entry tab.
// Mirrors the spreadsheet's own Dashboard formulas exactly.
const { SHEET_ID, MOCK, MOCK_CUSTOMER_SHOPS, getSheetsClient, checkPin, serialToDate, num, customerShopMap } = require('./_google');

const COLLECTION = 'Collection (to Palladium)';

// Days without a payment before a credit customer shows as overdue. Accounts kept at a
// shop other than Palladium (Nana's neighbour-card account) are settled weekly, not monthly.
const overdueDays = (shop) => (shop && shop !== 'Palladium' ? 7 : 30);

module.exports = async function handler(req, res) {
  if (!(await checkPin(req, res))) return;

  if (MOCK) return res.json(mockData());

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: ["'Master Entry'!A2:L", "'Lists'!A2:F30"],
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });

    const rows = resp.data.valueRanges[0].values || [];
    const listRows = resp.data.valueRanges[1].values || [];

    const shops = [];
    const customers = [];
    const categories = [];
    for (const r of listRows) {
      if (r[0]) categories.push({ name: String(r[0]), type: String(r[1] || '') });
      if (r[3]) shops.push(String(r[3]));
      if (r[4]) customers.push(String(r[4]));
    }
    const customerShops = customerShopMap(listRows.map((r) => [r[4], r[5]]));

    // Column indexes (0-based within A2:L): A date, B shop, C customer, D category,
    // E type, F cashIn, G bankIn, H cashOut, I bankOut, J creditAmt, K enteredBy, L notes
    let totalCashIn = 0, totalCashOutNonCollection = 0, totalBankIn = 0, totalBankOut = 0;
    const shopCash = Object.fromEntries(shops.map((s) => [s, 0]));
    const credit = Object.fromEntries(customers.map((c) => [c, { sales: 0, payments: 0, lastPayment: null }]));

    for (const r of rows) {
      const shop = String(r[1] || '');
      const customer = String(r[2] || '');
      const category = String(r[3] || '');
      const cashIn = num(r[5]), bankIn = num(r[6]), cashOut = num(r[7]), bankOut = num(r[8]), creditAmt = num(r[9]);

      totalCashIn += cashIn;
      totalBankIn += bankIn;
      totalBankOut += bankOut;
      if (category !== COLLECTION) totalCashOutNonCollection += cashOut;

      if (shop in shopCash) {
        shopCash[shop] += cashIn - cashOut;
        if (category === COLLECTION && shop !== 'Palladium' && 'Palladium' in shopCash) {
          shopCash['Palladium'] += cashOut; // collected cash lands in the hub
        }
      }

      if (customer in credit) {
        if (category === 'Credit Sale') credit[customer].sales += creditAmt;
        if (category === 'Customer Payment') {
          credit[customer].payments += cashIn + bankIn;
          const d = typeof r[0] === 'number' ? serialToDate(r[0]) : null;
          if (d && (!credit[customer].lastPayment || d > credit[customer].lastPayment)) {
            credit[customer].lastPayment = d;
          }
        }
      }
    }

    const totalCash = totalCashIn - totalCashOutNonCollection;
    const totalBank = totalBankIn - totalBankOut;

    const creditList = customers.map((name) => {
      const c = credit[name];
      const balance = c.sales - c.payments;
      const daysSince = c.lastPayment ? Math.floor((Date.now() - c.lastPayment.getTime()) / 86400000) : null;
      return { name, balance, lastPayment: c.lastPayment ? c.lastPayment.toISOString().slice(0, 10) : null, daysSince, overdueDays: overdueDays(customerShops[name]) };
    });

    res.json({
      totals: { cash: totalCash, bank: totalBank, grand: totalCash + totalBank },
      shops: shops.map((name) => ({ name, cash: shopCash[name] })),
      credit: creditList,
      totalCredit: creditList.reduce((s, c) => s + c.balance, 0),
      lists: { shops, customers, customerShops, categories },
      loyverse: Boolean(process.env.LOYVERSE_TOKEN),
      updatedAt: new Date().toISOString(),
      mock: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read spreadsheet: ' + err.message });
  }
};

function mockData() {
  return {
    totals: { cash: 62420, bank: 0, grand: 62420 },
    shops: [
      { name: 'Palladium', cash: 76000 },
      { name: 'Bicasso 1', cash: 2100 },
      { name: 'Bicasso 2', cash: 5530 },
      { name: 'Nana', cash: 420 },
      { name: 'Burmelin', cash: 1100 },
    ],
    credit: [
      { name: 'Shyam Gtm', balance: 630383, lastPayment: '2026-06-20', daysSince: 16 },
      { name: 'Sunil Platinium', balance: 455860, lastPayment: '2026-05-30', daysSince: 37 },
      { name: 'Five Star', balance: 468880, lastPayment: '2026-04-06', daysSince: 91 },
      { name: 'Sunil Grand 5', balance: 193968, lastPayment: null, daysSince: null },
      { name: 'Raja Indra', balance: 161184, lastPayment: '2026-06-28', daysSince: 8 },
      { name: 'Mars', balance: 84005, lastPayment: '2026-07-01', daysSince: 5 },
      { name: 'Shyam Btr', balance: 35850, lastPayment: null, daysSince: null },
      { name: 'Nana Card (Neighbour)', balance: 3450, lastPayment: null, daysSince: null },
    ].map((c) => ({ ...c, overdueDays: overdueDays(MOCK_CUSTOMER_SHOPS[c.name] || 'Palladium') })),
    totalCredit: 2030130,
    lists: {
      shops: ['Palladium', 'Bicasso 1', 'Bicasso 2', 'Nana', 'Burmelin'],
      customers: ['Shyam Gtm', 'Sunil Platinium', 'Five Star', 'Sunil Grand 5', 'Raja Indra', 'Mars', 'Shyam Btr', 'Nana Card (Neighbour)'],
      customerShops: { ...Object.fromEntries(['Shyam Gtm', 'Sunil Platinium', 'Five Star', 'Sunil Grand 5', 'Raja Indra', 'Mars', 'Shyam Btr'].map((c) => [c, 'Palladium'])), ...MOCK_CUSTOMER_SHOPS },
      categories: [
        { name: 'Retail Sale', type: 'Income' },
        { name: 'Bank Received', type: 'Income' },
        { name: 'Scan / QR Payment', type: 'Income' },
        { name: 'Credit Sale', type: 'Income' },
        { name: 'Customer Payment', type: 'Income' },
        { name: 'Supplier Pay', type: 'Expense' },
        { name: 'Salary', type: 'Expense' },
        { name: 'Wages', type: 'Expense' },
        { name: 'Commission', type: 'Expense' },
        { name: 'Rent', type: 'Expense' },
        { name: 'Gov Tax', type: 'Expense' },
        { name: 'Home Expenses', type: 'Expense' },
        { name: 'Other Expense', type: 'Expense' },
        { name: 'Collection (to Palladium)', type: 'Transfer' },
        { name: 'Cash to Bank Deposit', type: 'Transfer' },
        { name: 'Bank to Cash (ATM)', type: 'Transfer' },
        { name: 'Collection to Bank', type: 'Transfer' },
        { name: 'Opening Balance', type: 'Transfer' },
      ],
    },
    loyverse: Boolean(process.env.LOYVERSE_TOKEN),
    updatedAt: new Date().toISOString(),
    mock: true,
  };
}
