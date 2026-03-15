'use strict'; // v5 - rate limiting, history, email verify, web push
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const rateLimit  = require('express-rate-limit');
let   Sentry;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.2, environment: 'production' });
    console.log('[sentry] Enabled');
  }
} catch(e) { console.warn('[sentry] @sentry/node not installed'); }
let   webpush;
try { webpush = require('web-push'); } catch(e) { console.warn('[webpush] web-push not installed — push disabled'); }

const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'mya_9$Kp2#xL8nRvTw4@Yz6bNjHcFsUeGdK3mXpA7!';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '826792551094-s9dg885quvbfd04ocaohnkp1ar8jvm5h.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
const RESEND_KEY  = process.env.RESEND_API_KEY || process.env.MY_RESEND_KEY || 're_C6LyyCaZ_DWMmyNgHbcSdSAFpKxtoAyhR';
const APP_URL     = process.env.APP_URL || 'https://myaurum.app';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BObbou1l2U7fZqh1RsXxp3_gUNibmR1MXgQpGYSj9pXgkzZCzfMUfuNp9uPdm4jeJpuYPvJzb4yKoJE_uuox0Ls';
const VAPID_PRIVATE= process.env.VAPID_PRIVATE_KEY || 'eW-amR4xbefXF4BUBWTfLO6sg3SmKSPWllRUt4Uaqjs';
const VAPID_EMAIL  = process.env.VAPID_EMAIL || 'mailto:admin@myaurum.app';

console.log('[config] DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 40) + '...' : 'NOT SET');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cSANKPNApcPSSBMfqJkyeLAhUWrgcOwd@turntable.proxy.rlwy.net:36567/railway',
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
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id      TEXT,
      metal          TEXT NOT NULL CHECK(metal IN ('gold','silver')),
      direction      TEXT NOT NULL CHECK(direction IN ('above','below')),
      price          REAL NOT NULL,
      price_display  REAL,
      price_currency TEXT DEFAULT 'USD',
      notify_email   TEXT,
      note           TEXT,
      fired          BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
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
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          SERIAL PRIMARY KEY,
      gold        REAL NOT NULL,
      silver      REAL NOT NULL,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_verify_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, endpoint)
    );
    INSERT INTO price_cache (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  // Migrate existing alerts table to add new columns if they don't exist yet
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS price_display  REAL`);
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS price_currency TEXT DEFAULT 'USD'`);
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_email   TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_method TEXT DEFAULT 'email'`);

  // Setup VAPID for web push if keys are configured
  if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('[webpush] VAPID configured');
  }

  console.log('[db] Tables ready');
}

let priceCache = { gold: 3320, silver: 33.2, platinum: 980, usd_inr: 83.5, usd_aed: 3.67, usd_eur: 0.92, usd_gbp: 0.79 };

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
  let { gold, silver, platinum, usd_inr, usd_aed, usd_eur, usd_gbp } = priceCache;
  let pricesFetched = false;

  // Primary: gold-api.com — free, no key, no rate limit
  try {
    const [gData, sData, pData] = await Promise.all([
      fetchJSON('https://api.gold-api.com/price/XAU'),
      fetchJSON('https://api.gold-api.com/price/XAG'),
      fetchJSON('https://api.gold-api.com/price/XPT'),
    ]);
    if (gData?.price > 1000) { gold = gData.price; pricesFetched = true; console.log(`[prices] gold-api.com Gold: $${gold}`); }
    if (sData?.price > 0) { silver = sData.price; console.log(`[prices] gold-api.com Silver: $${silver}`); }
    if (pData?.price > 0) { platinum = pData.price; console.log(`[prices] gold-api.com Platinum: $${platinum}`); }
  } catch(e) { console.warn('[prices] gold-api.com failed:', e.message); }

  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://api.metals.live/v1/spot');
      if (Array.isArray(data)) {
        data.forEach(item => { if (item.gold) gold = item.gold; if (item.silver) silver = item.silver; });
        if (gold > 1000) { pricesFetched = true; console.log(`[prices] metals.live Gold: $${gold}`); }
      }
    } catch(e) { console.warn('[prices] metals.live failed:', e.message); }
  }

  if (!pricesFetched) {
    try {
      const data = await fetchJSON('https://data-asg.goldprice.org/dbXRates/USD');
      if (data?.items?.[0]) {
        gold = data.items[0].xauPrice; silver = data.items[0].xagPrice;
        if (gold > 1000) { pricesFetched = true; console.log(`[prices] goldprice.org Gold: $${gold}`); }
      }
    } catch(e) { console.warn('[prices] goldprice.org failed:', e.message); }
  }

  if (!pricesFetched) {
    try {
      const d1 = await fetchJSON('https://api.frankfurter.app/latest?from=XAU&to=USD');
      if (d1?.rates?.USD) gold = d1.rates.USD;
      const d2 = await fetchJSON('https://api.frankfurter.app/latest?from=XAG&to=USD');
      if (d2?.rates?.USD) silver = d2.rates.USD;
      if (gold > 1000) { pricesFetched = true; console.log(`[prices] frankfurter Gold: $${gold}`); }
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

  priceCache = { gold, silver, platinum, usd_inr, usd_aed, usd_eur, usd_gbp };
  await q(`UPDATE price_cache SET gold=$1,silver=$2,usd_inr=$3,usd_aed=$4,usd_eur=$5,usd_gbp=$6,fetched_at=NOW() WHERE id=1`,
    [gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp]);

  // Check price alerts after every price refresh
  // Record daily price snapshot for history chart
  try {
    await q('INSERT INTO price_history (gold, silver) VALUES ($1, $2)', [gold, silver]);
    // Keep only 90 days of history
    await q("DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '90 days'");
  } catch(e) { console.warn('[history] Could not record price snapshot:', e.message); }

  checkAndFireAlerts().catch(e => console.error('[alerts] checkAndFireAlerts error:', e.message));
}

// ─────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many attempts — please wait 15 minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many reset requests — please wait an hour and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting
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
    priceDisplay:r.price_display||null, priceCurrency:r.price_currency||'USD',
    note:r.note||'', fired:!!r.fired, createdAt:r.created_at };
}

// AUTH ROUTES
app.post('/api/auth/register', authLimiter, async (req, res) => {
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
    // Respond immediately — don't block on email
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:false } });
    // Send verification email in background
    setImmediate(async () => {
      try {
        const crypto = require('crypto');
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await q('INSERT INTO email_verify_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [u.id, verifyToken, expires]);
        const verifyUrl = `${APP_URL}/?verify=${verifyToken}`;
        await sendEmail({
          to: u.email,
          subject: 'Verify your MyAurum email address',
          html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px">
            <div style="font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:4px">MYAURUM</div>
            <div style="font-size:10px;color:#999;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">Precious Metals Ledger</div>
            <p style="color:#2C2410;font-size:14px;line-height:1.8">Hi ${u.first_name},</p>
            <p style="color:#555;font-size:13px;line-height:1.8">Welcome to MyAurum. Please verify your email address to activate your account.</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${verifyUrl}" style="background:linear-gradient(135deg,#B8860B,#D4A017);color:#fff;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:12px;letter-spacing:0.1em;font-weight:500">Verify My Email →</a>
            </div>
            <p style="color:#AAA;font-size:10px;line-height:1.7">This link expires in 24 hours. If you didn't create a MyAurum account, ignore this email.</p>
          </div>`,
        });
        console.log('[verify] Email sent successfully to:', u.email);
      } catch(e) { console.error('[verify] Could not send verification email:', e.message); }
    });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Missing email or password' });
  try {
    const r = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error:'No account found with that email' });
    if (!await bcrypt.compare(password, u.password)) return res.status(401).json({ error:'Incorrect password' });
    if (!u.email_verified) return res.status(403).json({ error:'email_not_verified' });
    await q('UPDATE users SET last_seen=NOW(), auth_method=$2 WHERE id=$1', [u.id, 'email']);
    const token = jwt.sign({ userId:u.id, email:u.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:true } });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });
    await q('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]);
    res.json({ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:!!u.email_verified });
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

// ─────────────────────────────────────────
//  EMAIL HELPER (shared by password reset + alert emails)
// ─────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: process.env.RESEND_FROM || 'MYAURUM Alerts <alerts@mail.myaurum.app>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {}),
    });
    console.log('[email] Sending to:', to);
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      timeout: 8000,
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('[email] Resend status:', res.statusCode, data);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Resend error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', e => { console.error('[email] Request error:', e.message); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Email request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────
//  ALERT EMAIL BUILDER
// ─────────────────────────────────────────
const INDIA_FACTOR = (10 / 31.1035) * 1.15 * 1.03;

function buildAlertEmail(alert, spotUSD) {
  const inrRate = priceCache.usd_inr || 84;
  const isGold  = alert.metal === 'gold';
  const metal   = isGold ? 'Gold' : 'Silver';
  const emoji   = isGold ? '🥇' : '🥈';
  const above   = (alert.direction||alert.dir) === 'above';
  const dirWord = above ? 'risen above' : 'fallen below';
  const dirArrow= above ? '↑' : '↓';
  const accent  = above ? '#2ECC8A' : '#E05C5C';
  const accentBg= above ? 'rgba(46,204,138,.12)' : 'rgba(224,92,92,.12)';
  const accentBd= above ? 'rgba(46,204,138,.3)'  : 'rgba(224,92,92,.3)';

  let targetFmt, spotFmt;
  if (alert.price_currency === 'INR') {
    const tv = alert.price_display || Math.round(alert.price * inrRate * INDIA_FACTOR);
    targetFmt = '&#8377;' + Math.round(tv).toLocaleString('en-IN') + ' / 10g';
    spotFmt   = '&#8377;' + Math.round(spotUSD * inrRate * INDIA_FACTOR).toLocaleString('en-IN') + ' / 10g';
  } else {
    const tv = alert.price_display || alert.price;
    targetFmt = '$' + Number(tv).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' / oz';
    spotFmt   = '$' + spotUSD.toFixed(2) + ' / oz';
  }

  const noteRow = alert.note
    ? `<p style="font-size:13px;color:#888;font-style:italic;margin:0 0 20px;padding:12px 16px;background:#F5F0E8;border-radius:8px;border-left:3px solid #D4A017">"${alert.note}"</p>`
    : '';

  const subject = `${emoji} ${metal} has ${dirWord} your target — MyAurum Alert`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px">
  <tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
    <p style="margin:5px 0 0;font-size:10px;color:#907030;letter-spacing:.22em;text-transform:uppercase">Price Alert</p>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:28px 32px 8px;text-align:center;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <span style="display:inline-block;background:${accentBg};border:1px solid ${accentBd};border-radius:24px;padding:7px 18px;font-size:11px;color:${accent};letter-spacing:.12em;text-transform:uppercase;font-weight:600">${dirArrow} Target Reached</span>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:12px 32px 28px;text-align:center;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <p style="font-size:40px;margin:0 0 2px;line-height:1">${emoji}</p>
    <p style="font-family:Georgia,serif;font-size:28px;font-weight:300;color:#2C2410;margin:0 0 4px">${metal}</p>
    <p style="font-size:13px;color:#999;margin:0 0 24px">has ${dirWord} your target</p>
    <table role="presentation" width="100%" style="border:1px solid #E8E0D0;border-radius:12px;overflow:hidden;margin-bottom:${alert.note ? '16px' : '24px'}">
      <tr style="background:#F5F0E8">
        <td style="padding:14px 20px;font-size:11px;color:#999;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid #E8E0D0">Your Target</td>
        <td style="padding:14px 20px;font-size:15px;font-weight:600;color:#2C2410;text-align:right;border-bottom:1px solid #E8E0D0;font-family:'Courier New',monospace">${targetFmt}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:11px;color:#999;letter-spacing:.1em;text-transform:uppercase">Current Spot</td>
        <td style="padding:14px 20px;font-size:15px;font-weight:600;color:#B8860B;text-align:right;font-family:'Courier New',monospace">${spotFmt}</td>
      </tr>
    </table>
    ${noteRow}
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 32px;border-radius:8px;font-weight:600">Open My Aurum &rarr;</a>
  </td></tr>
  <tr><td style="background:#F0EBE0;padding:18px 32px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px;text-align:center">
    <p style="margin:0;font-size:10px;color:#BBB;line-height:1.85">
      This alert is now marked as fired and will not trigger again.<br>
      Prices are indicative spot rates — actual buyback values vary by dealer.<br>
      <a href="${APP_URL}" style="color:#B8860B;text-decoration:none">Manage alerts in MyAurum</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const textLines = [
    'MyAurum Price Alert',
    '------------------',
    `${metal} has ${dirWord} your target.`,
    '',
    `Your target : ${targetFmt}`,
    `Current spot: ${spotFmt}`,
    alert.note ? `Note        : "${alert.note}"` : null,
    '',
    'This alert is now marked as fired and will not trigger again.',
    `Open MyAurum: ${APP_URL}`,
  ].filter(l => l !== null).join('\n');

  return { subject, html, text: textLines };
}

// ─────────────────────────────────────────
//  ALERT CHECKER  (runs after every price refresh)
// ─────────────────────────────────────────
async function checkAndFireAlerts() {
  let alerts;
  try {
    alerts = await q(`SELECT a.*, u.email AS user_email
      FROM alerts a JOIN users u ON u.id = a.user_id
      WHERE a.fired = FALSE`);
    alerts = alerts.rows;
  } catch(e) {
    console.error('[alerts] DB query failed:', e.message);
    return;
  }

  if (!alerts.length) return;

  for (const alert of alerts) {
    const spot = alert.metal === 'gold' ? priceCache.gold : alert.metal === 'platinum' ? priceCache.platinum : priceCache.silver;
    const hit  = (alert.direction||alert.dir) === 'above' ? spot >= alert.price : spot <= alert.price;
    if (!hit) continue;

    // Mark fired first — prevents double-send if email throws
    try {
      await q('UPDATE alerts SET fired=TRUE WHERE id=$1', [alert.id]);
    } catch(e) {
      console.error(`[alerts] Could not mark alert ${alert.id} fired:`, e.message);
      continue;
    }

    const emailAddr = alert.notify_email || alert.user_email;
    console.log(`[alerts] Alert ${alert.id} fired spot:${spot} target:${alert.price} dir:${alert.direction||alert.dir} email:${emailAddr}`);
    if (!emailAddr) {
      console.log(`[alerts] Alert ${alert.id} skipped (no email address)`);
      continue;
    }

    const { subject, html, text } = buildAlertEmail(alert, spot);
    try {
      await sendEmail({ to: emailAddr, subject, html, text });
      console.log(`[alerts] Alert ${alert.id} fired -> email sent to ${emailAddr}`);
    } catch(e) {
      console.error(`[alerts] Email failed for alert ${alert.id}:`, e.message);
    }

    // Also send web push if user has subscriptions
    if (webpush && VAPID_PUBLIC) {
      try {
        const subs = await q('SELECT * FROM push_subscriptions WHERE user_id=$1', [alert.user_id]);
        const pushPayload = JSON.stringify({
          title: `MyAurum Alert — ${alert.metal === 'gold' ? 'Gold' : 'Silver'} ${alert.direction === 'above' ? '↑' : '↓'}`,
          body: text.split('\n').slice(2, 3).join(''),
          url: APP_URL,
        });
        for (const sub of subs.rows) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              pushPayload
            );
          } catch(pushErr) {
            if (pushErr.statusCode === 410) {
              // Subscription expired — clean up
              await q('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
            }
          }
        }
      } catch(e) { console.warn(`[alerts] Push failed for alert ${alert.id}:`, e.message); }
    }
  }
}

// ─────────────────────────────────────────
//  ROUTES — PASSWORD RESET
// ─────────────────────────────────────────
app.post('/api/auth/forgot-password', forgotLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const user = result.rows[0];
    if (!user) { console.log('[reset] No user found for:', email); return res.json({ ok: true }); }
    console.log('[reset] Sending reset email to:', user.email);
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await q('UPDATE password_reset_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [user.id]);
    await q('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [user.id, token, expires]);
    const resetUrl = `${APP_URL}/?reset=${token}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your MyAurum password',
      html: `
        <div style="font-family:monospace;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px">
          <div style="font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:4px">MYAURUM</div>
          <div style="font-size:10px;color:#999;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">Precious Metals Ledger</div>
          <p style="color:#2C2410;font-size:14px;line-height:1.8">Hi ${user.first_name},</p>
          <p style="color:#555;font-size:13px;line-height:1.8">We received a request to reset your password. Click the button below — the link expires in 1 hour.</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${resetUrl}" style="background:linear-gradient(135deg,#B8860B,#D4A017);color:#fff;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:12px;letter-spacing:0.1em;font-weight:500">Reset My Password →</a>
          </div>
          <p style="color:#AAA;font-size:10px;line-height:1.7">If you didn't request this, ignore this email — your password won't change.<br>Link: ${resetUrl}</p>
        </div>`,
    });
    res.json({ ok: true });
  } catch(e) { console.error('[reset] forgot-password error:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const result = await q('SELECT * FROM password_reset_tokens WHERE token=$1 AND used=FALSE AND expires_at > NOW()', [token]);
    const resetToken = result.rows[0];
    if (!resetToken) return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    const hash = await bcrypt.hash(password, 12);
    await q('UPDATE users SET password=$1, updated_at=NOW() WHERE id=$2', [hash, resetToken.user_id]);
    await q('UPDATE password_reset_tokens SET used=TRUE WHERE id=$1', [resetToken.id]);
    res.json({ ok: true });
  } catch(e) { console.error('[reset] reset-password error:', e); res.status(500).json({ error: 'Server error' }); }
});

// PRICES
app.get('/api/prices', async (req, res) => {
  try {
    const r = await q('SELECT fetched_at FROM price_cache WHERE id=1');
    res.json({ gold:priceCache.gold, silver:priceCache.silver, platinum:priceCache.platinum,
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
  const { metal, dir, price, priceDisplay, priceCurrency, note, notifyEmail, clientId } = req.body;
  if (!metal||!dir||!price) return res.status(400).json({ error:'Missing required fields' });
  try {
    const r = await q(
      `INSERT INTO alerts (user_id,client_id,metal,direction,price,price_display,price_currency,notify_email,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.userId, clientId||null, metal, dir, price,
       priceDisplay||null, priceCurrency||'USD', notifyEmail||null, note||null]
    );
    res.status(201).json(alertToClient(r.rows[0]));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.patch('/api/alerts/:id/fired', requireAuth, async (req, res) => {
  try {
    const r = await q(
      'UPDATE alerts SET fired=TRUE WHERE id=$1 AND user_id=$2 AND fired=FALSE RETURNING *',
      [req.params.id, req.user.userId]
    );
    res.json({ ok:true });
    // Send email in background if alert was newly fired
    if (r.rowCount > 0) {
      setImmediate(async () => {
        try {
          const alert = r.rows[0];
          const userR = await q('SELECT email FROM users WHERE id=$1', [alert.user_id]);
          const emailAddr = alert.notify_email || (userR.rows[0] && userR.rows[0].email);
          if (!emailAddr) return;
          const spot = alert.metal === 'gold' ? priceCache.gold : alert.metal === 'platinum' ? priceCache.platinum : priceCache.silver;
          const { subject, html, text } = buildAlertEmail(alert, spot);
          await sendEmail({ to: emailAddr, subject, html, text });
          console.log(`[alerts] Client-fired alert ${alert.id} -> email sent to ${emailAddr}`);
        } catch(e) { console.error(`[alerts] Email failed for client-fired alert ${req.params.id}:`, e.message); }
      });
    }
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/alerts/:id', requireAuth, async (req, res) => {
  try {
    const r = await q('DELETE FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (r.rowCount === 0) return res.status(404).json({ error:'Alert not found' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});


// ─────────────────────────────────────────
//  EMAIL VERIFICATION
// ─────────────────────────────────────────
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const result = await q('SELECT * FROM email_verify_tokens WHERE token=$1 AND used=FALSE AND expires_at > NOW()', [token]);
    const row = result.rows[0];
    if (!row) return res.status(400).json({ error: 'Verification link is invalid or has expired' });
    await q('UPDATE users SET email_verified=TRUE WHERE id=$1', [row.user_id]);
    await q('UPDATE email_verify_tokens SET used=TRUE WHERE id=$1', [row.id]);
    res.json({ ok: true });
  } catch(e) { console.error('[verify]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/resend-verification', authLimiter, requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.email_verified) return res.json({ ok: true, alreadyVerified: true });
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await q('UPDATE email_verify_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [u.id]);
    await q('INSERT INTO email_verify_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [u.id, token, expires]);
    const verifyUrl = `${APP_URL}/?verify=${token}`;
    await sendEmail({
      to: u.email,
      subject: 'Verify your MyAurum email address',
      html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px">
        <div style="font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:20px">MYAURUM</div>
        <p style="color:#555;font-size:13px;line-height:1.8">Click below to verify your email address for your MyAurum account.</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${verifyUrl}" style="background:linear-gradient(135deg,#B8860B,#D4A017);color:#fff;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:12px;font-weight:500">Verify My Email →</a>
        </div>
        <p style="color:#AAA;font-size:10px">This link expires in 24 hours.</p>
      </div>`,
    });
    res.json({ ok: true });
  } catch(e) { console.error('[verify resend]', e); res.status(500).json({ error: 'Server error' }); }
});

// Resend verification by email — no auth required
app.post('/api/auth/resend-verification-by-email', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const r = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const u = r.rows[0];
    if (!u || u.email_verified) return res.json({ ok: true });
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await q('UPDATE email_verify_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [u.id]);
    await q('INSERT INTO email_verify_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [u.id, token, expires]);
    const verifyUrl = APP_URL + '/?verify=' + token;
    await sendEmail({
      to: u.email,
      subject: 'Verify your MyAurum email address',
      html: '<div style="font-family:monospace;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px"><div style="font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:20px">MYAURUM</div><p style="color:#555;font-size:13px;line-height:1.8">Click below to verify your email address.</p><div style="text-align:center;margin:28px 0"><a href="' + verifyUrl + '" style="background:linear-gradient(135deg,#B8860B,#D4A017);color:#fff;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:12px;font-weight:500">Verify My Email →</a></div><p style="color:#AAA;font-size:10px">This link expires in 24 hours.</p></div>',
    });
    console.log('[verify] Resent to:', u.email);
    res.json({ ok: true });
  } catch(e) { console.error('[verify resend by email]', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────
//  GOOGLE OAUTH
// ─────────────────────────────────────────

// Verify Google ID token by calling Google's tokeninfo endpoint
async function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/tokeninfo?id_token=' + idToken,
      method: 'GET',
      timeout: 8000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) return reject(new Error(payload.error));
          if (payload.aud !== GOOGLE_CLIENT_ID) return reject(new Error('Token audience mismatch'));
          resolve(payload);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Google token verification timed out')); });
    req.end();
  });
}

app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
  try {
    const payload = await verifyGoogleToken(credential);
    const { email, given_name, family_name, name, sub: googleId } = payload;
    if (!email) return res.status(400).json({ error: 'No email in Google token' });

    // Check if user exists
    let r = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.toLowerCase()]);
    let u = r.rows[0];
    let isNewUser = false;

    if (!u) {
      // Create new user — Google-verified so email is pre-verified
      isNewUser = true;
      const firstName = given_name || name?.split(' ')[0] || 'User';
      const lastName  = family_name || name?.split(' ').slice(1).join(' ') || '';
      const fakeHash  = await bcrypt.hash(googleId + JWT_SECRET, 10); // unusable password
      const ins = await q(
        'INSERT INTO users (email, password, first_name, last_name, email_verified) VALUES ($1,$2,$3,$4,TRUE) RETURNING *',
        [email.toLowerCase(), fakeHash, firstName, lastName]
      );
      u = ins.rows[0];
      console.log('[google] New user created:', email);
    } else if (!u.email_verified) {
      // Mark existing unverified user as verified since Google confirmed the email
      await q('UPDATE users SET email_verified=TRUE WHERE id=$1', [u.id]);
      u.email_verified = true;
      console.log('[google] Existing user verified via Google:', email);
    }

    const token = jwt.sign({ userId: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
    await q('UPDATE users SET last_seen=NOW(), auth_method=$2 WHERE id=$1', [u.id, 'google']);
    res.json({ token, isNewUser, user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, age: u.age, country: u.country, joinedAt: u.created_at, emailVerified: true } });
  } catch(e) {
    console.error('[google] Auth error:', e.message);
    res.status(401).json({ error: 'Google sign-in failed: ' + e.message });
  }
});

// ─────────────────────────────────────────
//  PRICE HISTORY
// ─────────────────────────────────────────
app.get('/api/prices/history', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const r = await q(
      `SELECT gold, silver, recorded_at FROM price_history
       WHERE recorded_at > NOW() - ($1 || ' days')::INTERVAL
       ORDER BY recorded_at ASC`,
      [days]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────
//  WEB PUSH SUBSCRIPTIONS
// ─────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(404).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription object' });
  if (!VAPID_PUBLIC) return res.status(404).json({ error: 'Push not configured' });
  try {
    await q(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh=$3, auth=$4`,
      [req.user.userId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  try {
    await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.userId, endpoint]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────
//  SENTRY + GENERIC ERROR HANDLER
// ─────────────────────────────────────────
if (Sentry) app.use(Sentry.Handlers.errorHandler());
app.use((err, req, res, next) => {
  console.error("[server] Unhandled:", err.message);
  if (Sentry) Sentry.captureException(err);
  res.status(500).json({ error: "Server error" });
});

// FRONTEND
app.get('/google3d8a4672088919f7.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send('google-site-verification: google3d8a4672088919f7.html');
});

app.get('/privacy', (req, res) => {
  const p = path.join(__dirname, 'privacy.html');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(p); }
  else res.status(404).send('Not found');
});

app.get('/terms', (req, res) => {
  const termsPath = path.join(__dirname, 'terms.html');
  if (fs.existsSync(termsPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(termsPath); }
  else res.status(404).send('Terms not found');
});

app.get('/terms', (req, res) => {
  const termsPath = path.join(__dirname, 'terms.html');
  if (fs.existsSync(termsPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(termsPath); }
  else res.status(404).send('Terms not found');
});

// ─────────────────────────────────────────
//  ADMIN DASHBOARD
// ─────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'myaurum_admin_2026';
const ADMIN_IP   = process.env.ADMIN_IP   || '103.156.212.177';
const ADMIN_SLUG = process.env.ADMIN_SLUG || 'dash-4f8a2e91c3b7';
const ADMIN_COOKIE = 'mya_adm';
const crypto = require('crypto');

function adminToken() {
  return crypto.createHmac('sha256', JWT_SECRET).update(ADMIN_PASS).digest('hex');
}

function getAdminCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(ADMIN_COOKIE + '='));
  return match ? match.slice(ADMIN_COOKIE.length + 1) : null;
}

function requireAdmin(req, res, next) {
  // Layer 1: IP whitelist
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip !== ADMIN_IP) return res.status(404).send('Not found');
  // Layer 2: signed cookie OR ?p= query param OR Authorization header
  const cookie = getAdminCookie(req);
  if (cookie && cookie === adminToken()) return next();
  const qp = req.query.p || '';
  if (qp === ADMIN_PASS) return next();
  const authHeader = req.headers['x-admin-token'] || '';
  if (authHeader === adminToken()) return next();
  // API routes get JSON 401, page routes get login form
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyAurum · Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,serif;background:#FAF7F2;display:flex;align-items:center;justify-content:center;height:100vh}
  .box{background:#fff;border:1px solid rgba(139,105,20,.2);border-radius:14px;padding:48px 40px;width:340px;text-align:center}
  h2{font-weight:300;letter-spacing:.18em;color:#8B6914;font-size:22px;margin-bottom:6px}
  p{font-family:monospace;font-size:11px;color:#aaa;letter-spacing:.08em;margin-bottom:32px}
  input{width:100%;padding:13px 16px;border:1px solid rgba(139,105,20,.25);border-radius:8px;font-size:14px;background:#FAF7F2;color:#2C2410;outline:none;font-family:monospace;letter-spacing:.05em}
  input:focus{border-color:#B8860B}
  button{width:100%;margin-top:14px;padding:13px;background:#8B6914;color:#FDF8F0;border:none;border-radius:8px;font-family:monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
  button:hover{opacity:.88}
  .err{color:#c0392b;font-size:12px;font-family:monospace;margin-top:12px;display:none}
</style></head>
<body><div class="box">
  <h2>MYAURUM</h2>
  <p>ADMIN ACCESS</p>
  <input type="password" id="pw" placeholder="Password" onkeydown="if(event.key==='Enter')login()"/>
  <button onclick="login()">Sign In →</button>
  <div class="err" id="err">Incorrect password</div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const res = await fetch('/dash-4f8a2e91c3b7/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({p: pw})
  });
  if (res.ok) { window.location.reload(); }
  else { document.getElementById('err').style.display='block'; }
}
</script></body></html>`);
}

// Admin login POST
app.post(`/${ADMIN_SLUG}/login`, (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip !== ADMIN_IP) return res.status(404).send('Not found');
  const { p } = req.body;
  if (p !== ADMIN_PASS) return res.status(401).json({ error: 'Incorrect password' });
  const token = adminToken();
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

// Admin logout
app.get(`/${ADMIN_SLUG}/logout`, (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed Out</title>
  <style>body{font-family:Georgia,serif;background:#FAF7F2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;color:#8B6914}.box h2{font-weight:300;letter-spacing:.15em;font-size:22px;margin-bottom:8px}
  .box p{font-family:monospace;font-size:12px;color:#aaa;letter-spacing:.08em}</style></head>
  <body><div class="box"><h2>MYAURUM</h2><p>You have been signed out.</p></div></body></html>`);
});

app.get('/signed-out', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed Out</title>
  <style>body{font-family:Georgia,serif;background:#FAF7F2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;color:#8B6914}.box h2{font-weight:300;letter-spacing:.15em;font-size:22px;margin-bottom:8px}
  .box p{font-family:monospace;font-size:12px;color:#aaa;letter-spacing:.08em}</style></head>
  <body><div class="box"><h2>MYAURUM</h2><p>You have been signed out.</p></div></body></html>`);
});

app.get(`/${ADMIN_SLUG}`, requireAdmin, (req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminPath)) {
    let html = fs.readFileSync(adminPath, 'utf8');
    // Inject token so API calls can authenticate without relying on cookies
    html = html.replace('</head>', `<script>window._adminToken="${adminToken()}";</script></head>`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '-1');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    res.type('html').send(html);
  } else res.status(404).send('Not found');
});

app.get(`/api/${ADMIN_SLUG}/stats`, requireAdmin, async (req, res) => {
  try {
    // Total users
    const totalUsers = await q('SELECT COUNT(*) FROM users');

    // Signups over time (last 30 days, by day)
    const signupsByDay = await q(`
      SELECT DATE(created_at) as day, COUNT(*) as count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `);

    // Auth method breakdown
    const authMethods = await q(`
      SELECT COALESCE(auth_method,'email') as method, COUNT(*) as count
      FROM users GROUP BY auth_method
    `);

    // Active users (seen in last 7 days)
    const activeWeek = await q(`SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '7 days'`);
    const activeMonth = await q(`SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '30 days'`);

    // Drop-off: registered but never seen again (last_seen is null or = created_at within 1 min)
    const dropoff = await q(`
      SELECT COUNT(*) FROM users
      WHERE last_seen IS NULL OR last_seen < created_at + INTERVAL '2 minutes'
    `);

    // Email verified vs not
    const verified = await q(`
      SELECT email_verified, COUNT(*) as count FROM users GROUP BY email_verified
    `);

    // Holdings breakdown (anonymised — no user IDs)
    const holdingsByMetal = await q(`
      SELECT metal, COUNT(*) as items, COUNT(DISTINCT user_id) as users,
             ROUND(SUM(grams)::numeric, 1) as total_grams
      FROM items WHERE sold=FALSE GROUP BY metal
    `);

    const holdingsByType = await q(`
      SELECT type, COUNT(*) as items, COUNT(DISTINCT user_id) as users
      FROM items WHERE sold=FALSE GROUP BY type
    `);

    // Avg items per active user
    const avgItems = await q(`
      SELECT ROUND(AVG(cnt)::numeric,1) as avg FROM (
        SELECT user_id, COUNT(*) as cnt FROM items WHERE sold=FALSE GROUP BY user_id
      ) sub
    `);

    // New signups this week vs last week
    const thisWeek = await q(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'`);
    const lastWeek = await q(`SELECT COUNT(*) FROM users WHERE created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'`);

    // Users with alerts set
    const withAlerts = await q(`SELECT COUNT(DISTINCT user_id) FROM alerts`);

    // Activation: users with 0 vs 1+ active holdings
    const withHoldings = await q(`SELECT COUNT(DISTINCT user_id) FROM items WHERE sold=FALSE`);
    const zeroHoldings = await q(`
      SELECT COUNT(*) FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM items i WHERE i.user_id = u.id AND i.sold=FALSE
      )
    `);
    const activatedUsers = parseInt(withHoldings.rows[0].count);
    const notActivatedUsers = parseInt(zeroHoldings.rows[0].count);
    const activationRate = (activatedUsers + notActivatedUsers) > 0
      ? Math.round(activatedUsers / (activatedUsers + notActivatedUsers) * 100) : 0;

    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count),
      signupsByDay: signupsByDay.rows,
      authMethods: authMethods.rows,
      activeWeek: parseInt(activeWeek.rows[0].count),
      activeMonth: parseInt(activeMonth.rows[0].count),
      dropoff: parseInt(dropoff.rows[0].count),
      verified: verified.rows,
      holdingsByMetal: holdingsByMetal.rows,
      holdingsByType: holdingsByType.rows,
      avgItemsPerUser: parseFloat(avgItems.rows[0].avg) || 0,
      thisWeek: parseInt(thisWeek.rows[0].count),
      lastWeek: parseInt(lastWeek.rows[0].count),
      withAlerts: parseInt(withAlerts.rows[0].count),
      activatedUsers,
      notActivatedUsers,
      activationRate,
    });
  } catch(e) {
    console.error('[admin]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
//  FAVICON
// ─────────────────────────────────────────
const FAVICON_192 = Buffer.from('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', 'base64');
const FAVICON_32  = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAGZklEQVR42m1WW29cZxVda58zF49nxnaci5sLcURUUlpog5D60CBIpTZV30DiIoTEGw88gJD4AQgq8YCExEW8cXlBlUJEq6pQlRIuKoW0ClHbGKJEcRpIxo1rx3bG4/HMnPPtxcN3ZjwJORqd+c7M+dbe376svbixfJkw0kAjSRpIwGgECIIA4u0+lwRAACQX4JAElwtyKQhKC4whukgyIQkg3sfhxtbxr/geBNAoUQiUgS4Y4BRS0ADQaExFsrBUQFMChHi/9yJIgCILLyWIkJvMlSsQZEpahBAFJjvoEuXFJt43Si6BIEXRMNwomJRDIgkwBUhLjInGffdASNAoUNK9J4jvSgJESSKsiK2YmNEVpGAxkcJOWOQ5h3gkJQ2fNPZB/H3otSjJ85FtgTG3KUmQsOKM8mCAqBhjdwdksbpAyEESJkhylyQaTZAIA9wDLREAM7gTTGMdMgZTTmlYmHS5GclyloV80CE9KTflecjatFJSqpdSkzJ3jzaAeF4HjfE55gAwEJTkTiKG3uVmFgI66//udy6m2Nq8vbS8uDA1VWOpOjGzrzK5r7LrifrMw2niwZ2kIJJyp1EEYIBsWNOENF4oZsxzrS+d3Vp5NQv1xWvbb/3+F4OcyxvJewt/Wllr9PKZztKZjZsvZjnNeHf7Re8RjbDoF3hM17BFyxu3/tZdu2CNZ2bmTlx56/l9j3z1ia+c/tSXfr7v2JfXrv529/yzNv357vJf77ReEatQ3A4ChA/7nzas78JqXFtS6m4uby29qurj88dO/PnF53YdOn7yi89Z2KDfOf7s90qzj735u+8cefhkXntm7cqvu+0lS8tFgTH6qGiiCJHuoQSWe+vvDHrZ3PyJztr118++tP/o06VUeR5CCJWS9sw//Y+/vLy5unjgI091OtpceoM2gbFe0bA17V52Kc6ZdlYu9fs22di1sXpztpEcOPxgGAwsKZmV8mwwd+jY/rldd9Za9ebsdlZba11kkg4jdNdlYyQ2rFfILBn0s+6dDwBYWjpyoEllkXmKnCk7fGAmScqQt9tbvbxkxjF4jmANupeQBRpDdeajq623+1urjZn53Xv3rt88z6QmD1CgVTdXFqZ2PzA5dbDXWXn/xpXm3HEqv9v9ITGh4BztMDAtzzpzR5+c2Pvx82d/0pjdv/fDp25d+PH6SqtSnS5XptZXbm7deGH64MnmnkOvv/LT3Yc/dvihJ7N+p+j2wt0CNh2NDZCxEwgLeT7ZaM5/4uu//P5ne33/5FPf2lp5e/GPXzvymR8FR/vqz5KpR/c8+LmXf/Xtl57/4Te++0K90dzuto1pUUZDPgbAzdv/Ac2sBMY/fehAXq1NXTz/2hu/+ebRo4eq00ez9Tfr9Xqv26Ulg/IjvXbr6rXWp7/wg0cfP9Xb2iDTISNahJJnknPz9nUigSU0K8YABIiAFCq15ubG7ZuX/zC4cyn30tag3KiGbGsFTGt7H/vQQ6emZnZvd9vGJAZh5L7c4UEIbK++ZzQwhVmkbElJksjdzKSQpCUmlRDgYVCpToSg4CFJUqMr9LNB3yx1d5qFEEgqNq07lLs8hSTIKMmBBASgTnu1XKnlgy7kACsTdQ+DtFRdu/XfJC2bWZ71K9Vmb7uTlqrueVqeyAa9Sm2KsWnlhByCZNGA4tSUu8QkvfavswvnTrfXWu/fuPhB65JL7547M+hvt65d6G6ub6y23v376c7m6tL1f3Y7a+sr1xfOnVlceI00AZIXmBIgK57lkBDX7o3pBwBM1GebMwcn6rO9brtSm+q0VyuT0wJKlcnyRDMtTaSlmqDG9P60VC5XG3EvxgDlzo3ly2RCS0kSRtJjLySphywOP0hmiRc7ZVbUu+Qjcgx5HocKIMklwXNXsKE1V9RMwxHh7rQUMHggIc8iRZgRECkpB5w0xiSTNo4ujw6lggiXooywUR8iipGROAKLPimmaUHCMXmIAkcxsdFdB1xQWhQPBDmtYHSCpEEBICIBcIzeC3ZMwAK60I6REeRyF1yC5Gk8i9FAgyegSBNMCCykRzE/hPspyZ0iROF4VKUxREAKCC4lxqgM5FFIgRa/OEbjhYmRxZEgk6DodQyBSQ53GlO5A4C7K4sSGKLoFKN6E2L3/L90HJnQzj0uYtFDcqWFPkQUfzHPo8FS5KN4ZUehFtDFSjuLGANJHL70P3HgSujg04XgAAAAAElFTkSuQmCC', 'base64');

app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_32);
});

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_192);
});

app.get('/apple-touch-icon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_192);
});

// ─────────────────────────────────────────
//  SITEMAP
// ─────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://myaurum.app';
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/terms</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${base}/privacy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(xml);
});

// Ping Google Search Console on startup (non-blocking)
function pingGoogleSitemap() {
  const url = 'https://www.google.com/ping?sitemap=https%3A%2F%2Fmyaurum.app%2Fsitemap.xml';
  https.get(url, (r) => {
    console.log(`[sitemap] Google ping: ${r.statusCode}`);
  }).on('error', (e) => {
    console.log(`[sitemap] Google ping failed: ${e.message}`);
  });
}
setTimeout(pingGoogleSitemap, 5000); // 5s after startup

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(indexPath); }
  else res.status(200).send('<h2>MyAurum backend running ✓</h2>');
});

app.get('/health', (req, res) => res.json({ ok:true, uptime:process.uptime() }));

// START
initDB()
  .then(() => q('SELECT * FROM price_cache WHERE id=1'))
  .then(r => {
    if (r.rows[0]) priceCache = r.rows[0];
    cron.schedule('*/5 * * * *', refreshPrices);

    // Daily cleanup — expired tokens
    cron.schedule('0 3 * * *', async () => {
      try {
        const r1 = await q("DELETE FROM password_reset_tokens WHERE expires_at < NOW()");
        const r2 = await q("DELETE FROM email_verify_tokens WHERE expires_at < NOW()");
        console.log(`[cleanup] Deleted ${r1.rowCount} reset tokens, ${r2.rowCount} verify tokens`);
      } catch(e) { console.error('[cleanup] Token cleanup failed:', e.message); }
    });
    refreshPrices().catch(console.error);
    app.listen(PORT, () => console.log(`\n🏛  MyAurum running on port ${PORT} (PostgreSQL)\n`));
  })
  .catch(err => { console.error('[fatal] DB init failed:', err); process.exit(1); });
