'use strict';
const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'coffer-change-this-secret-in-production';
const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'data', 'coffer.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ─────────────────────────────────────────
//  DATABASE SETUP
// ─────────────────────────────────────────
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password    TEXT    NOT NULL,
    first_name  TEXT    NOT NULL,
    last_name   TEXT    NOT NULL,
    age         INTEGER,
    country     TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id        TEXT,
    name             TEXT    NOT NULL,
    metal            TEXT    NOT NULL CHECK(metal IN ('gold','silver')),
    type             TEXT    NOT NULL CHECK(type IN ('jewellery','coin_bar','raw')),
    grade_name       TEXT    NOT NULL,
    purity           REAL    NOT NULL,
    grams            REAL    NOT NULL,
    notes            TEXT,
    purchase_date    TEXT,
    price_paid       REAL,
    price_paid_curr  TEXT,
    price_paid_usd   REAL,
    receipt          TEXT,
    sold             INTEGER DEFAULT 0,
    sell_price       REAL,
    sell_currency    TEXT,
    sell_price_usd   REAL,
    sell_date        TEXT,
    sell_notes       TEXT,
    added_at         TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id   TEXT,
    metal       TEXT    NOT NULL CHECK(metal IN ('gold','silver')),
    direction   TEXT    NOT NULL CHECK(direction IN ('above','below')),
    price       REAL    NOT NULL,
    note        TEXT,
    fired       INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS price_cache (
    id          INTEGER PRIMARY KEY CHECK(id = 1),
    gold        REAL    NOT NULL DEFAULT 3320,
    silver      REAL    NOT NULL DEFAULT 33.2,
    usd_inr     REAL    NOT NULL DEFAULT 83.5,
    usd_aed     REAL    NOT NULL DEFAULT 3.67,
    usd_eur     REAL    NOT NULL DEFAULT 0.92,
    usd_gbp     REAL    NOT NULL DEFAULT 0.79,
    fetched_at  TEXT    DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO price_cache (id) VALUES (1);
`);

// ─────────────────────────────────────────
//  PRICE FETCHING
// ─────────────────────────────────────────
let priceCache = db.prepare('SELECT * FROM price_cache WHERE id = 1').get();

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function refreshPrices() {
  console.log('[prices] Fetching spot prices…');
  let gold = priceCache.gold;
  let silver = priceCache.silver;
  let usd_inr = priceCache.usd_inr;
  let usd_aed = priceCache.usd_aed;
  let usd_eur = priceCache.usd_eur;
  let usd_gbp = priceCache.usd_gbp;

  let pricesFetched = false;

  // Source 1: metals-api.com (free, reliable)
  try {
    const data = await fetchJSON('https://metals-api.com/api/latest?access_key=&base=USD&symbols=XAU,XAG');
    // This may fail without key — that's fine, falls through
    if (data && data.rates && data.rates.XAU) {
      gold = 1 / data.rates.XAU;
      silver = 1 / data.rates.XAG;
      if (gold > 1000) { pricesFetched = true; console.log(`[prices] metals-api — Gold: $${gold.toFixed(2)}`); }
    }
  } catch(e) { console.warn('[prices] metals-api failed:', e.message); }

  // Source 2: metals.live
  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://api.metals.live/v1/spot');
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.gold)   gold   = item.gold;
          if (item.silver) silver = item.silver;
        });
        if (gold > 1000 && silver > 0) {
          pricesFetched = true;
          console.log(`[prices] metals.live — Gold: $${gold} Silver: $${silver}`);
        }
      }
    } catch (e) { console.warn('[prices] metals.live failed:', e.message); }
  }

  // Source 3: goldbroker scrape-friendly JSON
  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://data-asg.goldprice.org/dbXRates/USD');
      if (data && data.items && data.items[0]) {
        gold   = data.items[0].xauPrice;
        silver = data.items[0].xagPrice;
        if (gold > 1000) { pricesFetched = true; console.log(`[prices] goldprice.org — Gold: $${gold}`); }
      }
    } catch(e) { console.warn('[prices] goldprice.org failed:', e.message); }
  }

  // Source 4: frankfurter XAU/XAG
  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://api.frankfurter.app/latest?from=XAU&to=USD');
      if (data && data.rates && data.rates.USD) {
        gold = data.rates.USD;
        console.log(`[prices] frankfurter XAU — Gold: $${gold}`);
      }
      const data2 = await fetchJSON('https://api.frankfurter.app/latest?from=XAG&to=USD');
      if (data2 && data2.rates && data2.rates.USD) {
        silver = data2.rates.USD;
        console.log(`[prices] frankfurter XAG — Silver: $${silver}`);
      }
      if (gold > 1000) pricesFetched = true;
    } catch (e) { console.warn('[prices] frankfurter failed:', e.message); }
  }

  if (!pricesFetched) {
    console.warn('[prices] All price sources failed, using cached values');
  }

  // Exchange rates — try multiple sources
  let fxFetched = false;
  try {
    const fx = await fetchJSON('https://api.exchangerate-api.com/v4/latest/USD');
    if (fx && fx.rates) {
      usd_inr = fx.rates.INR || usd_inr;
      usd_aed = fx.rates.AED || usd_aed;
      usd_eur = fx.rates.EUR || usd_eur;
      usd_gbp = fx.rates.GBP || usd_gbp;
      fxFetched = true;
      console.log(`[prices] FX — INR: ${usd_inr}`);
    }
  } catch (e) { console.warn('[prices] exchangerate-api failed:', e.message); }

  if (!fxFetched) {
    try {
      const fx2 = await fetchJSON('https://open.er-api.com/v6/latest/USD');
      if (fx2 && fx2.rates) {
        usd_inr = fx2.rates.INR || usd_inr;
        usd_aed = fx2.rates.AED || usd_aed;
        usd_eur = fx2.rates.EUR || usd_eur;
        usd_gbp = fx2.rates.GBP || usd_gbp;
        console.log(`[prices] FX fallback — INR: ${usd_inr}`);
      }
    } catch(e) { console.warn('[prices] open.er-api failed:', e.message); }
  }

  // Update DB + in-memory cache
  db.prepare(`
    UPDATE price_cache SET gold=?, silver=?, usd_inr=?, usd_aed=?, usd_eur=?, usd_gbp=?, fetched_at=datetime('now')
    WHERE id=1
  `).run(gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp);

  priceCache = { gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp };
}

// Refresh every 5 minutes
cron.schedule('*/5 * * * *', refreshPrices);
// Fetch immediately on startup
refreshPrices().catch(console.error);

// ─────────────────────────────────────────
//  EXPRESS APP
// ─────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*', // tighten this to your frontend domain in production
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' })); // 10mb for receipt images
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function itemToClient(row) {
  return {
    id:               row.id,
    clientId:         row.client_id,
    name:             row.name,
    metal:            row.metal,
    type:             row.type,
    gradeName:        row.grade_name,
    purity:           row.purity,
    grams:            row.grams,
    notes:            row.notes || '',
    purchaseDate:     row.purchase_date || '',
    pricePaid:        row.price_paid,
    pricePaidCurrency:row.price_paid_curr || 'USD',
    pricePaidUSD:     row.price_paid_usd,
    receipt:          row.receipt || null,
    sold:             !!row.sold,
    sellPrice:        row.sell_price,
    sellCurrency:     row.sell_currency,
    sellPriceUSD:     row.sell_price_usd,
    sellDate:         row.sell_date || '',
    sellNotes:        row.sell_notes || '',
    addedAt:          row.added_at,
  };
}

function alertToClient(row) {
  return {
    id:        row.id,
    clientId:  row.client_id,
    metal:     row.metal,
    dir:       row.direction,
    price:     row.price,
    note:      row.note || '',
    fired:     !!row.fired,
    createdAt: row.created_at,
  };
}

// ─────────────────────────────────────────
//  ROUTES — AUTH
// ─────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName, age, country } = req.body;

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(`
    INSERT INTO users (email, password, first_name, last_name, age, country)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.toLowerCase().trim(), hash, firstName.trim(), lastName.trim(), age || null, country || null);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      age: user.age,
      country: user.country,
      joinedAt: user.created_at,
    }
  });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) {
    return res.status(401).json({ error: 'No account found with that email' });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      age: user.age,
      country: user.country,
      joinedAt: user.created_at,
    }
  });
});

// GET /api/auth/me  (validate token + return user)
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    age: user.age,
    country: user.country,
    joinedAt: user.created_at,
  });
});

// PATCH /api/auth/profile
app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, age, country, email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newEmail = email ? email.toLowerCase().trim() : user.email;
  if (newEmail !== user.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, user.id);
    if (conflict) return res.status(409).json({ error: 'That email is already in use' });
  }

  let newHash = user.password;
  if (password && password.length >= 6) {
    newHash = await bcrypt.hash(password, 12);
  }

  db.prepare(`
    UPDATE users SET email=?, password=?, first_name=?, last_name=?, age=?, country=?, updated_at=datetime('now')
    WHERE id=?
  `).run(newEmail, newHash, firstName || user.first_name, lastName || user.last_name,
         age || user.age, country || user.country, user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const token = jwt.sign({ userId: updated.id, email: updated.email }, JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: updated.id,
      email: updated.email,
      firstName: updated.first_name,
      lastName: updated.last_name,
      age: updated.age,
      country: updated.country,
      joinedAt: updated.created_at,
    }
  });
});

// DELETE /api/auth/account
app.delete('/api/auth/account', requireAuth, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.userId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  ROUTES — PRICES
// ─────────────────────────────────────────

// GET /api/prices
app.get('/api/prices', (req, res) => {
  res.json({
    gold:      priceCache.gold,
    silver:    priceCache.silver,
    rates: {
      USD: 1,
      INR: priceCache.usd_inr,
      AED: priceCache.usd_aed,
      EUR: priceCache.usd_eur,
      GBP: priceCache.usd_gbp,
    },
    fetchedAt: db.prepare('SELECT fetched_at FROM price_cache WHERE id=1').get().fetched_at,
  });
});

// ─────────────────────────────────────────
//  ROUTES — ITEMS
// ─────────────────────────────────────────

// GET /api/items
app.get('/api/items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY added_at DESC').all(req.user.userId);
  res.json(rows.map(itemToClient));
});

// POST /api/items
app.post('/api/items', requireAuth, (req, res) => {
  const d = req.body;
  const result = db.prepare(`
    INSERT INTO items
      (user_id, client_id, name, metal, type, grade_name, purity, grams, notes,
       purchase_date, price_paid, price_paid_curr, price_paid_usd, receipt, added_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.userId, d.clientId || null,
    d.name, d.metal, d.type, d.gradeName, d.purity, d.grams,
    d.notes || null, d.purchaseDate || null,
    d.pricePaid || null, d.pricePaidCurrency || 'USD', d.pricePaidUSD || null,
    d.receipt || null,
    d.addedAt || new Date().toISOString(),
  );
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(itemToClient(row));
});

// PUT /api/items/:id  (full update)
app.put('/api/items/:id', requireAuth, (req, res) => {
  const d = req.body;
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  db.prepare(`
    UPDATE items SET
      name=?, metal=?, type=?, grade_name=?, purity=?, grams=?, notes=?,
      purchase_date=?, price_paid=?, price_paid_curr=?, price_paid_usd=?,
      receipt=?, sold=?, sell_price=?, sell_currency=?, sell_price_usd=?,
      sell_date=?, sell_notes=?, updated_at=datetime('now')
    WHERE id=? AND user_id=?
  `).run(
    d.name, d.metal, d.type, d.gradeName, d.purity, d.grams, d.notes || null,
    d.purchaseDate || null, d.pricePaid || null, d.pricePaidCurrency || 'USD', d.pricePaidUSD || null,
    d.receipt || null, d.sold ? 1 : 0,
    d.sellPrice || null, d.sellCurrency || null, d.sellPriceUSD || null,
    d.sellDate || null, d.sellNotes || null,
    req.params.id, req.user.userId,
  );
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(itemToClient(row));
});

// DELETE /api/items/:id
app.delete('/api/items/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

// POST /api/items/sync  (bulk upsert — used when frontend goes online after offline use)
app.post('/api/items/sync', requireAuth, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });

  const upsert = db.prepare(`
    INSERT INTO items
      (user_id, client_id, name, metal, type, grade_name, purity, grams, notes,
       purchase_date, price_paid, price_paid_curr, price_paid_usd, receipt, sold,
       sell_price, sell_currency, sell_price_usd, sell_date, sell_notes, added_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertMany = db.transaction(arr => {
    for (const d of arr) {
      upsert.run(
        req.user.userId, d.clientId || null,
        d.name, d.metal, d.type, d.gradeName, d.purity, d.grams, d.notes || null,
        d.purchaseDate || null, d.pricePaid || null, d.pricePaidCurrency || 'USD', d.pricePaidUSD || null,
        d.receipt || null, d.sold ? 1 : 0,
        d.sellPrice || null, d.sellCurrency || null, d.sellPriceUSD || null,
        d.sellDate || null, d.sellNotes || null,
        d.addedAt || new Date().toISOString(),
      );
    }
  });
  insertMany(items);

  const rows = db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY added_at DESC').all(req.user.userId);
  res.json(rows.map(itemToClient));
});

// ─────────────────────────────────────────
//  ROUTES — ALERTS
// ─────────────────────────────────────────

// GET /api/alerts
app.get('/api/alerts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
  res.json(rows.map(alertToClient));
});

// POST /api/alerts
app.post('/api/alerts', requireAuth, (req, res) => {
  const { metal, dir, price, note, clientId } = req.body;
  if (!metal || !dir || !price) return res.status(400).json({ error: 'Missing required fields' });

  const result = db.prepare(`
    INSERT INTO alerts (user_id, client_id, metal, direction, price, note)
    VALUES (?,?,?,?,?,?)
  `).run(req.user.userId, clientId || null, metal, dir, price, note || null);

  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(alertToClient(row));
});

// PATCH /api/alerts/:id/fired
app.patch('/api/alerts/:id/fired', requireAuth, (req, res) => {
  db.prepare('UPDATE alerts SET fired=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.userId);
  res.json({ ok: true });
});

// DELETE /api/alerts/:id
app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM alerts WHERE id=? AND user_id=?').run(req.params.id, req.user.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

// ─────────────────────────────────────────
//  SERVE FRONTEND (SPA catch-all)
// ─────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`
      <h2>Coffer backend is running ✓</h2>
      <p>Place your frontend <code>index.html</code> in the <code>public/</code> folder.</p>
      <p>API base: <code>/api</code></p>
    `);
  }
});

// ─────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏛  Coffer backend running on port ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   JWT expires in 30 days\n`);
});
