// Staff commission.
// - Terminal 21 (Bicasso 1 + Bicasso 2): 3% of the month's sales, split equally between the
//   staff, plus a daily bonus that every staff member gets for each shop's sales that day.
// - Nana: 1% of the month's sales (cash, plus the card/QR sales that go through the
//   neighbour's machine and are saved as Credit Sales to Nana's card account), split
//   equally between Nana's staff. No daily bonus.
// Days off beyond 2 a month cost 1/30 of the total each; the app applies that from the days
// off the owner enters, so it isn't computed here.
// Files starting with "_" are not exposed as routes on Vercel.

const SHOPS = ['Bicasso 1', 'Bicasso 2'];
const RATE = 0.03;

// A shop's sales for one day -> bonus per person. 32,000 and above earns the top band.
const BONUS_BANDS = [
  [32000, 350],
  [27000, 300],
  [22000, 125],
  [17000, 100],
  [10000, 50],
  [9000, 25],
];
function dailyBonus(sales) {
  const band = BONUS_BANDS.find(([min]) => sales >= min);
  return band ? band[1] : 0;
}

// rows: Master Entry rows as readMasterEntry returns them; month: 'YYYY-MM'.
function commissionFor(rows, month, staffCount) {
  const byDay = new Map(); // date -> { 'Bicasso 1': sales, 'Bicasso 2': sales }
  for (const r of rows) {
    if (r.category !== 'Retail Sale' || !SHOPS.includes(r.shop) || !r.date.startsWith(month)) continue;
    const day = byDay.get(r.date) || Object.fromEntries(SHOPS.map((s) => [s, 0]));
    day[r.shop] += r.cashIn + r.bankIn;
    byDay.set(r.date, day);
  }
  const days = [...byDay.keys()].sort().map((date) => {
    const sales = byDay.get(date);
    const bonus = Object.fromEntries(SHOPS.map((s) => [s, dailyBonus(sales[s])]));
    return { date, sales, bonus, total: SHOPS.reduce((n, s) => n + bonus[s], 0) };
  });
  const sales = Object.fromEntries(SHOPS.map((s) => [s, days.reduce((n, d) => n + d.sales[s], 0)]));
  const totalSales = SHOPS.reduce((n, s) => n + sales[s], 0);
  const pool = totalSales * RATE;
  return {
    month, shops: SHOPS, rate: RATE, sales, totalSales,
    pool: Math.round(pool),
    commissionEach: staffCount ? Math.round(pool / staffCount) : 0,
    bonusEach: days.reduce((n, d) => n + d.total, 0),
    days,
  };
}

const NANA_SHOP = 'Nana';
const NANA_RATE = 0.01;

// Nana's month: cash Retail Sales plus Credit Sales booked to Nana (its neighbour-card account)
function nanaCommissionFor(rows, month, staffCount) {
  let cash = 0, card = 0;
  for (const r of rows) {
    if (r.shop !== NANA_SHOP || !r.date.startsWith(month)) continue;
    if (r.category === 'Retail Sale') cash += r.cashIn + r.bankIn;
    else if (r.category === 'Credit Sale') card += r.credit;
  }
  const totalSales = cash + card;
  const pool = totalSales * NANA_RATE;
  return {
    shop: NANA_SHOP, rate: NANA_RATE, cash, card, totalSales,
    pool: Math.round(pool),
    commissionEach: staffCount ? Math.round(pool / staffCount) : 0,
  };
}

module.exports = { SHOPS, RATE, BONUS_BANDS, dailyBonus, commissionFor, NANA_SHOP, NANA_RATE, nanaCommissionFor };
