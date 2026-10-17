// ============================================================
//  ORDER MANAGEMENT SYSTEM — Code.gs
//  Deployed automatically by GitHub Actions when merged into main
//  (see README → "Automatic Apps Script deploys"); don't edit it in the Apps Script editor
// ============================================================

// ─── CONFIGURATION ──────────────────────────────────────────
// Change these to match your business
var BUSINESS_NAME        = 'Burmelin';          // Your business name
var ORDERS_TAB_NAME      = 'Orders';               // Name for the new orders tab
var INVENTORY_SHEET_NAME = 'Palladium Stock';       // Palladium warehouse stock tab
var OLD_INVENTORY_SHEET_NAMES = ['Size Chart'];     // earlier name, still accepted
var RETAIL_STORES        = ['Bicasso 1', 'Bicasso 2', 'Bicasso Nana'];

// Passwords are NOT stored in this file (it's on GitHub). Set them in the Apps Script editor:
// Project Settings (⚙) → Script properties → EMPLOYEE_PASS, PASS_BICASSO_1, PASS_BICASSO_2, PASS_BICASSO_NANA
// (or set/reset any of them from the sheet's Logins tab — see applyResetPassword)
var PASSWORD_PROPS   = PropertiesService.getScriptProperties().getProperties();
var EMPLOYEE_PASS    = PASSWORD_PROPS.EMPLOYEE_PASS || null;
var RETAIL_PASSWORDS = {
  'Bicasso 1':    PASSWORD_PROPS.PASS_BICASSO_1 || null,
  'Bicasso 2':    PASSWORD_PROPS.PASS_BICASSO_2 || null,
  'Bicasso Nana': PASSWORD_PROPS.PASS_BICASSO_NANA || null
};
// A password only matches when it has actually been set (an unset password never lets anyone in)
function isEmployee(p) { return !!EMPLOYEE_PASS && p === EMPLOYEE_PASS; }
function isStorePass(store, p) { return !!RETAIL_PASSWORDS[store] && p === RETAIL_PASSWORDS[store]; }

// ─── RESET A PASSWORD FROM THE SHEET ────────────────────────
// Optional "Logins" tab: a "Login" column (Palladium, Bicasso 1, …) and a "Reset Password" column.
// Type a new password in Reset Password, then log in with it: it becomes the real password
// (saved in Script properties like the others) and the cell is cleared. Devices still using
// the old password are asked to log in again on their next request.
var LOGINS_SHEET = 'Logins';
var PASSWORD_PROP_OF = { 'Palladium': 'EMPLOYEE_PASS', 'Bicasso 1': 'PASS_BICASSO_1',
                         'Bicasso 2': 'PASS_BICASSO_2', 'Bicasso Nana': 'PASS_BICASSO_NANA' };
var RESET_MIN_LENGTH = 6;

// null = no reset for this login and password; {ok:true} = applied; {error} = refused
function applyResetPassword(login, typed) {
  if (!typed || !PASSWORD_PROP_OF[login]) return null;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOGINS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var data = sheet.getDataRange().getValues();
  var head = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var loginCol = head.indexOf('login'), resetCol = head.indexOf('reset password');
  if (loginCol < 0 || resetCol < 0) return null;            // column is optional
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][loginCol]).trim() !== login) continue;
    var wanted = String(data[r][resetCol]);
    if (!wanted || typed !== wanted) return null;
    if (wanted.length < RESET_MIN_LENGTH) {
      return { error: 'The new password typed in the sheet needs at least ' + RESET_MIN_LENGTH + ' characters' };
    }
    var lock = LockService.getScriptLock();
    try { lock.waitLock(25000); } catch (e) { return { error: 'Server busy — please try again.' }; }
    try {
      PropertiesService.getScriptProperties().setProperty(PASSWORD_PROP_OF[login], wanted);
      if (login === 'Palladium') EMPLOYEE_PASS = wanted;
      else RETAIL_PASSWORDS[login] = wanted;
      sheet.getRange(r + 1, resetCol + 1).clearContent();
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return { ok: true };
  }
  return null;
}
// ────────────────────────────────────────────────────────────

// Palladium's stock tab, by its current name or the old one (names compared without stray spaces)
function getPalladiumSheet(ss) {
  var wanted = [INVENTORY_SHEET_NAME].concat(OLD_INVENTORY_SHEET_NAMES);
  var sheets = ss.getSheets();
  for (var w = 0; w < wanted.length; w++) {
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName().trim() === wanted[w]) return sheets[i];
    }
  }
  return null;
}

// ─── WEB APP ENTRY POINT ─────────────────────────────────────
// Now doubles as a JSON API for the Vercel-hosted frontend.
//   GET  ?action=getBusinessName | getInventory     → JSON
//   POST {action:'getOrders'|'submitOrder'|...}      → JSON
// Falls back to serving the old HTML pages if no action is given.
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action) return handleApi(action, e.parameter, null);

  // Old Apps Script links are disabled — redirect everyone to the new Vercel site
  return HtmlService.createHtmlOutput(
    '<meta http-equiv="refresh" content="0; url=https://stockorder-form.vercel.app">'
    + '<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5}'
    + '.box{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 2px 20px rgba(0,0,0,.1)}'
    + 'h2{color:#1a1a2e;margin-bottom:10px}p{color:#666;margin-bottom:20px}'
    + 'a{background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700}'
    + '</style>'
    + '<div class="box"><h2>This link has moved</h2>'
    + '<p>Please use the new link below.</p>'
    + '<a href="https://stockorder-form.vercel.app">Go to Burmelin Order Form</a></div>'
  ).setTitle('Moved').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// POST entry — body is JSON: { action: '...', ...payload }
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return handleApi(body.action, body, body);
}

// Wrap any value as a JSON response (readable cross-origin by the Vercel site)
function jsonOut(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

// Reading stock, sales or history needs a logged-in store or Palladium. The app sends the
// login with every request as auth/authStore (in the request body, never in a link).
var READ_ACTIONS = { getInventory: 1, getAllRetailStock: 1, getStoreStock: 1, getStoreBundle: 1,
                     getSalesToday: 1, getStockHistory: 1, getSalesReport: 1 };
function isLoggedIn(b) { return !!b && (isEmployee(b.auth) || isStorePass(b.authStore, b.auth)); }

// ─── 30-DAY SIGN-IN TOKENS ───────────────────────────────────
// After logging in, a phone keeps a signed token instead of the password:
//   "v1.<base64 {l: login, t: issued ms, f: password fingerprint}>.<HMAC signature>"
// The secret lives in Script properties (TOKEN_SECRET, created on first use). A token is
// renewed when it's over a day old, so a phone in daily use stays signed in; one unused for
// 30 days must log in again. Changing that login's password changes the fingerprint, which
// signs every phone using the old password out.
var TOKEN_DAYS = 30;
var DAY_MS = 24 * 60 * 60 * 1000;
var LOGIN_ACTIONS = { verifyRetailStore: 1, getOrders: 1 };  // getOrders is Palladium's login

function passwordOf(login) {
  return login === 'Palladium' ? EMPLOYEE_PASS : (RETAIL_PASSWORDS[login] || null);
}
var tokenSecret_ = null;
function tokenSecret() {
  if (tokenSecret_) return tokenSecret_;
  tokenSecret_ = PASSWORD_PROPS.TOKEN_SECRET || null;
  if (!tokenSecret_) {
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      var props = PropertiesService.getScriptProperties();
      tokenSecret_ = props.getProperty('TOKEN_SECRET');
      if (!tokenSecret_) {
        tokenSecret_ = Utilities.getUuid() + Utilities.getUuid();
        props.setProperty('TOKEN_SECRET', tokenSecret_);
      }
    } finally { lock.releaseLock(); }
  }
  return tokenSecret_;
}
function tokenSign(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, tokenSecret()));
}
function passwordFingerprint(password) { return tokenSign('pw|' + password).slice(0, 16); }

function issueToken(login) {
  var password = passwordOf(login);
  if (!password) return null;
  var head = 'v1.' + Utilities.base64EncodeWebSafe(JSON.stringify({ l: login, t: Date.now(), f: passwordFingerprint(password) }));
  return head + '.' + tokenSign(head);
}
// {l, t} for a valid token, otherwise null
function readToken(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  if (tokenSign(parts[0] + '.' + parts[1]) !== parts[2]) return null;
  var s;
  try { s = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString()); } catch (e) { return null; }
  if (!s || !s.l || !(s.t > 0) || Date.now() - s.t > TOKEN_DAYS * DAY_MS) return null;
  var password = passwordOf(s.l);
  if (!password || passwordFingerprint(password) !== s.f) return null;
  return { l: s.l, t: s.t };
}
// The login a successful login action was for
function loginOfAction(action, body) {
  return action === 'getOrders' ? 'Palladium' : (body && body.storeName);
}

// Central API router — maps an action name to the existing functions
function handleApi(action, params, body) {
  // A token stands in for the password: the functions below still receive auth/password as before
  var renewFor = null;
  if (body && body.token) {
    var who = readToken(body.token);
    if (!who) return jsonOut({ success: false, error: 'Please log out and log in again.', needLogin: true });
    var password = passwordOf(who.l);
    body.auth = password; body.authStore = who.l;
    if (body.password == null) body.password = password;
    if (Date.now() - who.t > DAY_MS) renewFor = who.l;
  } else if (body && body.auth && body.authStore && passwordOf(body.authStore) === body.auth) {
    renewFor = body.authStore;   // a phone still saving the password: switch it to a token
  }
  if (READ_ACTIONS[action] && !isLoggedIn(body)) {
    return jsonOut({ success: false, error: 'Please log out and log in again.', needLogin: true });
  }
  var out;
  switch (action) {
    case 'getBusinessName': out = BUSINESS_NAME; break;
    case 'getInventory':    out = getInventory(); break;
    case 'getOrders':       out = getOrders(params.password); break;
    case 'submitOrder':     out = submitOrder(body.order); break;
    case 'sendInvoice':     out = sendInvoice(body.orderId, body.password); break;
    case 'deleteOrder':     out = deleteOrder(body.orderId, body.password); break;
    case 'editOrderItems':  out = editOrderItems(body.orderId, body.newItems, body.password); break;
    case 'markDone':             out = markDone(body.orderId, body.password); break;
    case 'getAllRetailStock':     out = getAllRetailStock(); break;
    case 'getStoreStock':        out = getRetailStock(body && body.storeName); break;
    case 'sellRetailStock':      out = sellRetailStock(body.storeName, body.password, body.rowId, body.qty, body.saleId); break;
    case 'sellRetailStockBatch': out = sellRetailStockBatch(body.storeName, body.password, body.items, body.saleId); break;
    case 'getSalesToday':        out = getSalesToday(body && body.storeName); break;
    case 'transferStock':        out = transferStock(body.fromStore, body.toStore, body.password, body.rowId, body.qty, body.transferId); break;
    case 'verifyRetailStore':    out = verifyRetailStore(body.storeName, body.password, body.withData); break;
    case 'getStoreBundle':       out = getStoreBundle(body && body.storeName); break;
    case 'addRetailStockItem':   out = addRetailStockItem(body.storeName, body.password, body.productId, body.category, body.colorNum, body.size, body.qty); break;
    case 'addRetailStockItems':  out = addRetailStockItems(body.storeName, body.password, body.items); break;
    case 'generateMasterSheet':  out = generateMasterSheet(body.password, body.targets); break;
    case 'getStockHistory':      out = getStockHistory(body, body.store, body.productId); break;
    case 'getSalesReport':       out = getSalesReport(body, body.days); break;
    default:                     out = { success: false, error: 'Unknown action: ' + action };
  }
  // Hand the phone a (new) token after a password login, a switch-over, or a renewal
  if (!renewFor && !(body && body.token) && LOGIN_ACTIONS[action]) renewFor = loginOfAction(action, body);
  if (renewFor && out && typeof out === 'object' && out.success === true) {
    var token = issueToken(renewFor);
    if (token) out._token = token;
  }
  return jsonOut(out);
}

// ─── GET BUSINESS NAME (called by HTML pages) ─────────────────
function getBusinessName() {
  return BUSINESS_NAME;
}

// ─── GET INVENTORY (called by Customer form on load) ──────────
// Reads your sheet live so the form always shows current stock.
// Sheet columns: A=ID, B=ProductID, C=Category, D=Color, E=Size, F=Stock
function getInventory() {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getPalladiumSheet(ss);
    if (!sheet) return { success: false, error: 'Palladium stock tab not found ("' + INVENTORY_SHEET_NAME + '").' };

    var data       = sheet.getDataRange().getValues();
    var inventory  = {};   // productId → { "Color X": { size: stock } }
    var categories = {};   // productId → category label

    // Find the header row (the row containing "Product ID" in column B)
    var dataStart = 1;
    for (var h = 0; h < data.length; h++) {
      if (String(data[h][1]).trim().toLowerCase() === 'product id') {
        dataStart = h + 1; // start reading from the row after headers
        break;
      }
    }

    for (var r = dataStart; r < data.length; r++) {
      var row       = data[r];
      var productId = String(row[1]).trim();
      var category  = String(row[2]).trim();
      var color     = String(row[3]).trim();
      var size      = String(row[4]).trim();
      var stock     = parseInt(row[5]);
      if (isNaN(stock)) stock = 0;

      if (!productId || !color || !size) continue;

      var colorKey = 'Color ' + color;

      if (!inventory[productId]) {
        inventory[productId] = {};
        categories[productId] = category;
      }
      if (!inventory[productId][colorKey]) inventory[productId][colorKey] = {};
      if (inventory[productId][colorKey][size] === undefined) inventory[productId][colorKey][size] = stock;
    }

    // Build groups from categories (preserves insertion order)
    var groupMap = {};
    var groupOrder = [];
    Object.keys(categories).forEach(function(pid) {
      var cat = categories[pid];
      if (!groupMap[cat]) { groupMap[cat] = []; groupOrder.push(cat); }
      groupMap[cat].push(pid);
    });
    var groups = groupOrder.map(function(cat) {
      return { label: cat, products: groupMap[cat] };
    });

    return { success: true, inventory: inventory, groups: groups };

  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── SUBMIT ORDER (called from Customer form) ─────────────────
// Dates are written as real dates with a fixed day/month/year format, so Sheets never guesses
// (a text '02/06/2026' was being read as 6 Feb). Read back, they become 'dd/MM/yyyy HH:mm' text.
var DATE_FMT = 'dd/MM/yyyy HH:mm';
function writeStamp(range, value) {
  if (value instanceof Date) range.setValue(value).setNumberFormat(DATE_FMT); else range.setValue(value);
}
function cellDateText(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), DATE_FMT) : String(v || '');
}

// orderData.orderToken: sent again unchanged on a retry, so a resend can't create a second order
function submitOrder(orderData) {
  orderData = orderData || {};
  var items = orderData.items || [];
  if (!items.length) return { success: false, error: 'No items in the order.' };
  var token = String(orderData.orderToken || '');
  var cache = CacheService.getScriptCache();
  var lock  = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  var orderId, dateStr;
  try {
    if (token) {
      var prevId = cache.get('order:' + token);
      if (prevId) return { success: true, orderId: prevId, alreadyDone: true };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ordersSheet = ss.getSheetByName(ORDERS_TAB_NAME);

    // Create Orders tab if it doesn't exist
    if (!ordersSheet) {
      ordersSheet = ss.insertSheet(ORDERS_TAB_NAME);
      var headers = [['Order ID','Date','Customer Name','Customer Email',
                      'Customer Phone','Notes','Items (JSON)','Total Qty',
                      'Status','Invoice Sent At','Completed At','Order Type','Shop Name']];
      ordersSheet.getRange(1, 1, 1, 13).setValues(headers);
      ordersSheet.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
      ordersSheet.setFrozenRows(1);
      ordersSheet.setColumnWidth(7, 300); // Items column wider
    }

    // Order ID: ORD-YYMMDD-XXXX, never reusing an existing one
    var now      = new Date();
    var tz       = Session.getScriptTimeZone();
    var datePart = Utilities.formatDate(now, tz, 'yyMMdd');
    dateStr      = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm');
    var taken = {};
    if (ordersSheet.getLastRow() > 1) {
      ordersSheet.getRange(2, 1, ordersSheet.getLastRow() - 1, 1).getValues()
        .forEach(function(r) { taken[String(r[0])] = true; });
    }
    do { orderId = 'ORD-' + datePart + '-' + Math.floor(1000 + Math.random() * 9000); } while (taken[orderId]);

    var totalQty = items.reduce(function(sum, i) { return sum + (parseInt(i.qty) || 0); }, 0);
    var row = ordersSheet.getLastRow() + 1;
    ordersSheet.getRange(row, 1, 1, 13).setValues([[
      orderId, now,
      orderData.customerName  || '',
      orderData.customerEmail || '',
      orderData.customerPhone || '',
      orderData.notes         || '',
      JSON.stringify(items), totalQty, 'Pending', '', '',
      orderData.orderType || 'customer',
      orderData.shopName  || ''
    ]]);
    ordersSheet.getRange(row, 2).setNumberFormat(DATE_FMT);
    ordersSheet.getRange(row, 9).setBackground('#fef9c3'); // Pending = yellow
    SpreadsheetApp.flush();
    if (token) cache.put('order:' + token, orderId, 21600);
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }

  // Emails after the lock is released, so they never hold up other requests
  try { sendConfirmationEmail(orderData, orderId, dateStr); } catch(e) {}
  try { notifyOwner(orderData, orderId, dateStr); } catch(e) {}
  return { success: true, orderId: orderId };
}

// ─── GET ALL ORDERS (called from Employee dashboard) ──────────
function getOrders(password) {
  if (!isEmployee(password)) {
    var reset = applyResetPassword('Palladium', password);
    if (reset && reset.error) return { success: false, error: reset.error, showError: true };
    if (!reset) return { success: false, error: 'Wrong password. Please try again.' };
  }
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);

    if (!sheet || sheet.getLastRow() < 2) {
      return { success: true, orders: [] };
    }

    var numRows = sheet.getLastRow() - 1;
    var numCols = sheet.getLastColumn();
    var data    = sheet.getRange(2, 1, numRows, numCols).getValues();

    var orders = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue; // skip empty rows
      orders.push({
        orderId      : row[0],
        date         : cellDateText(row[1]),
        customerName : row[2],
        customerEmail: row[3],
        customerPhone: row[4],
        notes        : row[5],
        items        : JSON.parse(row[6] || '[]'),
        totalQty     : row[7],
        status       : row[8] || 'Pending',
        invoiceSent  : cellDateText(row[9]),
        completed    : cellDateText(row[10]),
        orderType    : row[11] || 'customer',
        shopName     : row[12] || ''
      });
    }

    // Sort: Pending first, then Invoiced, then Completed
    var order = { 'Pending': 0, 'Invoiced': 1, 'Completed': 2 };
    orders.sort(function(a, b) {
      return (order[a.status] || 0) - (order[b.status] || 0);
    });

    return { success: true, orders: orders };

  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── MARK ORDER AS INVOICED (called after employee prints invoice) ────
function sendInvoice(orderId, password) {
  if (!isEmployee(password)) {
    return { success: false, error: 'Wrong password.' };
  }
  try {
    var order = findOrder(orderId);
    if (!order) return { success: false, error: 'Order not found: ' + orderId };

    var sentAt = new Date();
    updateOrderRow(orderId, { status: 'Invoiced', invoiceSent: sentAt });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── DELETE ORDER (called from Employee dashboard) ────────────
function deleteOrder(orderId, password) {
  if (!isEmployee(password)) {
    return { success: false, error: 'Wrong password.' };
  }
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
    if (!sheet || sheet.getLastRow() < 2) return { success: false, error: 'No orders found.' };

    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(orderId)) {
        sheet.deleteRow(i + 2);
        return { success: true };
      }
    }
    return { success: false, error: 'Order not found.' };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── EDIT ORDER ITEMS (called from Employee dashboard) ───────
function editOrderItems(orderId, newItems, password) {
  if (!isEmployee(password)) {
    return { success: false, error: 'Wrong password.' };
  }
  if (!newItems || !newItems.length) return { success: false, error: 'An order must keep at least one item.' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
    if (!sheet || sheet.getLastRow() < 2) return { success: false, error: 'Orders sheet not found.' };

    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(orderId)) {
        // Completed orders already moved stock; their items must match what was sent
        if (String(data[i][8]) === 'Completed') return { success: false, error: 'This order is already completed and can no longer be edited.' };
        var r        = i + 2;
        var totalQty = newItems.reduce(function(s, item) { return s + (parseInt(item.qty) || 0); }, 0);
        sheet.getRange(r, 7, 1, 2).setValues([[JSON.stringify(newItems), totalQty]]);
        return { success: true, totalQty: totalQty };
      }
    }
    return { success: false, error: 'Order not found.' };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── MARK ORDER DONE (called from Employee dashboard) ─────────
function markDone(orderId, password) {
  if (!isEmployee(password)) {
    return { success: false, error: 'Wrong password.' };
  }
  // One completion at a time, so a retry can't pass the "Completed" guard while the first is still running
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    var order = findOrder(orderId);
    if (!order) return { success: false, error: 'Order not found: ' + orderId };

    // ── GUARD: if already completed, do nothing (prevents double deduction) ──
    if (order.status === 'Completed') {
      return { success: true, warnings: [], alreadyCompleted: true };
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var lines = order.items.map(function(it) {
      return {
        pid: String(it.lp || it.product || '').trim(),
        col: String(it.lc || (it.color || '').replace(/^Color\s*/i, '')).trim(),
        sz:  String(it.ls || it.size || '').trim(),
        qty: parseInt(it.qty) || 0,
        label: it.product + ' | ' + it.color + ' | ' + it.size
      };
    });
    // Every order leaves Palladium's stock; a store order also lands in that store's stock
    var changes = [];
    var warnings = deductItemsFromWholesale(ss, order.items, lines, changes);
    var dest = order.orderType === 'store' && order.shopName ? order.shopName : (order.customerName || 'customer');
    changes.forEach(function(c) { c.action = 'Sent to ' + dest; });
    if (order.orderType === 'store' && order.shopName) {
      var got = [];
      warnings = warnings.concat(addItemsToStore(ss, order.shopName, lines, got));
      got.forEach(function(c) { c.action = 'Received from Palladium'; });
      changes = changes.concat(got);
    }
    logHistory(ss, changes, '', orderId, 'Palladium');

    // Mark as Completed — also record the invoice timestamp if not already set
    var doneAt  = new Date();
    var updates = { status: 'Completed', completed: doneAt };
    if (!order.invoiceSent) updates.invoiceSent = doneAt;
    updateOrderRow(orderId, updates);

    // Save final confirmed items to Sent Orders sheet
    try { saveSentOrder(ss, order, doneAt); } catch(e) {}

    SpreadsheetApp.flush();
    return { success: true, warnings: warnings };

  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── INTERNAL: SAVE SENT ORDER ────────────────────────────────
// Records the final employee-confirmed items to a "Sent Orders" sheet.
// This reflects what was actually sent from the warehouse, not the original request.
function saveSentOrder(ss, order, doneAt) {
  var SENT_SHEET = 'Sent Orders';
  var sheet = ss.getSheetByName(SENT_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(SENT_SHEET);
    var headers = [['Order ID','Date Sent','Customer Name','Customer Phone','Notes','Product','Color','Size','Qty']];
    sheet.getRange(1, 1, 1, 9).setValues(headers);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 9, 120);
  }

  var items = order.items || [];
  if (!items.length) return;
  var rows = items.map(function(item) {
    return [order.orderId, doneAt, order.customerName || '', order.customerPhone || '', order.notes || '',
            item.product, item.color, item.size, item.qty];
  });
  // Write all rows in one call, with alternate row shading
  var start = sheet.getLastRow() + 1;
  var range = sheet.getRange(start, 1, rows.length, 9);
  range.setValues(rows);
  sheet.getRange(start, 2, rows.length, 1).setNumberFormat(DATE_FMT);
  range.setBackgrounds(rows.map(function(r, i) {
    var bg = (start + i) % 2 === 0 ? '#f8fafc' : '#ffffff';
    return [bg, bg, bg, bg, bg, bg, bg, bg, bg];
  }));
}

// ─── INTERNAL: FIND ORDER ROW ─────────────────────────────────
function findOrder(orderId) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var numCols = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(orderId)) {
      return {
        rowIndex     : i + 2,
        orderId      : data[i][0],
        date         : cellDateText(data[i][1]),
        customerName : data[i][2],
        customerEmail: data[i][3],
        customerPhone: data[i][4],
        notes        : data[i][5],
        items        : JSON.parse(data[i][6] || '[]'),
        totalQty     : data[i][7],
        status       : data[i][8],
        invoiceSent  : data[i][9],
        orderType    : data[i][11] || 'customer',
        shopName     : data[i][12] || ''
      };
    }
  }
  return null;
}

// ─── INTERNAL: UPDATE ORDER ROW ───────────────────────────────
function updateOrderRow(orderId, updates) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
  if (!sheet) return;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(orderId)) {
      var r = i + 2; // actual sheet row

      if (updates.status) {
        sheet.getRange(r, 9).setValue(updates.status);
        // Color-code status
        var bg = updates.status === 'Completed' ? '#dcfce7'
               : updates.status === 'Invoiced'  ? '#dbeafe'
               : '#fef9c3';
        sheet.getRange(r, 9).setBackground(bg);
      }
      if (updates.invoiceSent !== undefined) writeStamp(sheet.getRange(r, 10), updates.invoiceSent);
      if (updates.completed   !== undefined) writeStamp(sheet.getRange(r, 11), updates.completed);
      return;
    }
  }
}

// ─── INTERNAL: ADD STOCK TO RETAIL STORE (used when marking store order Done) ─
// Stock sheets: first row whose column B says "Product ID" is the header
function sheetDataStart(data) {
  for (var h = 0; h < data.length; h++) {
    if (String(data[h][1]).trim().toLowerCase() === 'product id') return h + 1;
  }
  return 1;
}

// Add quantities to a shop's stock sheet: one read, then only the changed cells + one append.
// Each change is pushed to `changes` as {store,pid,col,sz,before,after} for the Stock History.
function addItemsToStore(ss, shopName, lines, changes) {
  var sheet = ss.getSheetByName(shopName + ' Stock');
  if (!sheet) return lines.map(function(l) { return l.label + ': Sheet not found for store: ' + shopName; });
  var data = sheet.getDataRange().getValues();
  var rowOf = {};
  for (var r = sheetDataStart(data); r < data.length; r++) {
    var k = String(data[r][1]).trim() + '|' + String(data[r][3]).trim() + '|' + String(data[r][4]).trim();
    if (rowOf[k] === undefined) rowOf[k] = r;
  }
  var changed = {}, appends = [], appendAt = {};
  lines.forEach(function(l) {
    var k = l.pid + '|' + l.col + '|' + l.sz, before;
    if (rowOf[k] !== undefined) {
      var row = rowOf[k];
      before = parseInt(data[row][5]) || 0;
      data[row][5] = before + l.qty;
      changed[row] = true;
    } else if (appendAt[k] !== undefined) {
      before = appends[appendAt[k]][5];
      appends[appendAt[k]][5] += l.qty;
    } else {
      before = 0;
      appendAt[k] = appends.length;
      appends.push([l.pid + l.col + l.sz, l.pid, '', l.col, l.sz, l.qty]);
    }
    if (changes) changes.push({ store: shopName, pid: l.pid, col: l.col, sz: l.sz, before: before, after: before + l.qty });
  });
  Object.keys(changed).forEach(function(row) { sheet.getRange(Number(row) + 1, 6).setValue(data[row][5]); });
  if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, 6).setValues(appends);
  return [];
}

// Deduct an order from Palladium's stock tab in one pass (changes recorded as in addItemsToStore)
function deductItemsFromWholesale(ss, items, lines, changes) {
  var warnings = [];
  var sheet = getPalladiumSheet(ss);
  var data = sheet ? sheet.getDataRange().getValues() : [];
  var rowOf = {};
  for (var r = sheetDataStart(data); r < data.length; r++) {
    var k = String(data[r][1]).trim() + '|' + String(data[r][3]).trim() + '|' + String(data[r][4]).trim();
    if (rowOf[k] === undefined) rowOf[k] = r;
  }
  var changed = {};
  lines.forEach(function(l) {
    var k = l.pid + '|' + l.col + '|' + l.sz;
    if (rowOf[k] !== undefined) {
      var row = rowOf[k];
      var have = parseInt(data[row][5]) || 0;
      if (have < l.qty) warnings.push(l.label + ': Palladium had only ' + have + ' — set to 0');
      data[row][5] = Math.max(0, have - l.qty);
      changed[row] = true;
      if (changes) changes.push({ store: 'Palladium', pid: l.pid, col: l.col, sz: l.sz, before: have, after: data[row][5] });
    } else {
      warnings.push(l.label + ': not found in ' + INVENTORY_SHEET_NAME + ' — Palladium stock not changed');
    }
  });
  Object.keys(changed).forEach(function(row) { sheet.getRange(Number(row) + 1, 6).setValue(data[row][5]); });
  return warnings;
}

// ─── INTERNAL: CONFIRMATION EMAIL TO CUSTOMER ─────────────────
function sendConfirmationEmail(orderData, orderId, dateStr) {
  if (!orderData.customerEmail) return;

  var itemLines = (orderData.items || []).map(function(i) {
    return '  • ' + i.product + '  |  ' + i.color + '  |  Size ' + i.size + '  |  Qty: ' + i.qty;
  }).join('\n');

  var body = 'Hi ' + orderData.customerName + ',\n\n'
    + 'Thank you! We received your order.\n\n'
    + 'Order ID : ' + orderId + '\n'
    + 'Date     : ' + dateStr + '\n\n'
    + 'Items:\n' + itemLines + '\n\n'
    + (orderData.notes ? 'Notes: ' + orderData.notes + '\n\n' : '')
    + 'We will prepare your order and send the invoice shortly.\n\n'
    + BUSINESS_NAME;

  GmailApp.sendEmail(
    orderData.customerEmail,
    'Order Received — ' + orderId + ' | ' + BUSINESS_NAME,
    body,
    { name: BUSINESS_NAME }
  );
}

// ─── INTERNAL: NOTIFY OWNER OF NEW ORDER ──────────────────────
function notifyOwner(orderData, orderId, dateStr) {
  var ownerEmail = Session.getActiveUser().getEmail();
  if (!ownerEmail) return;

  var itemLines = (orderData.items || []).map(function(i) {
    return '  • ' + i.product + '  |  ' + i.color + '  |  Size ' + i.size + '  |  Qty: ' + i.qty;
  }).join('\n');

  GmailApp.sendEmail(
    ownerEmail,
    '🛒 New Order: ' + orderId + ' from ' + orderData.customerName,
    'New order received!\n\n'
    + 'Order ID : ' + orderId + '\n'
    + 'Date     : ' + dateStr + '\n'
    + 'Customer : ' + orderData.customerName + '\n'
    + 'Email    : ' + orderData.customerEmail + '\n'
    + 'Phone    : ' + (orderData.customerPhone || 'N/A') + '\n\n'
    + 'Items:\n' + itemLines + '\n\n'
    + (orderData.notes ? 'Notes: ' + orderData.notes + '\n\n' : '')
    + 'Open your Employee Dashboard to manage this order.',
    { name: BUSINESS_NAME + ' – Order System' }
  );
}

// ─── TRANSFER STOCK BETWEEN STORES ───────────────────────────
// Code → row index for a stock sheet. A code is Product ID + Color + Size, taken from
// columns B/D/E (what the app shows); the typed ID in column A is only a fallback.
// Spaces are ignored, so "BZ003D BROWNL" and "BZ003DBROWNL" are the same code.
function normCode(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

function buildCodeIndex(data) {
  var idx = {}, start = sheetDataStart(data), r, k;
  for (r = start; r < data.length; r++) {
    k = normCode(String(data[r][1]) + String(data[r][3]) + String(data[r][4]));
    if (k && idx[k] === undefined) idx[k] = r;
  }
  for (r = start; r < data.length; r++) {
    k = normCode(data[r][0]);
    if (k && idx[k] === undefined) idx[k] = r;
  }
  return idx;
}

// transferId: sent again unchanged on a retry, so a resend can't move the stock twice
function transferStock(fromStore, toStore, password, rowId, qty, transferId) {
  if (!fromStore || !toStore) return { success: false, error: 'Select both stores.' };
  if (fromStore === toStore) return { success: false, error: 'Source and destination must differ.' };
  var validPass = isStorePass(fromStore, password)
               || isEmployee(password);
  if (!validPass) return { success: false, error: 'Wrong password — please log in again.' };
  var sellQ = parseInt(qty) || 0;
  if (sellQ <= 0) return { success: false, error: 'Quantity must be at least 1.' };
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    if (transferId) {
      var prev = cache.get('transfer:' + transferId);
      if (prev) { var p = JSON.parse(prev); p.alreadyDone = true; return p; }
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    function sheetFor(name) {
      return name === 'Palladium' ? getPalladiumSheet(ss) : ss.getSheetByName(name + ' Stock');
    }
    var fromSheet = sheetFor(fromStore), toSheet = sheetFor(toStore);
    if (!fromSheet) return { success: false, error: 'Sheet not found for: ' + fromStore };
    if (!toSheet)   return { success: false, error: 'Sheet not found for: ' + toStore };
    var code = normCode(rowId);

    var fData = fromSheet.getDataRange().getValues();
    var fr = buildCodeIndex(fData)[code];
    if (fr === undefined) return { success: false, error: 'ID not found in ' + fromStore + ': ' + rowId };
    var fromQty = parseInt(fData[fr][5]) || 0;
    if (fromQty < sellQ) return { success: false, error: 'Not enough stock in ' + fromStore + '. Available: ' + fromQty };
    var pid = String(fData[fr][1]).trim(), col = String(fData[fr][3]).trim(), sz = String(fData[fr][4]).trim();

    // Receiving store: same product/color/size; create the row if the store never had it
    var tData = toSheet.getDataRange().getValues();
    var tr = buildCodeIndex(tData)[normCode(pid + col + sz)];
    var toQty;
    fromSheet.getRange(fr + 1, 6).setValue(fromQty - sellQ);
    if (tr === undefined) {
      toQty = sellQ;
      toSheet.getRange(toSheet.getLastRow() + 1, 1, 1, 6).setValues([[pid + col + sz, pid, fData[fr][2] || '', col, sz, toQty]]);
    } else {
      toQty = (parseInt(tData[tr][5]) || 0) + sellQ;
      toSheet.getRange(tr + 1, 6).setValue(toQty);
    }
    var by = whoIs(password, fromStore);
    logHistory(ss, [
      { store: fromStore, pid: pid, col: col, sz: sz, before: fromQty, after: fromQty - sellQ, action: 'Transfer out → ' + toStore },
      { store: toStore, pid: pid, col: col, sz: sz, before: toQty - sellQ, after: toQty, action: 'Transfer in ← ' + fromStore }
    ], '', transferId || '', by);
    SpreadsheetApp.flush();
    var result = { success: true, fromNewQty: fromQty - sellQ, toNewQty: toQty, created: tr === undefined,
                   productId: pid, color: col, size: sz };
    if (transferId) cache.put('transfer:' + transferId, JSON.stringify(result), 21600);
    return result;
  } catch(e) { return { success: false, error: e.toString() }; }
  finally { lock.releaseLock(); }
}

// ─── SELL FROM RETAIL STORE ───────────────────────────────────
// Every sale is logged here; the saleId makes a repeated request (retry / double tap) a no-op
var SALES_LOG_SHEET = 'Sales Log';
var SALES_LOG_HEADERS = ['Date/Time', 'Store', 'Code', 'Product ID', 'Color', 'Size', 'Qty', 'Stock After', 'Sale ID'];

function getSalesLogSheet(ss) {
  var sheet = ss.getSheetByName(SALES_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SALES_LOG_SHEET);
    sheet.appendRow(SALES_LOG_HEADERS);
    sheet.getRange(1, 1, 1, SALES_LOG_HEADERS.length).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findLoggedSale(log, saleId) {
  var last = log.getLastRow();
  if (last < 2) return null;
  var from = Math.max(2, last - 999);
  var rows = log.getRange(from, 1, last - from + 1, SALES_LOG_HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][8]) === String(saleId)) return { newQty: rows[i][7] };
  }
  return null;
}

function sellRetailStock(storeName, password, rowId, qty, saleId) {
  var validPass = isStorePass(storeName, password)
               || isEmployee(password);
  if (!validPass) return { success: false, error: 'Wrong password.' };
  var sellQ = parseInt(qty) || 0;
  if (sellQ <= 0) return { success: false, error: 'Quantity must be at least 1.' };

  // One sale at a time, so a retry can't slip in before the first one is logged
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var log = getSalesLogSheet(ss);
    if (saleId) {
      var prev = findLoggedSale(log, saleId);
      if (prev) return { success: true, newQty: prev.newQty, alreadyDone: true };
    }
    var sheet = ss.getSheetByName(storeName + ' Stock');
    if (!sheet) return { success: false, error: 'Store sheet not found.' };
    var data  = sheet.getDataRange().getValues();
    var code  = normCode(rowId);
    var r = buildCodeIndex(data)[code];
    if (r !== undefined) {
      var cur = parseInt(data[r][5]) || 0;
      if (cur < sellQ) return { success: false, error: 'Not enough stock. Available: ' + cur };
      var newQty = cur - sellQ;
      sheet.getRange(r + 1, 6).setValue(newQty);
      log.appendRow([new Date(), storeName, code, data[r][1], data[r][3], data[r][4], sellQ, newQty, saleId || '']);
      logHistory(ss, [{ store: storeName, pid: String(data[r][1]).trim(), col: String(data[r][3]).trim(), sz: String(data[r][4]).trim(),
                        before: cur, after: newQty }], 'Sale', saleId || '', whoIs(password, storeName));
      SpreadsheetApp.flush();
      return { success: true, newQty: newQty };
    }
    return { success: false, error: 'ID not found: ' + rowId };
  } catch(e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

// Sell up to 5 lines as one sale. All lines are checked before anything is deducted,
// so a sale never goes through halfway. Lines are logged as saleId#1, saleId#2, …
function sellRetailStockBatch(storeName, password, items, saleId) {
  var validPass = isStorePass(storeName, password)
               || isEmployee(password);
  if (!validPass) return { success: false, error: 'Wrong password.' };
  if (!saleId) return { success: false, error: 'Missing sale ID.' };
  items = (items || []).map(function(it) {
    return { code: normCode(it.rowId), qty: parseInt(it.qty) || 0 };
  }).filter(function(it) { return it.code; });
  if (!items.length) return { success: false, error: 'No items to sell.' };
  if (items.length > 5) return { success: false, error: 'Maximum 5 items per sale.' };
  for (var i = 0; i < items.length; i++) {
    if (items[i].qty <= 0) return { success: false, error: items[i].code + ': quantity must be at least 1.' };
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var log = getSalesLogSheet(ss);
    if (findLoggedSale(log, saleId + '#1')) {
      return { success: true, alreadyDone: true, lines: items.map(function(it, k) {
        var p = findLoggedSale(log, saleId + '#' + (k + 1));
        return { code: it.code, qty: it.qty, newQty: p ? p.newQty : '' };
      }), sales: getSalesToday(storeName).sales };
    }
    var sheet = ss.getSheetByName(storeName + ' Stock');
    if (!sheet) return { success: false, error: 'Store sheet not found.' };
    var data = sheet.getDataRange().getValues();
    var rowOf = buildCodeIndex(data);
    // Validate everything first (same code on two lines counts together)
    var left = {};
    for (var j = 0; j < items.length; j++) {
      var c = items[j].code;
      if (rowOf[c] === undefined) return { success: false, error: 'ID not found: ' + c };
      if (left[c] === undefined) left[c] = parseInt(data[rowOf[c]][5]) || 0;
      left[c] -= items[j].qty;
      if (left[c] < 0) return { success: false, error: c + ': not enough stock. Available: ' + (parseInt(data[rowOf[c]][5]) || 0) };
    }
    // Apply
    var now = new Date(), stock = {}, logRows = [], lines = [];
    items.forEach(function(it, k) {
      var row = rowOf[it.code];
      if (stock[it.code] === undefined) stock[it.code] = parseInt(data[row][5]) || 0;
      stock[it.code] -= it.qty;
      logRows.push([now, storeName, it.code, data[row][1], data[row][3], data[row][4], it.qty, stock[it.code], saleId + '#' + (k + 1)]);
      lines.push({ code: it.code, qty: it.qty, newQty: stock[it.code] });
    });
    Object.keys(stock).forEach(function(code) { sheet.getRange(rowOf[code] + 1, 6).setValue(stock[code]); });
    log.getRange(log.getLastRow() + 1, 1, logRows.length, SALES_LOG_HEADERS.length).setValues(logRows);
    logHistory(ss, Object.keys(stock).map(function(code) {
      var row = rowOf[code];
      return { store: storeName, pid: String(data[row][1]).trim(), col: String(data[row][3]).trim(), sz: String(data[row][4]).trim(),
               before: parseInt(data[row][5]) || 0, after: stock[code] };
    }), 'Sale', saleId, whoIs(password, storeName));
    SpreadsheetApp.flush();
    return { success: true, lines: lines, sales: getSalesToday(storeName).sales };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

// Today's sales for one store (newest first), in the script's time zone
function getSalesToday(storeName) {
  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName(SALES_LOG_SHEET);
    if (!log || log.getLastRow() < 2) return { success: true, sales: [] };
    var tz    = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var last  = log.getLastRow();
    var from  = Math.max(2, last - 1999);
    var rows  = log.getRange(from, 1, last - from + 1, SALES_LOG_HEADERS.length).getValues();
    var sales = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var d = rows[i][0];
      if (!(d instanceof Date) || String(rows[i][1]) !== storeName) continue;
      if (Utilities.formatDate(d, tz, 'yyyy-MM-dd') !== today) continue;
      sales.push({
        time: Utilities.formatDate(d, tz, 'HH:mm'),
        code: String(rows[i][2]), productId: String(rows[i][3]), color: String(rows[i][4]),
        size: String(rows[i][5]), qty: parseInt(rows[i][6]) || 0, stockAfter: rows[i][7],
        saleId: String(rows[i][8]).split('#')[0]
      });
    }
    return { success: true, sales: sales };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ─── VERIFY RETAIL STORE LOGIN ────────────────────────────────
// withData: also return the store's stock + Palladium's inventory, so login needs one request
function verifyRetailStore(storeName, password, withData) {
  if (RETAIL_STORES.indexOf(storeName) === -1) return { success: false, error: 'Unknown store.' };
  if (!isStorePass(storeName, password)) {
    var reset = applyResetPassword(storeName, password);
    if (reset && reset.error) return { success: false, error: reset.error, showError: true };
    if (!reset) {
      if (!RETAIL_PASSWORDS[storeName]) return { success: false, error: 'Password not set up for ' + storeName + ' (Script properties).' };
      return { success: false, error: 'Wrong password.' };
    }
  }
  if (!withData) return { success: true };
  var bundle = getStoreBundle(storeName);
  bundle.success = true;
  return bundle;
}

// Store stock + Palladium inventory/groups in one request
function getStoreBundle(storeName) {
  var st = getRetailStock(storeName);
  if (!st.success) return st;
  var inv = getInventory();
  return {
    success: true,
    stores: st.stores,
    inventory: inv.success ? inv.inventory : null,
    groups: inv.success ? inv.groups : []
  };
}

// ─── GET ALL RETAIL STOCK (public read, no password needed) ───
function getAllRetailStock() {
  return getRetailStock(null);
}

// ─── GET RETAIL STOCK (one store or all stores) ───────────────
function getRetailStock(storeName) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Only real stores — an unknown name must not create a new tab
    if (storeName && RETAIL_STORES.indexOf(storeName) === -1 && storeName !== 'Palladium') return { success: false, error: 'Unknown store: ' + storeName };
    var storeNames = storeName ? [storeName] : ['Bicasso 1', 'Bicasso 2', 'Bicasso Nana', 'Palladium'];
    var storesData = {};
    var groups = null; // Palladium's categories, same shape as getInventory().groups

    storeNames.forEach(function(name) {
      var sheetName = name + ' Stock';
      var sheet = name === 'Palladium' ? getPalladiumSheet(ss) : ss.getSheetByName(sheetName);
      // Auto-create sheet from wholesale product list if missing (not for Palladium)
      if (!sheet && name !== 'Palladium') sheet = createRetailSheet(ss, sheetName);
      var inventory = {};

      if (sheet && sheet.getLastRow() > 1) {
        var data = sheet.getDataRange().getValues();
        var startRow = 1;
        for (var h = 0; h < data.length; h++) {
          if (String(data[h][1]).trim().toLowerCase() === 'product id') { startRow = h + 1; break; }
        }
        for (var r = startRow; r < data.length; r++) {
          var row      = data[r];
          var pid      = String(row[1]).trim();
          var color    = String(row[3]).trim();
          var size     = String(row[4]).trim();
          var stock    = parseInt(row[5]) || 0;
          if (!pid || !color || !size) continue;
          var colorKey = 'Color ' + color;
          if (!inventory[pid]) {
            inventory[pid] = {};
            if (name === 'Palladium') {
              var cat = String(row[2]).trim();
              groups = groups || [];
              var g = groups.filter(function(x) { return x.label === cat; })[0];
              if (!g) { g = { label: cat, products: [] }; groups.push(g); }
              g.products.push(pid);
            }
          }
          if (!inventory[pid][colorKey]) inventory[pid][colorKey] = {};
          if (inventory[pid][colorKey][size] === undefined) inventory[pid][colorKey][size] = stock;
        }
      }
      storesData[name] = inventory;
    });

    return groups ? { success: true, stores: storesData, groups: groups } : { success: true, stores: storesData };
  } catch(err) {
    return { success: false, error: err.toString() };
  }
}

// ─── CREATE RETAIL STORE SHEET (seeded from wholesale, qty=0) ─
function createRetailSheet(ss, sheetName) {
  try {
    var wholesale = getPalladiumSheet(ss);
    var newSheet = ss.insertSheet(sheetName);
    if (wholesale) {
      var src  = wholesale.getDataRange().getValues();
      var dest = src.map(function(row) { return row.slice(0, 6); });
      // Zero out stock column (F) for all data rows
      var startRow = 1;
      for (var h = 0; h < dest.length; h++) {
        if (String(dest[h][1]).trim().toLowerCase() === 'product id') { startRow = h + 1; break; }
      }
      for (var r = startRow; r < dest.length; r++) { dest[r][5] = 0; }
      newSheet.getRange(1, 1, dest.length, 6).setValues(dest);
      newSheet.getRange(startRow, 1, 1, 6).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
      newSheet.setFrozenRows(startRow);
    } else {
      var headers = [['ID','Product ID','Category','Color','Size','Stock']];
      newSheet.getRange(1, 1, 1, 6).setValues(headers);
      newSheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
      newSheet.setFrozenRows(1);
    }
    return newSheet;
  } catch(e) {
    return null;
  }
}

// ─── ADD MULTIPLE ROWS TO RETAIL STOCK SHEET (batch) ────────
// items = [{productId, category, colorNum, size, qty}, ...]
function addRetailStockItems(storeName, password, items) {
  var validPass = isStorePass(storeName, password)
               || isEmployee(password);
  if (!validPass) return { success: false, error: 'Wrong password.' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { success: false, error: 'Server busy — please try again.' }; }
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(storeName + ' Stock');
    if (!sheet) return { success: false, error: 'Sheet for "' + storeName + '" not found.' };

    // One read; later items with the same key update the same row / pending append
    var data  = sheet.getDataRange().getValues();
    var rowOf = {};
    for (var r = sheetDataStart(data); r < data.length; r++) {
      var k = normCode(data[r][1]) + '|' + normCode(data[r][3]) + '|' + normCode(data[r][4]);
      if (rowOf[k] === undefined) rowOf[k] = r;
    }
    var appends = [], appendAt = {}, results = [], changes = [];
    (items || []).forEach(function(it) {
      var pid = normCode(it.productId), col = String(it.colorNum).trim(), sz = String(it.size).trim();
      var qty = parseInt(it.qty) || 0, key = pid + '|' + normCode(col) + '|' + normCode(sz);
      if (!pid || !col || !sz) { results.push({ size: sz, ok: false }); return; }
      if (rowOf[key] !== undefined) {
        var row = rowOf[key];
        changes.push({ store: storeName, pid: pid, col: col, sz: sz, before: parseInt(data[row][5]) || 0, after: qty });
        data[row][5] = qty;
        sheet.getRange(row + 1, 6).setValue(qty);
      } else if (appendAt[key] !== undefined) {
        changes.push({ store: storeName, pid: pid, col: col, sz: sz, before: appends[appendAt[key]][5], after: qty });
        appends[appendAt[key]][5] = qty;
      } else {
        changes.push({ store: storeName, pid: pid, col: col, sz: sz, before: 0, after: qty });
        appendAt[key] = appends.length;
        appends.push([pid + col + sz, pid, it.category || '', col, sz, qty]);
      }
      results.push({ size: sz, ok: true });
    });
    if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, 6).setValues(appends);
    logHistory(ss, changes, isEmployee(password) ? 'Palladium edit' : 'Count', '', whoIs(password, storeName));
    SpreadsheetApp.flush();
    return { success: true, results: results };
  } catch(err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── ADD NEW ROW TO RETAIL STOCK SHEET ───────────────────────
// Palladium/employee only — set one size's quantity in a store's sheet (adds the row if missing)
function addRetailStockItem(storeName, password, productId, category, colorNum, size, qty) {
  var validPass = isStorePass(storeName, password)
               || isEmployee(password);
  if (!validPass) return { success: false, error: 'Wrong password.' };
  return addRetailStockItems(storeName, password, [{ productId: productId, category: category, colorNum: colorNum, size: size, qty: qty }]);
}

// ─── GENERATE MASTER SHEET ────────────────────────────────────────────────────
// Sizes in natural order: numbers ascending, then S < M < L < XL …, then anything else
function sortSizesGs(a, b) {
  var na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  var order = ['XS','S','M','L','XL','XXL','2XL','3XL','XXXL','4XL','5XL'];
  var ia = order.indexOf(String(a).toUpperCase()), ib = order.indexOf(String(b).toUpperCase());
  if (ia > -1 && ib > -1) return ia - ib;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// Collects a whole sheet in memory and writes it in four calls (values, colors, fonts, bold)
function sheetWriter(width) {
  var w = { vals: [], bgs: [], fcs: [], fws: [] };
  w.row = function(values, bg, fc, bold) {
    var v = [], b = [], f = [], fw = [];
    for (var i = 0; i < width; i++) {
      var inRow = i < values.length;
      v.push(inRow ? values[i] : '');
      b.push(inRow && bg ? bg : '#ffffff');
      f.push(fc || '#000000');
      fw.push(inRow && bold ? 'bold' : 'normal');
    }
    w.vals.push(v); w.bgs.push(b); w.fcs.push(f); w.fws.push(fw);
    return w.vals.length - 1;
  };
  w.cell = function(r, c, bg, fc, bold) {
    if (bg) w.bgs[r][c] = bg;
    if (fc) w.fcs[r][c] = fc;
    if (bold) w.fws[r][c] = 'bold';
  };
  w.write = function(sheet) {
    if (!w.vals.length) return;
    var rg = sheet.getRange(1, 1, w.vals.length, width);
    rg.setValues(w.vals); rg.setBackgrounds(w.bgs); rg.setFontColors(w.fcs); rg.setFontWeights(w.fws);
  };
  return w;
}

// Pivot layout: one section per product code, sizes as columns, colors as rows,
// quantities = all stores combined (Palladium + Bicasso 1 + Bicasso 2 + Bicasso Nana).
// Also writes "Order Plan": per color/size, how many to order to reach the targets.
function generateMasterSheet(password, targets) {
  if (!isEmployee(password)) return { success: false, error: 'Wrong password.' };
  targets = targets || {};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var STORES = ['Bicasso 1', 'Bicasso 2', 'Bicasso Nana'];

    var wsSheet = getPalladiumSheet(ss);
    if (!wsSheet) return { success: false, error: 'Palladium stock tab not found.' };
    var wData = wsSheet.getDataRange().getValues();

    var palMap = {}, productOrder = [], colorOrder = {}, sizeOrder = {}, categoryMap = {};
    for (var r = sheetDataStart(wData); r < wData.length; r++) {
      var row = wData[r];
      var pid = String(row[1]).trim(), cat = String(row[2]).trim();
      var cn = String(row[3]).trim(), sz = String(row[4]).trim(), qty = parseInt(row[5]) || 0;
      if (!pid || !cn || !sz) continue;
      if (!palMap[pid]) { palMap[pid] = {}; productOrder.push(pid); colorOrder[pid] = []; sizeOrder[pid] = []; categoryMap[pid] = cat; }
      if (!palMap[pid][cn]) { palMap[pid][cn] = {}; colorOrder[pid].push(cn); }
      if (sizeOrder[pid].indexOf(sz) === -1) sizeOrder[pid].push(sz);
      if (palMap[pid][cn][sz] === undefined) palMap[pid][cn][sz] = qty;
    }
    var width = 2;
    productOrder.forEach(function(p) { sizeOrder[p].sort(sortSizesGs); width = Math.max(width, sizeOrder[p].length + 2); });

    var retailMap = {};
    STORES.forEach(function(s) {
      retailMap[s] = {};
      var sh = ss.getSheetByName(s + ' Stock');
      if (!sh) return;
      var d = sh.getDataRange().getValues();
      for (var r2 = sheetDataStart(d); r2 < d.length; r2++) {
        var pid2 = String(d[r2][1]).trim(), cn2 = String(d[r2][3]).trim().replace(/^Color\s*/i, '');
        var sz2 = String(d[r2][4]).trim(), qty2 = parseInt(d[r2][5]) || 0;
        if (!pid2 || !cn2 || !sz2) continue;
        var k = pid2 + '||' + cn2 + '||' + sz2;
        retailMap[s][k] = (retailMap[s][k] || 0) + qty2;
      }
    });
    function totalAt(pid, cn, sz) {
      var pal = (palMap[pid][cn] && palMap[pid][cn][sz] !== undefined) ? (parseInt(palMap[pid][cn][sz]) || 0) : 0;
      var retail = 0;
      STORES.forEach(function(s) { retail += (retailMap[s][pid + '||' + cn + '||' + sz] || 0); });
      return pal + retail;
    }
    function header(pid) {
      var h = [pid + (categoryMap[pid] ? '  ' + categoryMap[pid] : '')];
      sizeOrder[pid].forEach(function(sz) { h.push(sz); });
      h.push('Total');
      return h;
    }

    // ── Master ──
    var m = sheetWriter(width);
    productOrder.forEach(function(pid) {
      var sizes = sizeOrder[pid], numCols = sizes.length + 2;
      m.row(header(pid), '#1a5c2f', '#f5d020', true);
      var colTotals = sizes.map(function() { return 0; }), grand = 0;
      colorOrder[pid].forEach(function(cn, ci) {
        var line = ['Color ' + cn], rowTotal = 0;
        sizes.forEach(function(sz, si) { var v = totalAt(pid, cn, sz); line.push(v); rowTotal += v; colTotals[si] += v; });
        line.push(rowTotal); grand += rowTotal;
        var ri = m.row(line, ci % 2 === 0 ? '#fff9db' : '#ffffff', '#000000', false);
        m.cell(ri, 0, null, null, true);
        m.cell(ri, numCols - 1, '#e0e7ff', '#3730a3', true);
      });
      var ti = m.row(['Total'].concat(colTotals, [grand]), '#e0e7ff', '#3730a3', true);
      m.cell(ti, numCols - 1, '#1a1a2e', '#c7d2fe', true);
      m.row([], null, null, false);
    });

    // ── Order Plan ──
    var p = sheetWriter(width);
    productOrder.forEach(function(pid) {
      var pidTargets = targets[pid] || {};
      var sizes = sizeOrder[pid], numCols = sizes.length + 2;
      p.row(header(pid), '#1a5c2f', '#f5d020', true);
      p.row(['🎯 Target'].concat(sizes.map(function(sz) { return pidTargets[sz] || 0; }), ['']), '#fef3c7', '#92400e', true);
      var colTotals = sizes.map(function() { return 0; }), grand = 0;
      colorOrder[pid].forEach(function(cn, ci) {
        var line = ['Color ' + cn], rowTotal = 0;
        sizes.forEach(function(sz, si) {
          var toOrder = Math.max(0, (parseInt(pidTargets[sz]) || 0) - totalAt(pid, cn, sz));
          line.push(toOrder); rowTotal += toOrder; colTotals[si] += toOrder;
        });
        line.push(rowTotal); grand += rowTotal;
        var ri = p.row(line, ci % 2 === 0 ? '#fff9db' : '#ffffff', '#000000', false);
        p.cell(ri, 0, null, null, true);
        sizes.forEach(function(sz, si) { if (line[si + 1] > 0) p.cell(ri, si + 1, '#fee2e2', '#b91c1c', true); });
        if (rowTotal > 0) p.cell(ri, numCols - 1, '#fca5a5', '#7f1d1d', true);
      });
      var ti = p.row(['Total to Order'].concat(colTotals, [grand]), '#1a1a2e', '#ffffff', true);
      if (grand > 0) p.cell(ti, numCols - 1, '#dc2626', '#ffffff', true);
      p.row([], null, null, false);
    });

    var master = ss.getSheetByName('Master') || ss.insertSheet('Master');
    master.clear();
    m.write(master);
    master.autoResizeColumns(1, width);
    var plan = ss.getSheetByName('Order Plan') || ss.insertSheet('Order Plan');
    plan.clear();
    p.write(plan);
    plan.autoResizeColumns(1, width);

    var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
    return { success: true, products: productOrder.length, updated: dateStr };

  } catch(e) { return { success: false, error: e.toString() }; }
}

// ─── STOCK HISTORY ────────────────────────────────────────────
// One row per change to any stock number: what changed, before → after, why, and who.
var HISTORY_SHEET   = 'Stock History';
var HISTORY_HEADERS = ['Date/Time', 'Store', 'Product ID', 'Color', 'Size', 'Change', 'Before', 'After', 'Action', 'Reference', 'By'];
var STOCK_TABS      = ['Bicasso 1 Stock', 'Bicasso 2 Stock', 'Bicasso Nana Stock'];

function getHistorySheet(ss) {
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HISTORY_SHEET);
    sh.getRange(1, 1, 1, HISTORY_HEADERS.length).setValues([HISTORY_HEADERS])
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// changes: [{store,pid,col,sz,before,after}] — unchanged quantities are skipped
function logHistory(ss, changes, action, ref, by) {
  var now = new Date();
  var rows = (changes || []).filter(function(c) { return c.before !== c.after; }).map(function(c) {
    return [now, c.store, c.pid, c.col, c.sz, c.after - c.before, c.before, c.after, c.action || action, c.ref || ref || '', by || ''];
  });
  if (!rows.length) return;
  try {
    var sh = getHistorySheet(ss);
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
    sh.getRange(start, 1, rows.length, 1).setNumberFormat(DATE_FMT);
  } catch (e) { /* history must never block a sale or transfer */ }
}

// Who made a change, from the password used
function whoIs(password, store) { return isEmployee(password) ? 'Palladium' : (store || ''); }

// Recent changes for one store (and optionally one product), newest first.
// A store may only read its own history; Palladium may read any.
function getStockHistory(b, store, productId) {
  if (!isEmployee(b.auth) && b.authStore !== store) return { success: false, error: 'You can only see your own store\'s history.' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(HISTORY_SHEET);
    if (!sh || sh.getLastRow() < 2) return { success: true, rows: [] };
    var last = sh.getLastRow(), from = Math.max(2, last - 4999);
    var data = sh.getRange(from, 1, last - from + 1, HISTORY_HEADERS.length).getValues();
    var pid = normCode(productId), out = [];
    for (var i = data.length - 1; i >= 0 && out.length < 60; i--) {
      var d = data[i];
      if (String(d[1]) !== store) continue;
      if (pid && normCode(d[2]) !== pid) continue;
      out.push({ when: d[0] instanceof Date ? d[0].toISOString() : String(d[0]), color: String(d[3]), size: String(d[4]), change: Number(d[5]) || 0,
                 before: d[6], after: d[7], action: String(d[8]), ref: String(d[9]), by: String(d[10]) });
    }
    return { success: true, rows: out };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// Hand edits in the Google Sheet are logged too (simple trigger: runs on every edit by a person).
// Only the Stock column (F) of the four stock tabs counts. A pasted block has no old values,
// so those rows show only the new number.
function onEdit(e) {
  try {
    var sh = e.range.getSheet(), name = sh.getName().trim();
    var store = (name === INVENTORY_SHEET_NAME || OLD_INVENTORY_SHEET_NAMES.indexOf(name) > -1) ? 'Palladium'
              : (STOCK_TABS.indexOf(name) > -1 ? name.replace(/ Stock$/, '') : null);
    if (!store || e.range.getColumn() > 6 || e.range.getLastColumn() < 6) return;
    var single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
    var rows = sh.getRange(e.range.getRow(), 1, e.range.getNumRows(), 6).getValues();
    var by = '';
    try { by = Session.getActiveUser().getEmail(); } catch (x) {}
    var now = new Date(), out = [];
    rows.forEach(function(row) {
      if (!String(row[1]).trim()) return;
      var after = parseInt(row[5]) || 0;
      var before = single ? (parseInt(e.oldValue) || 0) : '';
      if (single && before === after) return;
      out.push([now, store, String(row[1]).trim(), String(row[3]).trim(), String(row[4]).trim(),
                single ? after - before : '', before, after, single ? 'Sheet edit' : 'Sheet edit (pasted)', '', by || 'Google Sheet']);
    });
    if (!out.length) return;
    var hs = getHistorySheet(e.source), start = hs.getLastRow() + 1;
    hs.getRange(start, 1, out.length, HISTORY_HEADERS.length).setValues(out);
    hs.getRange(start, 1, out.length, 1).setNumberFormat(DATE_FMT);
  } catch (err) { /* never interrupt typing in the sheet */ }
}

// ─── SALES REPORT ─────────────────────────────────────────────
// Palladium only: every sale line of the last `days` days, for the app to total up
function getSalesReport(b, days) {
  if (!isEmployee(b.auth)) return { success: false, error: 'Only Palladium can see the sales report.' };
  try {
    days = Math.min(Math.max(parseInt(days) || 7, 1), 92);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName(SALES_LOG_SHEET);
    if (!log || log.getLastRow() < 2) return { success: true, lines: [], days: days };
    var tz = Session.getScriptTimeZone();
    var since = new Date(); since.setDate(since.getDate() - (days - 1));
    var sinceKey = Utilities.formatDate(since, tz, 'yyyy-MM-dd');
    var last = log.getLastRow(), from = Math.max(2, last - 9999);
    var rows = log.getRange(from, 1, last - from + 1, SALES_LOG_HEADERS.length).getValues();
    var lines = [];
    rows.forEach(function(r) {
      if (!(r[0] instanceof Date)) return;
      var day = Utilities.formatDate(r[0], tz, 'yyyy-MM-dd');
      if (day < sinceKey) return;
      lines.push([day, String(r[1]), String(r[3]), String(r[4]), String(r[5]), parseInt(r[6]) || 0]);
    });
    return { success: true, lines: lines, days: days, since: sinceKey };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ─── DAILY BACKUP ─────────────────────────────────────────────
// Run setupDailyBackup() once from the Apps Script editor. It makes a copy now and then
// every night, in a Drive folder "Burmelin Backups", keeping the newest 30 copies.
var BACKUP_FOLDER = 'Burmelin Backups';
var BACKUP_KEEP   = 30;

function dailyBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' — backup ' + stamp, folder);
  var files = [], f = folder.getFiles();
  while (f.hasNext()) files.push(f.next());
  files.sort(function(a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function(old) { old.setTrashed(true); }); // stays in Drive's trash for 30 days
}

function setupDailyBackup() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(23).create();
  dailyBackup();
}
