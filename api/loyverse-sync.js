// GET|POST /api/loyverse-sync — pulls receipts and shifts from Loyverse and writes them into
// Master Entry: one Retail Sale per shop per day (cash payments -> Cash In, others -> Bank In;
// at a shop with a neighbour-card account such as Nana, non-cash payments become a Credit
// Sale to that account), plus one row per drawer pay-out/pay-in (collection, salary,
// expense, neighbour payment), classified from the note staff typed in Loyverse.
//
//   ?date=YYYY-MM-DD   last day to sync (default: today, in LOYVERSE_TIMEZONE)
//   ?days=N            how many days back from `date` (default 2 = yesterday + today, max 31;
//                      the daily job looks back 7 days, so a night it failed is caught up)
//   ?dryRun=1          report what would be written without touching the sheet
//
// Safe to run any number of times: rows are tagged "Loyverse" in Entered By and are
// updated in place on the next run, never duplicated. A Loyverse row someone corrected
// by hand in the sheet is kept as it is (see planSync / planMovements). Vercel Cron calls it daily
// (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
const { verifyWritten, logSync, SHEET_ID, MOCK, MOCK_CUSTOMER_SHOPS, getSheetsClient, currentPin, checkPin, readMasterEntry, sheetFullError, customerShopMap } = require('./_google');
const { TAG, TIMEZONE, lvGetAll, localDate, addDays, mapStores, neighbourAccounts, dailyTotals, planSync, planMovements } = require('./_loyverse');

const MOCK_SHOPS = ['Palladium', 'Bicasso 1', 'Bicasso 2', 'Nana', 'Burmelin'];

async function authorized(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  if (!secret && /vercel-cron/i.test(req.headers['user-agent'] || '') && (await currentPin().catch(() => ''))) {
    res.status(401).json({ error: 'Set CRON_SECRET in Vercel so the daily sync can get past the app PIN' });
    return false;
  }
  return checkPin(req, res);
}

module.exports = async function handler(req, res) {
  if (!(await authorized(req, res))) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!process.env.LOYVERSE_TOKEN) {
    return res.status(400).json({ error: 'Loyverse is not connected — add LOYVERSE_TOKEN in Vercel → Settings → Environment Variables' });
  }

  const q = { ...(req.query || {}), ...(req.body || {}) };
  const today = localDate(Date.now());
  const to = String(q.date || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const isCron = /vercel-cron/i.test(req.headers['user-agent'] || '');
  const days = Math.min(Math.max(parseInt(q.days, 10) || (isCron ? 7 : 2), 1), 31);
  const from = addDays(to, -(days - 1));
  const dryRun = q.dryRun === true || q.dryRun === '1' || q.dryRun === 'true';

  const dates = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) dates.add(d);

  try {
    let sheets = null, existing = [], nextRow = 2, lastRow = Infinity, sheetShops = MOCK_SHOPS, accounts = neighbourAccounts(MOCK_CUSTOMER_SHOPS);
    if (!MOCK) {
      sheets = getSheetsClient();
      const [master, lists] = await Promise.all([
        readMasterEntry(sheets),
        sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Lists'!D2:F30" }),
      ]);
      existing = master.rows;
      nextRow = master.nextRow;
      lastRow = master.lastRow;
      const listRows = lists.data.values || [];
      sheetShops = listRows.map((r) => String(r[0] || '').trim()).filter(Boolean);
      accounts = neighbourAccounts(customerShopMap(listRows.map((r) => [r[1], r[2]])));
    }

    // Receipts are filtered by created_at on the API side; widen the window by a day on
    // each side so timezone offsets and receipts synced late from an offline till are
    // caught, then bucket precisely by the receipt's local sale date.
    // Shifts carry the drawer's pay-ins/pay-outs; same widened window (a shift opened the
    // evening before can hold pay-outs made after midnight).
    const window = { created_at_min: `${addDays(from, -1)}T00:00:00.000Z`, created_at_max: `${addDays(to, 3)}T00:00:00.000Z` };
    const [stores, receipts, shifts] = await Promise.all([
      lvGetAll('/stores', 'stores'),
      lvGetAll('/receipts', 'receipts', window),
      lvGetAll('/shifts', 'shifts', window),
    ]);

    const { map: storeShop, unmatched } = mapStores(stores, sheetShops);
    const { totals, warnings, cardRefunds } = dailyTotals(receipts, storeShop, dates, accounts);
    const moves = planMovements(shifts, storeShop, dates, accounts, cardRefunds, existing);
    warnings.push(...moves.warnings);
    const plan = [...planSync(totals, existing, addDays(today, -1)), ...moves.actions];

    // Receipts from stores we couldn't map, so the user knows money is being left out.
    const unmatchedCounts = unmatched.map((u) => {
      const st = stores.find((s) => s.name === u.store);
      const n = receipts.filter((r) => st && r.store_id === st.id && !r.cancelled_at && dates.has(localDate(r.receipt_date || r.created_at))).length;
      return { ...u, receipts: n };
    });

    const toAdd = plan.filter((p) => p.action === 'add');
    const toUpdate = plan.filter((p) => p.action === 'update');
    const result = {
      ok: true, dryRun, mock: MOCK, timezone: TIMEZONE, from, to,
      results: plan, unmatchedStores: unmatchedCounts, warnings,
      added: dryRun ? 0 : toAdd.length, updated: dryRun ? 0 : toUpdate.length,
    };
    const datesText = from === to ? from : `${from} to ${to}`;
    const kept = plan.filter((p) => p.action === 'skip').length;
    const summary = [kept ? `${kept} left for you to check` : '', warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    if (dryRun || MOCK) return res.json(result);
    if (!toAdd.length && !toUpdate.length) {
      await logSync(sheets, { ok: true, dates: datesText, message: summary || 'nothing new' });
      return res.json(result);
    }

    const credit = (p) => p.kind === 'credit';
    const movementRow = (p) => [
      `${+p.date.slice(5, 7)}/${+p.date.slice(8, 10)}/${p.date.slice(0, 4)}`, // A Date (M/D/YYYY)
      p.shop, p.customer || '', p.category, null,                           // B Shop, C Customer, D Category, E (formula)
      p.cashIn || '', p.bankIn || '', p.cashOut || '', '', '',              // F Cash In, G Bank In, H Cash Out, I, J
      TAG, p.note,                                                          // K Entered By, L Notes
    ];
    const rowFor = (p) => (p.kind === 'movement' ? movementRow(p) : [
      `${+p.date.slice(5, 7)}/${+p.date.slice(8, 10)}/${p.date.slice(0, 4)}`, // A Date (M/D/YYYY)
      p.shop,                                                               // B Shop
      credit(p) ? p.account : '',                                           // C Credit Customer
      credit(p) ? 'Credit Sale' : 'Retail Sale',                            // D Category
      null,                                                                 // E Type (formula — untouched)
      p.cash || '',                                                         // F Cash In
      p.bank || '',                                                         // G Bank In
      '', '',                                                               // H Cash Out, I Bank Out
      p.credit || '',                                                       // J Credit Sale Amount
      TAG,                                                                  // K Entered By
      (credit(p) ? "Loyverse · card sales on neighbour's machine"           // L Notes
        : `Loyverse · ${p.receipts} receipt${p.receipts === 1 ? '' : 's'}${p.refunds ? ` · ${p.refunds} refund${p.refunds === 1 ? '' : 's'}` : ''}`)
        + ` ${p.stamp}`,                                                    // amounts written, to spot hand corrections later
    ]);

    const endRow = nextRow + toAdd.length - 1;
    if (toAdd.length && endRow > lastRow) return res.status(500).json({ error: sheetFullError(lastRow) });

    const data = toUpdate.map((p) => ({ range: `'Master Entry'!A${p.row}:L${p.row}`, values: [rowFor(p)] }));
    if (toAdd.length) data.push({ range: `'Master Entry'!A${nextRow}:L${endRow}`, values: toAdd.map(rowFor) });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    toAdd.forEach((p, i) => { p.row = nextRow + i; });
    if (toAdd.length) {
      const lost = await verifyWritten(sheets, nextRow, toAdd.map(rowFor));
      if (lost) throw new Error(lost + ' (the next import adds them again)');
    }

    await logSync(sheets, { ok: true, dates: datesText, added: toAdd.length, updated: toUpdate.length, message: summary });
    console.log(`loyverse-sync ${from}..${to}: added ${toAdd.length}, updated ${toUpdate.length}, skipped ${plan.filter((p) => p.action === 'skip').length}`);
    res.json(result);
  } catch (err) {
    console.error(err);
    if (!MOCK && !dryRun) {
      try { await logSync(getSheetsClient(), { ok: false, dates: from === to ? from : `${from} to ${to}`, message: err.message }); } catch (e) { /* the key itself is broken */ }
    }
    res.status(500).json({ error: 'Loyverse sync failed: ' + err.message });
  }
};
