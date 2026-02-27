'use strict'; // v2 - postgres
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'coffer-change-this-secret-in-production';

console.log('[config] DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 40) + '...' : 'NOT SET');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:HCqkEOVjGNJKsdwkIgPUhSHkQBEdZLZE@turntable.proxy.rlwy.net:36567/railway',
  ssl: { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);

async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      age         INTEGER,
      country     TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS items (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id        TEXT,
      name             TEXT NOT NULL,
      metal            TEXT NOT NULL CHECK(metal IN ('gold','silver')),
      type             TEXT NOT NULL CHECK(type IN ('jewellery','coin_bar','raw')),
      grade_name       TEXT NOT NULL,
      purity           REAL NOT NULL,
      grams            REAL NOT NULL,
      notes            TEXT,
      purchase_date    TEXT,
      price_paid       REAL,
      price_paid_curr  TEXT,
      price_paid_usd   REAL,
      receipt          TEXT,
      sold             BOOLEAN DEFAULT FALSE,
      sell_price       REAL,
      sell_currency    TEXT,
      sell_price_usd   REAL,
      sell_date        TEXT,
      sell_notes       TEXT,
      added_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id   TEXT,
      metal       TEXT NOT NULL CHECK(metal IN ('gold','silver')),
      direction   TEXT NOT NULL CHECK(direction IN ('above','below')),
      price       REAL NOT NULL,
      note        TEXT,
      fired       BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS price_cache (
      id         INTEGER PRIMARY KEY CHECK(id = 1),
      gold       REAL NOT NULL DEFAULT 3320,
      silver     REAL NOT NULL DEFAULT 33.2,
      usd_inr    REAL NOT NULL DEFAULT 83.5,
      usd_aed    REAL NOT NULL DEFAULT 3.67,
      usd_eur    REAL NOT NULL DEFAULT 0.92,
      usd_gbp    REAL NOT NULL DEFAULT 0.79,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO price_cache (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
  console.log('[db] Tables ready');
}

let priceCache = { gold: 3320, silver: 33.2, usd_inr: 83.5, usd_aed: 3.67, usd_eur: 0.92, usd_gbp: 0.79 };

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function refreshPrices() {
  console.log('[prices] Fetching…');
  let { gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp } = priceCache;
  let pricesFetched = false;

  try {
    const data = await fetchJSON('https://api.metals.live/v1/spot');
    if (Array.isArray(data)) {
      data.forEach(item => { if (item.gold) gold = item.gold; if (item.silver) silver = item.silver; });
      if (gold > 1000) { pricesFetched = true; console.log(`[prices] metals.live — Gold: $${gold}`); }
    }
  } catch(e) { console.warn('[prices] metals.live failed:', e.message); }

  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://data-asg.goldprice.org/dbXRates/USD');
      if (data?.items?.[0]) {
        gold = data.items[0].xauPrice; silver = data.items[0].xagPrice;
        if (gold > 1000) { pricesFetched = true; console.log(`[prices] goldprice.org — Gold: $${gold}`); }
      }
    } catch(e) { console.warn('[prices] goldprice.org failed:', e.message); }
  }

  if (!pricesFetched) {
    try {
      const d1 = await fetchJSON('https://api.frankfurter.app/latest?from=XAU&to=USD');
      if (d1?.rates?.USD) gold = d1.rates.USD;
      const d2 = await fetchJSON('https://api.frankfurter.app/latest?from=XAG&to=USD');
      if (d2?.rates?.USD) silver = d2.rates.USD;
      if (gold > 1000) { pricesFetched = true; console.log(`[prices] frankfurter — Gold: $${gold}`); }
    } catch(e) { console.warn('[prices] frankfurter failed:', e.message); }
  }

  if (!pricesFetched) console.warn('[prices] All sources failed, using cache');

  try {
    const fx = await fetchJSON('https://api.exchangerate-api.com/v4/latest/USD');
    if (fx?.rates) { usd_inr = fx.rates.INR||usd_inr; usd_aed = fx.rates.AED||usd_aed; usd_eur = fx.rates.EUR||usd_eur; usd_gbp = fx.rates.GBP||usd_gbp; console.log(`[prices] FX INR: ${usd_inr}`); }
  } catch(e) {
    try {
      const fx2 = await fetchJSON('https://open.er-api.com/v6/latest/USD');
      if (fx2?.rates) { usd_inr = fx2.rates.INR||usd_inr; usd_aed = fx2.rates.AED||usd_aed; usd_eur = fx2.rates.EUR||usd_eur; usd_gbp = fx2.rates.GBP||usd_gbp; }
    } catch(e2) { console.warn('[prices] FX failed:', e2.message); }
  }

  priceCache = { gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp };
  await q(`UPDATE price_cache SET gold=$1,silver=$2,usd_inr=$3,usd_aed=$4,usd_eur=$5,usd_gbp=$6,fetched_at=NOW() WHERE id=1`,
    [gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp]);
}

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function itemToClient(r) {
  return { id:r.id, clientId:r.client_id, name:r.name, metal:r.metal, type:r.type, gradeName:r.grade_name,
    purity:r.purity, grams:r.grams, notes:r.notes||'', purchaseDate:r.purchase_date||'',
    pricePaid:r.price_paid, pricePaidCurrency:r.price_paid_curr||'USD', pricePaidUSD:r.price_paid_usd,
    receipt:r.receipt||null, sold:!!r.sold, sellPrice:r.sell_price, sellCurrency:r.sell_currency,
    sellPriceUSD:r.sell_price_usd, sellDate:r.sell_date||'', sellNotes:r.sell_notes||'', addedAt:r.added_at };
}

function alertToClient(r) {
  return { id:r.id, clientId:r.client_id, metal:r.metal, dir:r.direction, price:r.price,
    note:r.note||'', fired:!!r.fired, createdAt:r.created_at };
}

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName, age, country } = req.body;
  if (!email||!password||!firstName||!lastName) return res.status(400).json({ error:'Missing required fields' });
  if (password.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' });
  if (!email.includes('@')) return res.status(400).json({ error:'Invalid email address' });
  try {
    const exists = await q('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    if (exists.rows.length) return res.status(409).json({ error:'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const r = await q(`INSERT INTO users (email,password,first_name,last_name,age,country) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [email.toLowerCase().trim(), hash, firstName.trim(), lastName.trim(), age||null, country||null]);
    const u = r.rows[0];
    const token = jwt.sign({ userId:u.id, email:u.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at } });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Missing email or password' });
  try {
    const r = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error:'No account found with that email' });
    if (!await bcrypt.compare(password, u.password)) return res.status(401).json({ error:'Incorrect password' });
    const token = jwt.sign({ userId:u.id, email:u.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at } });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });
    res.json({ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, age, country, email, password } = req.body;
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });
    const newEmail = email ? email.toLowerCase().trim() : u.email;
    if (newEmail !== u.email) {
      const conflict = await q('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id!=$2', [newEmail, u.id]);
      if (conflict.rows.length) return res.status(409).json({ error:'That email is already in use' });
    }
    let newHash = u.password;
    if (password && password.length >= 6) newHash = await bcrypt.hash(password, 12);
    const updated = await q(`UPDATE users SET email=$1,password=$2,first_name=$3,last_name=$4,age=$5,country=$6,updated_at=NOW() WHERE id=$7 RETURNING *`,
      [newEmail, newHash, firstName||u.first_name, lastName||u.last_name, age||u.age, country||u.country, u.id]);
    const uu = updated.rows[0];
    const token = jwt.sign({ userId:uu.id, email:uu.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:uu.id, email:uu.email, firstName:uu.first_name, lastName:uu.last_name, age:uu.age, country:uu.country, joinedAt:uu.created_at } });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try { await q('DELETE FROM users WHERE id=$1', [req.user.userId]); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error:'Server error' }); }
});

// PRICES
app.get('/api/prices', async (req, res) => {
  try {
    const r = await q('SELECT fetched_at FROM price_cache WHERE id=1');
    res.json({ gold:priceCache.gold, silver:priceCache.silver,
      rates:{ USD:1, INR:priceCache.usd_inr, AED:priceCache.usd_aed, EUR:priceCache.usd_eur, GBP:priceCache.usd_gbp },
      fetchedAt:r.rows[0]?.fetched_at });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// ITEMS
app.get('/api/items', requireAuth, async (req, res) => {
  try { const r = await q('SELECT * FROM items WHERE user_id=$1 ORDER BY added_at DESC', [req.user.userId]); res.json(r.rows.map(itemToClient)); }
  catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.post('/api/items', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const r = await q(`INSERT INTO items (user_id,client_id,name,metal,type,grade_name,purity,grams,notes,purchase_date,price_paid,price_paid_curr,price_paid_usd,receipt,added_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.userId, d.clientId||null, d.name, d.metal, d.type, d.gradeName, d.purity, d.grams,
       d.notes||null, d.purchaseDate||null, d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null, d.addedAt||new Date().toISOString()]);
    res.status(201).json(itemToClient(r.rows[0]));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const exists = await q('SELECT id FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (!exists.rows.length) return res.status(404).json({ error:'Item not found' });
    const r = await q(`UPDATE items SET name=$1,metal=$2,type=$3,grade_name=$4,purity=$5,grams=$6,notes=$7,purchase_date=$8,price_paid=$9,price_paid_curr=$10,price_paid_usd=$11,receipt=$12,sold=$13,sell_price=$14,sell_currency=$15,sell_price_usd=$16,sell_date=$17,sell_notes=$18,updated_at=NOW() WHERE id=$19 AND user_id=$20 RETURNING *`,
      [d.name, d.metal, d.type, d.gradeName, d.purity, d.grams, d.notes||null, d.purchaseDate||null,
       d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null, !!d.sold,
       d.sellPrice||null, d.sellCurrency||null, d.sellPriceUSD||null, d.sellDate||null, d.sellNotes||null,
       req.params.id, req.user.userId]);
    res.json(itemToClient(r.rows[0]));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/items/:id', requireAuth, async (req, res) => {
  try {
    const r = await q('DELETE FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (r.rowCount === 0) return res.status(404).json({ error:'Item not found' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.post('/api/items/sync', requireAuth, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error:'items must be an array' });
  try {
    for (const d of items) {
      await q(`INSERT INTO items (user_id,client_id,name,metal,type,grade_name,purity,grams,notes,purchase_date,price_paid,price_paid_curr,price_paid_usd,receipt,sold,sell_price,sell_currency,sell_price_usd,sell_date,sell_notes,added_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT DO NOTHING`,
        [req.user.userId, d.clientId||null, d.name, d.metal, d.type, d.gradeName, d.purity, d.grams, d.notes||null,
         d.purchaseDate||null, d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null,
         !!d.sold, d.sellPrice||null, d.sellCurrency||null, d.sellPriceUSD||null, d.sellDate||null, d.sellNotes||null,
         d.addedAt||new Date().toISOString()]);
    }
    const r = await q('SELECT * FROM items WHERE user_id=$1 ORDER BY added_at DESC', [req.user.userId]);
    res.json(r.rows.map(itemToClient));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// ALERTS
app.get('/api/alerts', requireAuth, async (req, res) => {
  try { const r = await q('SELECT * FROM alerts WHERE user_id=$1 ORDER BY created_at DESC', [req.user.userId]); res.json(r.rows.map(alertToClient)); }
  catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  const { metal, dir, price, note, clientId } = req.body;
  if (!metal||!dir||!price) return res.status(400).json({ error:'Missing required fields' });
  try {
    const r = await q(`INSERT INTO alerts (user_id,client_id,metal,direction,price,note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.userId, clientId||null, metal, dir, price, note||null]);
    res.status(201).json(alertToClient(r.rows[0]));
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.patch('/api/alerts/:id/fired', requireAuth, async (req, res) => {
  try { await q('UPDATE alerts SET fired=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/alerts/:id', requireAuth, async (req, res) => {
  try {
    const r = await q('DELETE FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (r.rowCount === 0) return res.status(404).json({ error:'Alert not found' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// FRONTEND
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(indexPath); }
  else res.status(200).send('<h2>Coffer backend running ✓</h2>');
});

app.get('/health', (req, res) => res.json({ ok:true, uptime:process.uptime() }));

// START
initDB()
  .then(() => q('SELECT * FROM price_cache WHERE id=1'))
  .then(r => {
    if (r.rows[0]) priceCache = r.rows[0];
    cron.schedule('*/5 * * * *', refreshPrices);
    refreshPrices().catch(console.error);
    app.listen(PORT, () => console.log(`\n🏛  Coffer running on port ${PORT} (PostgreSQL)\n`));
  })
  .catch(err => { console.error('[fatal] DB init failed:', err); process.exit(1); });
