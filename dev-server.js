// Local development server. Mimics Vercel: serves static files + mounts /api routes.
// Without Google credentials in .env it runs in MOCK mode (sample data, no writes).
const path = require('path');
const fs = require('fs');

// naive .env loader (avoids an extra dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.all('/api/dashboard', require('./api/dashboard'));
app.all('/api/transaction', require('./api/transaction'));
app.all('/api/transactions', require('./api/transactions'));
app.all('/api/batch', require('./api/batch'));
app.all('/api/loyverse-sync', require('./api/loyverse-sync'));
app.all('/api/commission', require('./api/commission'));
app.all('/api/advances', require('./api/advances'));
app.all('/api/card-receipts', require('./api/card-receipts'));
app.all('/api/bank-deposits', require('./api/bank-deposits'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const mock = !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  console.log(`Burmelin Finance app on http://localhost:${PORT} ${mock ? '(MOCK mode — no Google credentials found)' : '(connected to Google Sheets)'}`);
});
