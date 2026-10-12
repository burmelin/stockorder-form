# Order Management System — Setup Guide

This guide sets up the full order system in about 10 minutes.
Everything runs free inside your Google account.

---

## What you'll end up with

| Link | Who uses it | What it does |
|------|------------|--------------|
| `…/exec` | Customers | Order form, checks availability, submits orders |
| `…/exec?page=employee` | Your team | Dashboard to view, invoice, and complete orders |

---

## Step 1 — Open Apps Script in your Google Sheet

1. Open your **"Updated Size Chart"** Google Sheet
2. Click the menu: **Extensions → Apps Script**
3. A new browser tab opens with the script editor

---

## Step 2 — Set up the files

You need to create **3 files** in the Apps Script editor.

### File 1: Code.gs (already exists — replace it)

1. Click on `Code.gs` in the left panel
2. **Select all** the existing code and **delete it**
3. Open the file `Code.gs` provided to you
4. Copy everything and paste it into the editor

### File 2: Customer.html (new file)

1. Click the **＋** button next to "Files" in the left panel
2. Choose **HTML**
3. Name it exactly: `Customer` (no .html extension needed)
4. Delete the default code
5. Open the file `Customer.html` provided to you
6. Copy everything and paste it in

### File 3: Employee.html (new file)

1. Click the **＋** button again → **HTML**
2. Name it exactly: `Employee`
3. Delete the default code
4. Open the file `Employee.html` provided to you
5. Copy everything and paste it in

---

## Step 3 — Customize your settings

In `Code.gs`, set your business name near the top:

```javascript
var BUSINESS_NAME = 'My Business';      // ← Your business name
```

Passwords are **not** kept in `Code.gs`. In the Apps Script editor open **Project Settings (⚙) → Script properties** and add:

| Property | Value |
|---|---|
| `EMPLOYEE_PASS` | Palladium staff password |
| `PASS_BICASSO_1` | Bicasso 1 passcode |
| `PASS_BICASSO_2` | Bicasso 2 passcode |
| `PASS_BICASSO_NANA` | Bicasso Nana passcode |

Click **Save** (the floppy disk icon, or Ctrl+S).

---

## Step 4 — Deploy as a Web App

1. Click the blue **Deploy** button (top right)
2. Choose **New deployment**
3. Click the gear icon ⚙ next to "Type" → select **Web app**
4. Fill in the settings:
   - **Description**: Order System
   - **Execute as**: Me (your Google account)
   - **Who has access**: Anyone
5. Click **Deploy**
6. Google will ask you to **authorize** — click through and allow access
   (It needs Gmail to send emails, and Sheets to save orders)
7. You'll get a **Web app URL** — copy it!

---

## Step 5 — Get your two links

Your Web app URL looks like:
```
https://script.google.com/macros/s/XXXXXXXXXX/exec
```

| Link | Who gets it |
|------|------------|
| `https://script.google.com/macros/s/XXXXXXXXXX/exec` | Share with **customers** |
| `https://script.google.com/macros/s/XXXXXXXXXX/exec?page=employee` | Share with **employees** |

---

## How it works day-to-day

### Customer flow:
1. Customer opens the customer link
2. Fills in name, email, phone
3. Selects product, color, size — sees if it's in stock
4. Adds items to their order list
5. Clicks Submit
6. Gets a confirmation email automatically

### Employee flow:
1. Employee opens the employee link
2. Enters the password
3. Sees all orders (Pending / Invoiced / Completed tabs)
4. Clicks an order to expand it
5. Clicks **"Send Invoice"** → invoice emailed to customer automatically
6. Prepares the physical items
7. Clicks **"Mark as Done"** → stock deducted from Google Sheet automatically

---

## After you make code changes

Every time you edit the code, you must **re-deploy**:

1. Click **Deploy** → **Manage deployments**
2. Click the pencil ✏ icon
3. Change Version to **"New version"**
4. Click **Deploy**

The URL stays the same — no need to resend links.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Authorization required" on the form | Re-deploy and go through the authorization steps again |
| Emails not sending | Make sure you authorized Gmail access during deployment |
| Stock not updating | Check that the product/color/size exactly matches what's in your sheet |
| Orders tab not appearing | Submit a test order — it creates the tab automatically |

---

## Security notes

- Change the `EMPLOYEE_PASS` to something only your team knows
- The customer form is public (anyone with the link can order) — only share it with your customers
- The employee link should only be shared with your team

---

*Need to add new products to the form? Ask Claude to update the Customer.html file with the new inventory data.*
