# Burmelin Finance — Mobile App

A phone-friendly web app for your **Burmelin_Finance_NewX** Google Sheet:

Four tabs, in the same Burmelin look as the staff app (on a computer they sit down the left side):

- **Home** — money on hand (cash + bank), what customers owe, each shop's drawer, and the overdue
  customers owing the most (tap **All customers** for the full list)
- **Add** — **Day sheet** (one shop, one day: sales, collection, expenses; a green dot marks a shop
  that already has entries that day) and **One-off entry**, a smart form that writes rows straight
  into Master Entry, following the same double-entry rules as the sheet
- **Staff** — Terminal 21 and Nana commission for any month, with days off and the amount to pay
- **Reports** — the statement (share as PDF or print) and Bicasso card sales for any dates
- **Loyverse sync** — each shop's daily sales are pulled from Loyverse automatically (see the Loyverse section below)

---

## One-time setup (about 15 minutes)

### Step 1 — Create a Google service account (you must do this yourself)

This creates a "robot" Google account the app uses to read/write your sheet.

1. Go to https://console.cloud.google.com (sign in with burmelinco@gmail.com)
2. Top bar → project dropdown → **New Project** → name it `burmelin-finance` → Create
3. Menu → **APIs & Services → Library** → search **Google Sheets API** → **Enable**
4. Menu → **APIs & Services → Credentials** → **Create Credentials → Service account**
   - Name: `sheet-writer` → Create and continue → skip the optional steps → Done
5. Click the service account you just made → **Keys** tab → **Add key → Create new key → JSON** → Download.
   Keep this file safe — it is the key to your sheet.
6. Open the JSON file in Notepad. You need two values:
   - `client_email` (looks like `sheet-writer@burmelin-finance.iam.gserviceaccount.com`)
   - `private_key` (the long block starting `-----BEGIN PRIVATE KEY-----`)
7. **Share the spreadsheet with the robot:** open Burmelin_Finance_NewX → Share → paste the
   `client_email` address → role **Editor** → Send (untick "notify" if offered).

### Step 2 — Deploy to Vercel (you must create/log into the account yourself)

1. Create a free account at https://vercel.com (sign up with GitHub, Google, or email)
2. In a terminal, from this folder (`burmelin-finance-app`):
   ```
   npx vercel login
   npx vercel --prod
   ```
   Accept the defaults when it asks questions.
3. In the Vercel dashboard → your project → **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `SHEET_ID` | `1UG4WQG3vOiytArJT1U03CdQPwjPlMb9-3wy1OGzoLmw` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` from the JSON |
   | `GOOGLE_PRIVATE_KEY` | the `private_key` from the JSON (paste the whole thing, including BEGIN/END lines) |

4. Redeploy so the variables take effect: `npx vercel --prod` again.
5. Open the URL it gives you in Safari → Share button → **Add to Home Screen**. Done — it now
   behaves like an app.

---

## Deploying changes

Vercel updates the live app by itself when a pull request is merged into `main` on GitHub —
**but only if it is merged from the `burmelinco-hash` GitHub account**, the one linked to
Vercel. On Vercel's free Hobby plan a private project only deploys commits made by its owner;
a merge from any other GitHub account shows up in Vercel as **Blocked** and the live site
stays on the old version.

If that happens: open the blocked deployment in Vercel (Deployments → top entry) and tap
**Redeploy** while logged in as the owner, or merge the next change from `burmelinco-hash`.

---

## Running locally (for testing)

```
npm install
npm run dev
```

Open http://localhost:3000. Without credentials it runs in **mock mode** (sample numbers,
saves don't write). To test against the real sheet locally, create a `.env` file here:

```
SHEET_ID=1UG4WQG3vOiytArJT1U03CdQPwjPlMb9-3wy1OGzoLmw
GOOGLE_SERVICE_ACCOUNT_EMAIL=sheet-writer@....iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**Never commit or share the private key or `.env` file.**

---

## Terminal 21 commission

The **Staff** tab shows, for any month (this month updates every day):

- **Commission:** 3% of that month's **Bicasso 1 + Bicasso 2** sales (cash + card, after
  refunds), split equally between the staff listed in the **Lists tab, column M** (M2 down —
  today Sunil, Sandeep, Kumar).
- **Daily bonus:** for every day, each shop's sales that day earn a bonus per person, and
  everyone gets both shops' bonus:

  | One shop's sales that day | Bonus per person |
  |---|---|
  | 9,000 – 9,999 | 25 |
  | 10,000 – 16,999 | 50 |
  | 17,000 – 21,999 | 100 |
  | 22,000 – 26,999 | 125 |
  | 27,000 – 31,999 | 300 |
  | 32,000 and above | 350 |

  e.g. Bicasso 1 ฿23,000 (125) and Bicasso 2 ฿17,000 (100) → ฿225 each that day.
- **Days off:** 2 a month are allowed. Type each person's days off (Loyverse → Employees →
  Timecards: days with no clock-in); every extra day takes **(commission + bonus) ÷ 30** off.
  The page then shows the amount to pay on the last day of the month. Days off are
  remembered on that phone only.

---

## Daily statement

**Reports** tab → **Statement**: pick the dates (today by default; quick buttons for
yesterday, the last 7 days and this month). It shows:

- **Opening, change and closing** of the cash in all drawers, the bank, and both together
  (plus what credit customers owe). Opening = everything recorded before the first day.
- **By shop:** each drawer's opening cash, cash sales, expenses, collections, closing cash;
  card/QR sales; credit sales; total sales. The bank is one shared account, so per shop it only
  shows the bank money that went in or out through that shop.
- **Daily sales** per shop (when more than one day is picked), every **expense and pay-out**,
  and every collection, deposit and adjustment.

The figures follow the same rules as the dashboard, so today's closing equals the dashboard.
**Share PDF** makes an A4 PDF and opens the phone's share sheet (WhatsApp, LINE, Mail, Save to
Files, Print); on a computer it downloads. **Print** prints it on A4.

## Opening Finance from the admin login

Finance opens only for the owner: log in to the staff app as **Owner** (the Settings
password) and tap **Finance**. The finance server asks the staff app's Apps Script server
whether that login is the owner's, so shop logins (Bicasso, Nana, Palladium) are refused.
Logging out, or changing the Settings password, takes access away again (within 5 minutes).
Finance renews the login once a day, so it doesn't run out while only Finance is used.

There is no finance PIN any more (it had no limit on guesses). The old Lists!K2 cell and the
`APP_PIN` setting are ignored and can be cleared. The daily Loyverse job gets in with
`CRON_SECRET`, which must be set in Vercel.

---

## How writing works (so future-you trusts it)

- The app finds the first empty row in Master Entry (by column A) and writes columns
  **A–D and F–L** only. Column **E (Type)** and columns **M/N (collection reconciliation)**
  contain formulas and are never touched.
- Credit Sale / Customer Payment entries use the **customer's shop**: Palladium, unless the
  *Lists* tab's column F names another shop for that customer. **Nana Card (Neighbour)** is
  Nana's: Nana's card sales go through the neighbour shop's machine, so on the Day sheet they
  are saved as a Credit Sale to that account (not Bank In), and the cash the neighbour later
  brings is saved as a Customer Payment into Nana's drawer. The dashboard flags this account
  after 7 days without a payment (30 days for other customers).
- Every entry is tagged `App` in the *Entered By* column so you can tell app entries from
  manual ones.
- The dashboard computes balances with the same logic as the sheet's Dashboard tab
  (collections move cash to Palladium; bank is one shared account).

---

## Loyverse: daily sales fill themselves in

Every morning the app reads your Loyverse receipts and writes one **Retail Sale** row per
shop per day into Master Entry, so you don't have to type sales from each shop. At **Nana**,
card/SCAN sales go through the neighbour shop's machine, so they are written as a **Credit
Sale to Nana Card (Neighbour)** instead of Bank In.

It also imports every **pay-out and pay-in** staff record in a Loyverse shift, one row each,
decided from the note they type:

| Note in Loyverse | Becomes |
|---|---|
| contains *collection*, *Sonu*, *received by* or *brought* | **Collection (to Palladium)** |
| contains *salary* | **Salary** |
| pay-in at Nana containing *card* | **Customer Payment** from *Nana Card (Neighbour)* ("Neighbour paid") |
| contains *home* or *house* (e.g. "House rent") | **Home Expenses** |
| contains *rent* | **Rent** |
| contains *wage* | **Wages** |
| contains *commission* or *bonus* | **Commission** |
| contains the word *tax* or *gov* (not "taxi") | **Gov Tax** |
| contains *supplier* or *stock* | **Supplier Pay** |
| *refund* — and that day has a card/QR refund receipt of the same amount | **Adjustment**: Cash Out + Bank In (the refund came from the drawer, not the bank) |
| *refund* with no matching refund receipt | **not imported** — shown in red to enter by hand |
| any other pay-out | **Other Expense**, with the note (฿5,000 or more is flagged to check the category) |
| any other pay-in | **Adjustment** Cash In, flagged to check |

Each row's note ends with the time of the pay-out (e.g. `Pant cut · 16:20`), which is how a
re-run recognises it instead of adding it twice. **Ask staff to always write a short note**
("Collection", "Kumar salary", "Card", "Water"…) — that note is what puts the money in the
right place.

You only enter by hand: **bank-paid expenses**, Palladium's spending, and anything that was
paid from a drawer **without** a Loyverse pay-out.

Until `LOYVERSE_TOKEN` is set, all of this stays switched off and the Loyverse card is hidden.

### Setup (about 5 minutes)

1. Loyverse Back Office → **Integrations → Access tokens** → **+ Add access token** → name it
   `burmelin-finance` → Save → **copy the token now** (it is only shown once).
   The token can read *and change* everything in your Loyverse account, so treat it like a password.
2. Vercel → your project → **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `LOYVERSE_TOKEN` | the token from step 1 |
   | `CRON_SECRET` | any long random text, e.g. `k3J9-q8Lz-2mPw-7xRt` (lets the daily job in past your PIN) |
   | `LOYVERSE_TIMEZONE` | *(optional)* defaults to `Asia/Bangkok` — decides where one "day" ends |
   | `LOYVERSE_STORE_MAP` | `{"Burmelin":"Bicasso 1","BICASSO 2 Terminal 21":"Bicasso 2","BICASSO 3 Nana":"Nana"}` — your Loyverse store names don't match the sheet's, see "Store names" below |
   | `LOYVERSE_PAYMENT_MAP` | *(optional, not needed today)* see "Payment types" below |

3. Redeploy: `npx vercel --prod`.
4. **Check before trusting it:** open the app → **Daily** → in the Loyverse card set both dates
   to yesterday → **Check Loyverse**. Compare each shop's cash and bank numbers with Loyverse
   Back Office → *Sales by payment type* for the same day (for Nana, "card owed by neighbour" is
   its Card + SCAN). Only then tap **Save Loyverse sales**.

### How it decides what to write

- **Store names:** a Loyverse store is matched to the sheet shop with the same name
  (capital letters don't matter). If the names differ, map them:
  `LOYVERSE_STORE_MAP={"Bicasso Mall":"Bicasso 1","Old Kiosk":""}` — an empty value means
  "ignore this store". Unmatched stores show up in red when you tap *Check Loyverse*, so no
  money is silently left out.
- **Payment types:** payments whose Loyverse type is *Cash* go to **Cash In**; every other type
  (card, QR, transfer…) goes to **Bank In**. If you have a payment type that is *not* money in
  the bank — e.g. a "Credit" or "Pay later" type for credit customers — tell the app to skip it:
  `LOYVERSE_PAYMENT_MAP={"Credit":"skip"}` (other allowed values: `"cash"`, `"bank"`).
  Skipped payments still need to be recorded as a **Credit Sale** against the customer.
- **Neighbour-card shops:** at a shop that has its own credit account in the *Lists* tab
  (column F — today only Nana, with *Nana Card (Neighbour)*), every non-cash payment becomes a
  **Credit Sale** to that account instead of Bank In.
- **Refund paid in cash for a card/QR sale** (like 23/10): Loyverse books it against the
  original payment type, so the import takes it off Bank In while the cash actually left the
  drawer. Fix that day with an **Adjustment** (Cash Out + Bank In of the refund) instead of
  also entering the paid-out as an expense.
- **Refunds** are subtracted on the day they happen. **Cancelled** receipts are ignored.
- Rows are tagged `Loyverse` in *Entered By*. Running the sync again **updates** that row
  instead of adding a second one, so late receipts (e.g. from a till that was offline) are
  picked up by the next run.

### It never counts the same sales twice

- **One source per shop-day.** If any of a shop-day's sales rows was typed by hand (including
  the catch-up rows marked *Loyverse import*), the sync **skips** that whole day and says so.
  Delete your manual rows if you want Loyverse to fill it.
- Once Loyverse has filled a shop-day, the Day sheet and One-off entry screens **refuse** a hand-typed
  Retail Sale (or Nana card amount) for that shop and date.
- **Pay-outs follow the same rule.** If you typed a shop-day's cash expenses or collection by
  hand, Loyverse leaves that day's pay-outs alone (likewise a hand-typed "Neighbour paid" for
  its pay-ins). The other way round, once Loyverse imported a shop-day's pay-outs, saving a
  hand-typed **cash** expense or collection for it asks *"Loyverse already recorded … Save
  anyway?"* — say OK only if it really is extra money. Bank-paid expenses never ask.

### When it runs

`vercel.json` runs the sync once a day at **23:00 UTC = 06:00 Bangkok**, covering *yesterday
and today*. On Vercel's free plan the job can start any time within that hour and can only
run once a day — that's fine, because the yesterday+today window makes the exact time
irrelevant. To change the time, edit `schedule` in `vercel.json` (it's in UTC) and redeploy.
Need it sooner? Tap **Check Loyverse** on Add → Day sheet any time.

### Catching up missed days

Add → Day sheet → Loyverse card → set the **from** and **to** dates (up to 3 months) → **Check
Loyverse**. You get one line per shop with its cash and bank totals for the whole period —
compare those with Loyverse's *Sales by payment type* report for the same dates, then tap
**Save Loyverse sales**. Days you already typed by hand are skipped, so overlapping the
period with days you entered yourself is safe.

**Don't also type refunds as expenses** for days Loyverse filled — a refund done in Loyverse is
already subtracted from that day's sales.
