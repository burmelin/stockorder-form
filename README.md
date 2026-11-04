# Burmelin Stock & Orders

Staff app for the Palladium warehouse and the three retail stores (Bicasso 1, Bicasso 2,
Bicasso Nana). The **app** (`index.html`) is hosted on **Vercel**. The **server** is a
**Google Apps Script** web app (`apps-script/Code.gs`) that reads and writes the Google Sheet
and answers the app as a JSON API.

## Structure

```
index.html               ← the staff app (Vercel deploys the repo root on every push to main)
manifest.webmanifest     ← home-screen app name and icon
icons/                   ← app icons
apps-script/             ← the Apps Script server — deployed by GitHub Actions, NOT served by Vercel
  Code.gs
  appsscript.json        ← Apps Script manifest (time zone, web app access)
  .clasp.json            ← which Apps Script project to push to (scriptId, parent sheet)
.github/workflows/
  deploy-apps-script.yml ← pushes apps-script/ live when it changes on main
```

The app calls the server through `API_URL` near the top of `index.html`. That URL never
changes: deploys update the same web app deployment.

## Automatic Apps Script deploys

When a change inside `apps-script/` is merged into `main`, the **Deploy Apps Script** action
pushes the code, creates a new version, and points the existing web app at it. Nobody needs to
open the Apps Script editor or click Deploy. You can also run it by hand: GitHub → **Actions** →
**Deploy Apps Script** → **Run workflow**.

### One-time setup (Windows)

1. **Install Node.js** from https://nodejs.org (the "LTS" button) and run the installer with
   the default options.
2. **Turn on the Apps Script API** for your Google account: open
   https://script.google.com/home/usersettings and switch **Google Apps Script API** to **On**.
3. **Sign clasp in to Google.** Open **Command Prompt** (press the Windows key, type `cmd`,
   press Enter) and run these two commands one after the other:
   ```
   npm i -g @google/clasp
   clasp login
   ```
   A browser window opens. Sign in with the Google account that owns the sheet and click
   **Allow**. When it says you're logged in, you can close the browser tab.
4. **Copy the login file.** Press the Windows key + R, paste `%USERPROFILE%\.clasprc.json`,
   and press Enter. Choose Notepad if Windows asks how to open it. Press Ctrl+A, then Ctrl+C
   to copy everything in it.
5. **Save it on GitHub as a secret.** Open the repository on GitHub → **Settings** →
   **Secrets and variables** → **Actions** → **New repository secret**. Name it
   `CLASPRC_JSON`, paste with Ctrl+V into the box, and click **Add secret**.
6. **Check it works.** GitHub → **Actions** → **Deploy Apps Script** → **Run workflow**. A
   green tick means the live server now runs the code in `apps-script/`.

### Things to know

- **Anyone who can push to this repository can change the live server.** Keep the repository
  private and only give access to people you trust.
- **Edits made directly in the Apps Script editor are overwritten** by the next deploy. Make
  every change in `apps-script/` and merge it into `main`.
- **If you change your Google password**, or remove clasp's access at
  https://myaccount.google.com/permissions, deploys stop working (the action fails with a
  sign-in error). Repeat steps 3–5 to give GitHub a fresh `CLASPRC_JSON`.
- **New Google permissions:** if a change starts using a new Google service (for example
  Gmail or Drive for the first time), open the Apps Script editor once, run any function,
  and click **Allow**. Until then the web app returns an authorization error.
- The `.clasprc.json` file on your PC is a key to your Google account's scripts. Don't
  send it to anyone or commit it; it's already listed in `.gitignore`.

## Passwords

The four logins (Palladium, Bicasso 1, Bicasso 2, Bicasso Nana) are kept in the Apps Script
**Script properties** (`EMPLOYEE_PASS`, `PASS_BICASSO_1`, `PASS_BICASSO_2`,
`PASS_BICASSO_NANA`), never in the code.

### Reset a password from the Google Sheet

1. In the Google Sheet, open the **Logins** tab (columns **Login** and **Reset Password**).
2. Type the new password, at least 6 characters, in the **Reset Password** cell of that
   login's row.
3. Log in to the app with the new password. It becomes the real password and **the cell
   clears itself**. Phones still using the old password are asked to log in again.

Notes:
- A value shorter than 6 characters is refused with "The new password typed in the sheet needs
  at least 6 characters"; the old password keeps working until you fix it.
- The reset value is only read on the server; it is never sent to the app.
- **The sheet's version history keeps what was typed.** Don't reuse a password you use anywhere
  else, and keep the Google Sheet shared only with yourself.
- The **Logins** tab and its **Reset Password** column are optional. Without them, logins work
  as before.

## Staying signed in, and opening fast

- **30-day sign-in:** after logging in, a phone keeps a signed token instead of the password. The
  server renews it when it's over a day old, so a phone used daily stays signed in; a phone unused
  for 30 days logs in again. Changing a login's password (Logins tab) signs out every phone using
  the old one. The signing key is the Script property `TOKEN_SECRET`, created automatically.
  Deleting it signs every phone out.
- **Wake-up:** the app sends a tiny request as soon as it opens (and when it comes back after a
  few minutes), so Google's sleeping server is awake by the time someone logs in or taps.
- **Opens instantly:** `sw.js` keeps the app on the phone. The saved copy opens straight away and
  a fresh copy loads in the background; after a release the app offers **Reload**, and the next
  open uses the new version anyway. Stock and orders are never served from this copy.

## Leave requests

Staff ask for a **day off** or **sick leave** from the **Leave** button in the shop app; the
owner approves or declines in **Settings** (login screen → Settings; it uses the Owner password). Clock-in and clock-out
stay in Loyverse.

- **Each shop login lists only its own staff** (people whose "Works at" includes that shop).
- **Owner → Staff tab in the app:** add, edit or remove employees (name, where they work, day-off rule,
  PIN). It edits the sheet's Staff tab, which can also be edited by hand:
- **Staff tab (in the sheet):** Name · Works at (`Bicasso 1, Bicasso 2`, `Bicasso Nana`,
  `Palladium`; "Nana" and "Warehouse" are understood too) · Day off rule (`flexible` / `fixed`) ·
  Days off per month · Fixed day off · **New PIN**. Add a person by filling a new row; an ID is
  filled in automatically.
- **PINs:** type a PIN (4+ characters) in **New PIN**. The first time the person uses it, it's
  stored scrambled in Password hash / Password salt and the cell clears. To change a PIN, type a
  new one; phones using the old one ask for it again. Never edit the hash or salt columns.
- **Rules:** a day off needs 3 days' notice and comes from the monthly allowance. It's refused if
  it would leave Bicasso 1 or 2 without one person each, or Nana without anyone. Nana is covered by
  a warehouse employee with Nana in "Works at", and another warehouse employee must stay at the
  warehouse, so Nana's day off needs two warehouse staff working that day (never a Sunday).
  Sick leave can start today, up to 7 days, and is never refused: a gap it causes shows as a
  warning on the Settings screen.
- **Warehouse (Palladium) staff don't take leave:** they're off every Sunday and cover Nana. The
  Palladium login has no Leave button, and warehouse staff aren't on any leave list.
- **Owner:** an email arrives for each request. The owner password is `OWNER_PASS`; set it from the
  Logins tab, row **Owner**.
- Requests and decisions are kept in the **Leave** tab.

## Other features

- **Stock History** tab: every stock change (sale, transfer, count, Palladium edit, Mark Done,
  hand edits in the sheet) with before → after, reason and who.
- **Daily backup:** `setupDailyBackup` (run once) copies the sheet every night to the Drive
  folder **Burmelin Backups**, keeping the newest 30 copies.
- Full setup and day-to-day use: [SETUP_GUIDE.md](SETUP_GUIDE.md).
