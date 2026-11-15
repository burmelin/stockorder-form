# CLAUDE.md

## What this is
Burmelin Office: the phone app for a clothing business with one warehouse and three shops.
- **Palladium** is the warehouse, and its cash is managed by the warehouse manager.
- **Bicasso 1** and **Bicasso 2** are at Terminal 21 Asok Mall. In Loyverse, "Burmelin" is Bicasso 1 and "Bicasso 2" is Bicasso 2.
- **Bicasso Nana** is at Nana Square.
- **Shop staff** sell, count and transfer stock, and ask for leave.
- **Palladium staff** handle shop orders, warehouse stock and direct sales.
- **The owner** approves leave, edits staff, and uses Finance (owner login only).
- Address: stockorder-form.vercel.app (old name kept on purpose: staff phones use it).

## How it works
There are two halves. They share the Owner login but not the server.
1. **Staff app** = `index.html` (one big file) on Vercel, talking to a **Google Apps Script** server
   (`apps-script/Code.gs`) through `API_URL` in `index.html`. Apps Script reads and writes the
   **Stock sheet** (tabs: Palladium Stock, Orders, Sent Orders, Sales Log, Stock History, Staff, Leave, Logins, Master).
2. **Finance** = `finance/` on Vercel at `/finance`, talking to **Vercel functions in `api/`**, not Apps Script.
   They use a Google service account to read and write the **Finance sheet** (Master Entry, Lists,
   Staff Salary, Advance Deductions, Payroll, Timecards) and read sales from **Loyverse**.
   `api/_google.js` checks the owner login by asking Apps Script `verifyOwner`.
- `vercel.json` runs `/api/loyverse-sync` every day at 06:00 Thai time.
- `sw.js` keeps the app on the phone; after a release it offers Reload.

## Where things live
| Feature | Screen code | Server code |
|---|---|---|
| Orders (shops order from Palladium) | `index.html` | `Code.gs`: submitOrder, getOrders, markDone |
| Stock, sales, transfers, history | `index.html` | `Code.gs`: getInventory, getRetailStock, sellRetailStock*, transferStock, palladiumSell |
| Leave (staff ask, owner decides) | `index.html` (Leave button, Settings) | `Code.gs`: leave*, owner*Leave |
| Staff list and PINs | `index.html` (Settings → Staff) | `Code.gs`: ownerSaveStaff |
| Finance: cash, bank, entries, statement | `finance/app.js`, `finance/statement.js` | `api/dashboard.js`, `api/transaction(s).js`, `api/batch.js` |
| Loyverse import, card fees | – | `api/loyverse-sync.js`, `api/_loyverse.js`, `api/_cardfees.js` |
| Commission, salary, advances, payday | `finance/app.js` (Staff tab) | `api/commission.js`, `api/advances.js` |
| Timecards (clock in/out report) | `finance/timecards.js` | `api/timecards.js` (weekly Loyverse CSV upload) |
| Palladium manager's cash drawer | `index.html` (Palladium login), `finance/app.js` | `api/drawer.js` |
Names in the Finance sheet: **Warehouse** = the Palladium manager's cash drawer. **Office Cash** (saved as shop **Palladium** in the sheet) = the owner's cash in the home safe. Shop collections go there, and it gives the warehouse drawer its float.

## Rules
- **Never put a password, key or token in the code**, not even for a test. The repo history is kept forever.
  - Apps Script secrets live in **Script Properties** (EMPLOYEE_PASS, PASS_BICASSO_1, PASS_BICASSO_2,
    PASS_BICASSO_NANA, OWNER_PASS, TOKEN_SECRET).
  - Finance secrets live in **Vercel → Environment Variables** (GOOGLE_PRIVATE_KEY, LOYVERSE_TOKEN, CRON_SECRET, ...).
  - If a password or key is ever found in the code or its history, **replace it at the source** (change the
    password, or make a new key where it was issued, then delete the old one). Deleting the line is not enough.
- Change Apps Script only in `apps-script/`. Edits in the Apps Script editor are overwritten by the next deploy.
- Don't sort or hand-edit the Stock History tab; the app reads it from the bottom.
- Money changes need tests in `test/`. Run `npm test` before every PR.
- A change that rewrites existing money rows in the sheet needs the owner's OK first.
- **Never merge without the owner's clear "yes" in the chat.** Open the pull request, explain it in plain words, and wait.

## How to deploy a change
1. Make a branch, change the code, run `npm test`, open a pull request.
2. The PR gets two checks: **Tests** (GitHub) and a **Vercel preview**. Both must pass.
3. Explain the change to the owner in plain words and wait for a clear "yes". Only then merge into `main`:
   - Vercel publishes the app and `/finance` in 1–3 minutes (no build step).
   - If `apps-script/` changed, the **Deploy Apps Script** GitHub Action pushes it live to the same web app address.
4. Phones may show the old copy once; the next open (or Reload) gets the new one.
Run it on a computer: `npm install`, then `npm run dev` (http://localhost:3000 and /finance).

## Working with the owner
- The owner is not a coder. Explain every change in plain, short words: what it does and what to tap. No code words.
- In the app: plain English labels, as little typing as possible (tap to choose), no red/green colours.
- Show a picture of a new screen when you can.
- After merging (only after the owner's "yes"), check the deploy and say what went live.
