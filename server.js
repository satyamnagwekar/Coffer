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

  // Primary: gold-api.com — free, no key, no rate limit
  try {
    const [gData, sData] = await Promise.all([
      fetchJSON('https://api.gold-api.com/price/XAU'),
      fetchJSON('https://api.gold-api.com/price/XAG'),
    ]);
    if (gData?.price > 1000) { gold = gData.price; pricesFetched = true; console.log(`[prices] gold-api.com Gold: $${gold}`); }
    if (sData?.price > 0) { silver = sData.price; console.log(`[prices] gold-api.com Silver: $${silver}`); }
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

  priceCache = { gold, silver, usd_inr, usd_aed, usd_eur, usd_gbp };
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
    const spot = alert.metal === 'gold' ? priceCache.gold : priceCache.silver;
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
          const spot = alert.metal === 'gold' ? priceCache.gold : priceCache.silver;
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

function requireAdmin(req, res, next) {
  // Layer 1: IP whitelist
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip !== ADMIN_IP) return res.status(404).send('Not found');

  // Layer 2: password query param — wrong or missing = 404 (no hint it's protected)
  if (req.query.p !== ADMIN_PASS) return res.status(404).send('Not found');

  next();
}

app.get(`/${ADMIN_SLUG}`, requireAdmin, (req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(adminPath);
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
    });
  } catch(e) {
    console.error('[admin]', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
