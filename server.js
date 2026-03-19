'use strict'; // v6 - welcome email, removed login verify gate
// build: 2026-03-19
console.log('[env-debug]', Object.keys(process.env).filter(k => k.includes('ENCRYPT') || k.includes('DATABASE')));
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
const ENCRYPT_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : (() => { console.warn('[security] ENCRYPTION_KEY not set — using derived fallback. Set this in Railway variables.'); return require('crypto').scryptSync(JWT_SECRET, 'myaurum-salt-v1', 32); })();
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

  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS price_display  REAL`);
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS price_currency TEXT DEFAULT 'USD'`);
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_email   TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_method TEXT DEFAULT 'email'`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_opt_out BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_sent_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE`);

  // Items table — columns added after initial schema
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS held_by TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS nominee TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS making_charge REAL`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS making_charge_currency TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gold_cost_basis_usd REAL`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS photos TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gifted BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gifted_to TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gifted_at TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gift_notes TEXT`);
  await q(`ALTER TABLE items DROP CONSTRAINT IF EXISTS items_metal_check`);
  await q(`ALTER TABLE items ADD CONSTRAINT items_metal_check CHECK (metal IN ('gold','silver','platinum'))`);

  await q(`
    CREATE TABLE IF NOT EXISTS otp_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code       TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  try {
    await q('INSERT INTO price_history (gold, silver) VALUES ($1, $2)', [gold, silver]);
    await q("DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '90 days'");
  } catch(e) { console.warn('[history] Could not record price snapshot:', e.message); }

  checkAndFireAlerts().catch(e => console.error('[alerts] checkAndFireAlerts error:', e.message));
}

// ─────────────────────────────────────────
//  RATE LIMITERS
// ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts — please wait 15 minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset requests — please wait an hour and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
app.set('trust proxy', 1);
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
    sellPriceUSD:r.sell_price_usd, sellDate:r.sell_date||'', sellNotes:r.sell_notes||'', addedAt:r.added_at,
    heldBy:r.held_by||'', nominee:r.nominee||'', makingCharge:r.making_charge||null,
    makingChargeCurrency:r.making_charge_currency||null, goldCostBasisUSD:r.gold_cost_basis_usd||null,
    gifted:!!r.gifted, giftedTo:r.gifted_to||'', giftedAt:r.gifted_at||'', photos:r.photos||null };
}

// ─────────────────────────────────────────
//  FIELD-LEVEL ENCRYPTION (AES-256-GCM)
// ─────────────────────────────────────────
const crypto = require('crypto');
const ENC_PREFIX = 'enc:v1:';

function encryptField(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith(ENC_PREFIX)) return text; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptField(text) {
  if (!text || typeof text !== 'string') return text;
  if (!text.startsWith(ENC_PREFIX)) return text; // plaintext legacy value
  try {
    const buf = Buffer.from(text.slice(ENC_PREFIX.length), 'base64');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch(e) {
    console.error('[decrypt] Failed to decrypt field:', e.message);
    return text; // return as-is rather than crash
  }
}

// Encrypt sensitive fields before DB write
function encryptItem(payload) {
  return {
    ...payload,
    name:      payload.name      ? encryptField(payload.name)      : payload.name,
    notes:     payload.notes     ? encryptField(payload.notes)     : payload.notes,
    held_by:   payload.held_by   ? encryptField(payload.held_by)   : payload.held_by,
    nominee:   payload.nominee   ? encryptField(payload.nominee)   : payload.nominee,
    grade_name:payload.grade_name? encryptField(payload.grade_name): payload.grade_name,
    sell_notes:payload.sell_notes? encryptField(payload.sell_notes): payload.sell_notes,
  };
}

// Decrypt sensitive fields after DB read — update itemToClient to decrypt
function decryptRow(r) {
  return {
    ...r,
    name:       decryptField(r.name),
    notes:      decryptField(r.notes),
    held_by:    decryptField(r.held_by),
    nominee:    decryptField(r.nominee),
    grade_name: decryptField(r.grade_name),
    sell_notes: decryptField(r.sell_notes),
  };
}



function alertToClient(r) {
  return { id:r.id, clientId:r.client_id, metal:r.metal, dir:r.direction, price:r.price,
    priceDisplay:r.price_display||null, priceCurrency:r.price_currency||'USD',
    note:r.note||'', fired:!!r.fired, createdAt:r.created_at };
}

// ─────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, firstName, lastName, age, country } = req.body;
  if (!email||!password||!firstName||!lastName) return res.status(400).json({ error:'Missing required fields' });
  if (password.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' });
  if (!email.includes('@')) return res.status(400).json({ error:'Invalid email address' });
  try {
    const exists = await q('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    if (exists.rows.length) return res.status(409).json({ error:'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 12);
    // New users are pre-verified — no email gate on login
    const r = await q(`INSERT INTO users (email,password,first_name,last_name,age,country,email_verified) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
      [email.toLowerCase().trim(), hash, firstName.trim(), lastName.trim(), age||null, country||null]);
    const u = r.rows[0];
    const token = jwt.sign({ userId:u.id, email:u.email }, JWT_SECRET, { expiresIn:'30d' });
    // Respond immediately
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:true } });
    // Send welcome email in background
    setImmediate(async () => {
      try {
        await sendWelcomeEmail(u.email, u.first_name);
        console.log('[welcome] Email sent to:', u.email);
      } catch(e) { console.error('[welcome] Could not send welcome email:', e.message); }
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
    // Auto-verify any legacy unverified users on login — no gate
    if (!u.email_verified) {
      await q('UPDATE users SET email_verified=TRUE WHERE id=$1', [u.id]);
    }
    // 2FA check — if enabled, send OTP and return challenge
    if (u.two_factor_enabled) {
      const crypto = require('crypto');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await q('UPDATE otp_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [u.id]);
      await q('INSERT INTO otp_tokens (user_id, code, expires_at) VALUES ($1,$2,$3)', [u.id, code, expires]);
      setImmediate(async () => {
        try {
          await sendEmail({
            to: u.email,
            subject: 'Your MyAurum login code',
            html: `<div style="font-family:monospace;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px">
              <div style="font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:20px">MYAURUM</div>
              <p style="color:#2C2410;font-size:14px;line-height:1.8">Hi ${u.first_name},</p>
              <p style="color:#555;font-size:13px;line-height:1.8">Your login verification code is:</p>
              <div style="text-align:center;margin:28px 0">
                <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:600;letter-spacing:0.3em;color:#B8860B;background:#F5EDD8;padding:20px 32px;border-radius:10px;display:inline-block">${code}</div>
              </div>
              <p style="color:#AAA;font-size:11px;line-height:1.7">This code expires in 10 minutes. If you did not attempt to sign in, ignore this email.</p>
            </div>`,
            text: `Your MyAurum login code: ${code}\n\nExpires in 10 minutes.`,
          });
        } catch(e) { console.error('[2fa] OTP email failed:', e.message); }
      });
      return res.json({ requires2FA: true, userId: u.id });
    }
    await q('UPDATE users SET last_seen=NOW(), auth_method=$2 WHERE id=$1', [u.id, 'email']);
    const token = jwt.sign({ userId:u.id, email:u.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:true } });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// OTP verification — second step of 2FA login
app.post('/api/auth/verify-otp', authLimiter, async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await q(
      'SELECT * FROM otp_tokens WHERE user_id=$1 AND code=$2 AND used=FALSE AND expires_at > NOW()',
      [userId, code.trim()]
    );
    const otp = r.rows[0];
    if (!otp) return res.status(401).json({ error: 'Invalid or expired code' });
    await q('UPDATE otp_tokens SET used=TRUE WHERE id=$1', [otp.id]);
    const ur = await q('SELECT * FROM users WHERE id=$1', [userId]);
    const u = ur.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    await q('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]);
    const token = jwt.sign({ userId: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:true } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Enable 2FA
app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (!u.email_verified) return res.status(403).json({ error: 'Please verify your email before enabling two-factor authentication' });
    await q('UPDATE users SET two_factor_enabled=TRUE WHERE id=$1', [u.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Disable 2FA
app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  try {
    await q('UPDATE users SET two_factor_enabled=FALSE WHERE id=$1', [req.user.userId]);
    await q('UPDATE otp_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [req.user.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});


app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });
    await q('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]);
    res.json({ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, joinedAt:u.created_at, emailVerified:!!u.email_verified, twoFactorEnabled:!!u.two_factor_enabled });
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
//  EMAIL HELPER
// ─────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: process.env.RESEND_FROM || 'Satyam from MyAurum <satyam@mail.myaurum.app>',
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
//  WELCOME EMAIL
// ─────────────────────────────────────────
async function sendWelcomeEmail(email, firstName) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px">
  <tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
    <p style="margin:6px 0 0;font-size:10px;color:#907030;letter-spacing:.2em;text-transform:uppercase">Precious Metals Ledger</p>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:36px 40px;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <p style="margin:0 0 20px;font-size:15px;color:#2C2410;line-height:1.7;font-family:Arial,sans-serif">Hi ${firstName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85;font-family:Arial,sans-serif">Indian families hold more physical gold than any other community on earth. Jewellery bought over decades. Coins received as gifts. Bars passed down from parents. All of it sitting in lockers and drawers, often without a clear record of what it is or what it is worth today.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85;font-family:Arial,sans-serif">And it travels. To Dubai, to London, to Toronto, to Sydney. The gold moves with the family. The documentation rarely does.</p>
    <p style="margin:0 0 24px;font-size:14px;color:#4a3a1a;line-height:1.85;font-family:Arial,sans-serif">That is the gap MyAurum fills. Not because tracking live prices is exciting, but because one day, when you are settling an estate, writing a will, or simply trying to answer your children's questions, you will want a record that actually exists.</p>
    <table role="presentation" width="100%" style="background:#FDF5E0;border:1px solid #E8D8A0;border-radius:10px;margin:0 0 28px">
      <tr><td style="padding:20px 24px">
        <p style="margin:0 0 8px;font-size:11px;color:#8B6914;letter-spacing:.1em;text-transform:uppercase;font-weight:600;font-family:Arial,sans-serif">One thing to do today</p>
        <p style="margin:0;font-size:14px;color:#2C2410;line-height:1.7;font-family:Arial,sans-serif">Add a single holding. One piece of jewellery, one coin, one bar. It takes about 30 seconds and you will immediately see what it is worth at today's price, in your currency.</p>
      </td></tr>
    </table>
    <div style="text-align:center;margin:0 0 28px">
      <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 36px;border-radius:8px;font-weight:600;font-family:Arial,sans-serif">Add Your First Holding &rarr;</a>
    </div>
    <p style="margin:0 0 8px;font-size:13px;color:#4a3a1a;line-height:1.7;font-family:Arial,sans-serif">Once you have done that, the rest builds naturally.</p>
    <p style="margin:0 0 24px;font-size:13px;color:#4a3a1a;line-height:1.7;font-family:Arial,sans-serif">One more thing — if you would like to understand exactly how we protect your data, including your precious holdings, we have written a plain-English explanation of every security measure in place. No jargon, no vague assurances. <a href="${APP_URL}/security" style="color:#B8860B;text-decoration:none;font-weight:500">Read it here →</a></p>
    <p style="margin:0 0 24px;font-size:13px;color:#4a3a1a;line-height:1.7;font-family:Arial,sans-serif">If something is unclear or not working the way you expect, just reply to this email. I read every one.</p>
    <p style="margin:0 0 2px;font-size:13px;color:#2C2410;font-weight:600;font-family:Arial,sans-serif">Satyam</p>
    <p style="margin:0;font-size:12px;color:#8B6914;font-family:Arial,sans-serif">Founder, MyAurum</p>
  </td></tr>
  <tr><td style="background:#F0EBE0;padding:16px 40px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px">
    <p style="margin:0 0 6px;font-size:10px;color:#AAA;line-height:1.85;font-family:Arial,sans-serif">MyAurum is free up to 25 holdings. No credit card, no catch. &nbsp;·&nbsp; <a href="${APP_URL}" style="color:#B8860B;text-decoration:none">myaurum.app</a></p>
    <p style="margin:0;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">&copy; 2026 MyAurum. All rights reserved. &nbsp;·&nbsp; Registered in India &nbsp;·&nbsp; <a href="${APP_URL}/privacy" style="color:#B8860B;text-decoration:none">Privacy Policy</a></p>
    <p style="margin:6px 0 0;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">MyAurum is a personal record tool, not a financial product. Values shown are indicative estimates based on live spot prices and do not constitute financial advice.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    `Hi ${firstName},`,
    '',
    'Indian families hold more physical gold than any other community on earth. Jewellery bought over decades. Coins received as gifts. Bars passed down from parents. All of it sitting in lockers and drawers, often without a clear record of what it is or what it is worth today.',
    '',
    'And it travels. To Dubai, to London, to Toronto, to Sydney. The gold moves with the family. The documentation rarely does.',
    '',
    'That is the gap MyAurum fills. Not because tracking live prices is exciting, but because one day, when you are settling an estate, writing a will, or simply trying to answer your children\'s questions, you will want a record that actually exists.',
    '',
    'One thing to do today: add a single holding. One piece of jewellery, one coin, one bar. It takes about 30 seconds and you will immediately see what it is worth at today\'s price, in your currency.',
    '',
    APP_URL,
    '',
    'Once you have done that, the rest builds naturally.',
    '',
    `One more thing — if you would like to understand exactly how we protect your data, we have written a plain-English explanation of every security measure in place. No jargon, no vague assurances.\n${APP_URL}/security`,
    '',
    'If something is unclear or not working the way you expect, just reply to this email. I read every one.',
    '',
    'Satyam',
    'Founder, MyAurum',
    '',
    'MyAurum is free up to 25 holdings. No credit card, no catch.',
  ].join('\n');

  return sendEmail({
    to: email,
    subject: 'Your gold needs a record',
    html,
    text,
  });
}

// Route for frontend send-welcome call (belt-and-suspenders)
app.post('/api/auth/send-welcome', authLimiter, async (req, res) => {
  const { email, firstName } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    await sendWelcomeEmail(email, firstName || 'there');
    res.json({ ok: true });
  } catch(e) {
    console.error('[welcome] Route error:', e.message);
    res.status(500).json({ error: 'Could not send email' });
  }
});

// ─────────────────────────────────────────
//  20-HOLDINGS MILESTONE EMAIL
// ─────────────────────────────────────────
app.post('/api/auth/milestone-20', requireAuth, async (req, res) => {
  // Respond immediately — don't block on email
  res.json({ ok: true });
  setImmediate(async () => {
    try {
      const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
      const u = r.rows[0];
      if (!u) return;

      // Only send once — check if already sent
      const already = await q(
        "SELECT 1 FROM email_verify_tokens WHERE user_id=$1 AND used=FALSE AND expires_at > NOW()",
        [u.id]
      );
      // If they already have a pending verify token, don't spam
      // But we still want to send if email_verified is false OR if never sent milestone
      // Use a simple approach: check for a milestone marker in the token notes column
      // Easier: just always send but check a flag on the user — add column if needed
      // Simplest: send if not already email_verified (they need the link)
      // If already verified, send without the verify link

      const crypto = require('crypto');
      let verifyUrl = null;

      if (!u.email_verified) {
        // Invalidate old tokens, issue fresh one
        await q('UPDATE email_verify_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE', [u.id]);
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await q('INSERT INTO email_verify_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [u.id, token, expires]);
        verifyUrl = `${APP_URL}/?verify=${token}`;
      }

      await sendMilestone20Email(u.email, u.first_name, verifyUrl);
      console.log('[milestone-20] Email sent to:', u.email);
    } catch(e) {
      console.error('[milestone-20] Error:', e.message);
    }
  });
});

async function sendMilestone20Email(email, firstName, verifyUrl) {
  const ctaBlock = verifyUrl
    ? `<div style="text-align:center;margin:28px 0">
        <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 36px;border-radius:8px;font-weight:600">Confirm my email address &rarr;</a>
       </div>
       <p style="margin:0 0 8px;font-size:11px;color:#AAA;text-align:center;line-height:1.7">This link is valid for 7 days.</p>`
    : `<div style="text-align:center;margin:28px 0">
        <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 36px;border-radius:8px;font-weight:600">Open MyAurum &rarr;</a>
       </div>`;

  const premiumLine = verifyUrl
    ? `<p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85">The other is to know that MyAurum premium is coming. For those who want to go further — unlimited holdings, advanced succession tools, priority support — we are building it. You will hear from me first.</p>`
    : `<p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85">MyAurum premium is coming. For those who want to go further — unlimited holdings, advanced succession tools, priority support — we are building it. You will hear from me first.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px">
  <tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
    <p style="margin:6px 0 0;font-size:10px;color:#907030;letter-spacing:.2em;text-transform:uppercase">Precious Metals Ledger</p>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:36px 40px;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <p style="margin:0 0 20px;font-size:15px;color:#2C2410;line-height:1.7">Hi ${firstName},</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85">You have been building something worth keeping.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85">Twenty holdings is not a casual tracker. It is a real record — weights, purities, purchase history, values across currencies. The kind of documentation most families never have.</p>
    <p style="margin:0 0 24px;font-size:14px;color:#4a3a1a;line-height:1.85">A couple of things worth doing now that your vault has grown:</p>
    ${verifyUrl ? `<p style="margin:0 0 16px;font-size:14px;color:#4a3a1a;line-height:1.85">One is to confirm your email address. It takes one click and ensures you never lose access to what you have built — especially important if you are documenting gold that belongs to the whole family.</p>` : ''}
    ${premiumLine}
    ${ctaBlock}
    <p style="margin:0;font-size:13px;color:#4a3a1a;line-height:1.7">If something is not working the way you expect, reply to this email. I read every one.</p>
  </td></tr>
  <tr><td style="background:#F0EBE0;padding:16px 40px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px">
    <p style="margin:0 0 6px;font-size:13px;color:#2C2410;font-weight:600;font-family:Arial,sans-serif">Satyam</p>
    <p style="margin:0 0 10px;font-size:12px;color:#8B6914;font-family:Arial,sans-serif">Founder, MyAurum</p>
    <p style="margin:0 0 4px;font-size:10px;color:#AAA;line-height:1.7;font-family:Arial,sans-serif">&copy; 2026 MyAurum. All rights reserved. &nbsp;&middot;&nbsp; Registered in India &nbsp;&middot;&nbsp; <a href="${APP_URL}/privacy" style="color:#B8860B;text-decoration:none">Privacy Policy</a></p>
    <p style="margin:0;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">MyAurum is a personal record tool, not a financial product. Values shown are indicative estimates based on live spot prices and do not constitute financial advice.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const verifyBlock = verifyUrl
    ? `\nOne is to confirm your email address. It takes one click and ensures you never lose access to what you have built.\n\n${verifyUrl}\n`
    : '';

  const text = [
    `Hi ${firstName},`,
    '',
    'You have been building something worth keeping.',
    '',
    'Twenty holdings is not a casual tracker. It is a real record — weights, purities, purchase history, values across currencies. The kind of documentation most families never have.',
    '',
    'A couple of things worth doing now that your vault has grown:',
    verifyBlock,
    'MyAurum premium is coming. For those who want to go further — unlimited holdings, advanced succession tools, priority support — we are building it. You will hear from me first.',
    '',
    'If something is not working the way you expect, reply to this email. I read every one.',
    '',
    'Satyam',
    'Founder, MyAurum',
  ].join('\n');

  return sendEmail({
    to: email,
    subject: 'Your vault is taking shape',
    html,
    text,
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
//  ALERT CHECKER
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

    try {
      await q('UPDATE alerts SET fired=TRUE WHERE id=$1', [alert.id]);
    } catch(e) {
      console.error(`[alerts] Could not mark alert ${alert.id} fired:`, e.message);
      continue;
    }

    const emailAddr = alert.notify_email || alert.user_email;
    console.log(`[alerts] Alert ${alert.id} fired spot:${spot} target:${alert.price} dir:${alert.direction||alert.dir} email:${emailAddr}`);
    if (!emailAddr) continue;

    const { subject, html, text } = buildAlertEmail(alert, spot);
    try {
      await sendEmail({ to: emailAddr, subject, html, text });
      console.log(`[alerts] Alert ${alert.id} fired -> email sent to ${emailAddr}`);
    } catch(e) {
      console.error(`[alerts] Email failed for alert ${alert.id}:`, e.message);
    }

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
              await q('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
            }
          }
        }
      } catch(e) { console.warn(`[alerts] Push failed for alert ${alert.id}:`, e.message); }
    }
  }
}

// ─────────────────────────────────────────
//  PASSWORD RESET
// ─────────────────────────────────────────
app.post('/api/auth/forgot-password', forgotLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.trim()]);
    const user = result.rows[0];
    if (!user) { console.log('[reset] No user found for:', email); return res.json({ ok: true }); }
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
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px">
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#B8860B;letter-spacing:0.2em;margin-bottom:4px">MYAURUM</div>
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

// ─────────────────────────────────────────
//  PRICES
// ─────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  try {
    const r = await q('SELECT fetched_at FROM price_cache WHERE id=1');
    res.json({ gold:priceCache.gold, silver:priceCache.silver, platinum:priceCache.platinum,
      rates:{ USD:1, INR:priceCache.usd_inr, AED:priceCache.usd_aed, EUR:priceCache.usd_eur, GBP:priceCache.usd_gbp },
      fetchedAt:r.rows[0]?.fetched_at });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// ─────────────────────────────────────────
//  ITEMS
// ─────────────────────────────────────────
app.get('/api/items', requireAuth, async (req, res) => {
  try { const r = await q('SELECT * FROM items WHERE user_id=$1 ORDER BY added_at DESC', [req.user.userId]); res.json(r.rows.map(row => itemToClient(decryptRow(row)))); }
  catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.post('/api/items', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const r = await q(`INSERT INTO items (user_id,client_id,name,metal,type,grade_name,purity,grams,notes,purchase_date,price_paid,price_paid_curr,price_paid_usd,receipt,added_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.userId, d.clientId||null,
       encryptField(d.name), d.metal, d.type, encryptField(d.gradeName), d.purity, d.grams,
       d.notes?encryptField(d.notes):null, d.purchaseDate||null,
       d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null,
       d.receipt||null, d.addedAt||new Date().toISOString()]);
    res.status(201).json(itemToClient(decryptRow(r.rows[0])));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const exists = await q('SELECT id FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (!exists.rows.length) return res.status(404).json({ error:'Item not found' });
    const r = await q(`UPDATE items SET name=$1,metal=$2,type=$3,grade_name=$4,purity=$5,grams=$6,notes=$7,purchase_date=$8,price_paid=$9,price_paid_curr=$10,price_paid_usd=$11,receipt=$12,sold=$13,sell_price=$14,sell_currency=$15,sell_price_usd=$16,sell_date=$17,sell_notes=$18,updated_at=NOW() WHERE id=$19 AND user_id=$20 RETURNING *`,
      [encryptField(d.name), d.metal, d.type, encryptField(d.gradeName), d.purity, d.grams,
       d.notes?encryptField(d.notes):null, d.purchaseDate||null,
       d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null, !!d.sold,
       d.sellPrice||null, d.sellCurrency||null, d.sellPriceUSD||null, d.sellDate||null,
       d.sellNotes?encryptField(d.sellNotes):null,
       req.params.id, req.user.userId]);
    res.json(itemToClient(decryptRow(r.rows[0])));
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
        [req.user.userId, d.clientId||null,
         encryptField(d.name), d.metal, d.type, encryptField(d.gradeName), d.purity, d.grams,
         d.notes?encryptField(d.notes):null, d.purchaseDate||null,
         d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null,
         !!d.sold, d.sellPrice||null, d.sellCurrency||null, d.sellPriceUSD||null, d.sellDate||null,
         d.sellNotes?encryptField(d.sellNotes):null, d.addedAt||new Date().toISOString()]);
    }
    const r = await q('SELECT * FROM items WHERE user_id=$1 ORDER BY added_at DESC', [req.user.userId]);
    res.json(r.rows.map(row => itemToClient(decryptRow(row))));
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// ─────────────────────────────────────────
//  ALERTS
// ─────────────────────────────────────────
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
//  EMAIL VERIFICATION (legacy — kept for old verify links)
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

// ─────────────────────────────────────────
//  GOOGLE OAUTH
// ─────────────────────────────────────────
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

    let r = await q('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email.toLowerCase()]);
    let u = r.rows[0];
    let isNewUser = false;

    if (!u) {
      isNewUser = true;
      const firstName = given_name || name?.split(' ')[0] || 'User';
      const lastName  = family_name || name?.split(' ').slice(1).join(' ') || '';
      const fakeHash  = await bcrypt.hash(googleId + JWT_SECRET, 10);
      const ins = await q(
        'INSERT INTO users (email, password, first_name, last_name, email_verified) VALUES ($1,$2,$3,$4,TRUE) RETURNING *',
        [email.toLowerCase(), fakeHash, firstName, lastName]
      );
      u = ins.rows[0];
      console.log('[google] New user created:', email);
      // Send welcome email for new Google signups too
      setImmediate(async () => {
        try {
          await sendWelcomeEmail(u.email, u.first_name);
          console.log('[welcome] Email sent to Google user:', u.email);
        } catch(e) { console.error('[welcome] Could not send welcome email:', e.message); }
      });
    } else if (!u.email_verified) {
      await q('UPDATE users SET email_verified=TRUE WHERE id=$1', [u.id]);
      u.email_verified = true;
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
//  WEEKLY EMAIL OPT-OUT
// ─────────────────────────────────────────
app.get('/api/auth/unsubscribe-weekly', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Invalid link.');
  try {
    // token is userId signed with JWT_SECRET
    const payload = require('jsonwebtoken').verify(token, JWT_SECRET);
    await q('UPDATE users SET weekly_email_opt_out=TRUE WHERE id=$1', [payload.userId]);
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribed</title>
    <style>body{font-family:Georgia,serif;background:#FAF7F2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;color:#8B6914;max-width:380px;padding:32px}
    h2{font-weight:300;letter-spacing:.15em;font-size:22px;margin-bottom:12px}
    p{font-family:Arial,sans-serif;font-size:13px;color:#aaa;line-height:1.7}</style></head>
    <body><div class="box"><h2>MYAURUM</h2>
    <p>You have been unsubscribed from weekly portfolio emails.</p>
    <p style="margin-top:16px"><a href="${APP_URL}" style="color:#B8860B;text-decoration:none">Return to MyAurum →</a></p>
    </div></body></html>`);
  } catch(e) {
    res.status(400).send('Link is invalid or has expired.');
  }
});

// ─────────────────────────────────────────
//  WEEKLY DIGEST EMAIL
// ─────────────────────────────────────────
const INDIA_FACTOR_WEEKLY = (10 / 31.1035) * 1.15 * 1.03;

function formatVal(val, isMCX, sym) {
  if (isMCX) return '₹' + Math.round(val).toLocaleString('en-IN');
  return sym + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sendWeeklyDigests() {
  console.log('[weekly] Starting weekly digest run…');
  const jwt = require('jsonwebtoken');

  // Get last Monday's price snapshot (7 days ago, closest record)
  let lastWeekPrices = null;
  try {
    const lw = await q(`
      SELECT gold, silver
      FROM price_history
      WHERE recorded_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '6 days'
      ORDER BY ABS(EXTRACT(EPOCH FROM (recorded_at - (NOW() - INTERVAL '7 days'))))
      LIMIT 1
    `);
    if (lw.rows[0]) lastWeekPrices = lw.rows[0];
  } catch(e) { console.warn('[weekly] Could not fetch last week prices:', e.message); }

  // Get all users with active holdings who haven't opted out
  const users = await q(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.country, u.weekly_email_opt_out
    FROM users u
    WHERE u.weekly_email_opt_out IS NOT TRUE
    AND EXISTS (
      SELECT 1 FROM items i WHERE i.user_id = u.id AND i.sold = FALSE AND i.gifted IS NOT TRUE
    )
  `);

  console.log(`[weekly] Sending to ${users.rows.length} users`);
  let sent = 0, skipped = 0;

  for (const user of users.rows) {
    try {
      // Get user's active items
      const itemsRes = await q(
        'SELECT * FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE)',
        [user.id]
      );
      const activeItems = itemsRes.rows;
      if (!activeItems.length) { skipped++; continue; }

      // Determine currency/benchmark from country
      const isIndia = (user.country || '').toLowerCase() === 'india';
      const isMCX = isIndia;
      const currency = isIndia ? 'INR' : 'USD';
      const sym = isIndia ? '₹' : '$';
      const bLabel = isIndia ? 'MCX' : 'COMEX';
      const rates = { INR: priceCache.usd_inr, AED: priceCache.usd_aed, EUR: priceCache.usd_eur, GBP: priceCache.usd_gbp, USD: 1 };

      // Compute per-metal values
      const metalData = {};
      for (const item of activeItems) {
        const m = item.metal;
        if (!metalData[m]) metalData[m] = { grams: 0, valueDisp: 0 };
        const oz = item.grams * item.purity / 31.1035;
        const spotUSD = m === 'gold' ? priceCache.gold : m === 'platinum' ? (priceCache.platinum||980) : priceCache.silver;
        let val;
        if (isMCX && m !== 'platinum') {
          val = oz * priceCache.gold * (m === 'gold' ? 1 : 0) * INDIA_FACTOR_WEEKLY * 31.1035 / 10;
          // Redo properly
          val = (item.grams * item.purity / 10) * (m === 'gold' ? priceCache.gold : priceCache.silver) * priceCache.usd_inr * 1.15 * 1.03;
        } else {
          val = oz * spotUSD * (rates[currency] || 1);
        }
        metalData[m].grams += item.grams;
        metalData[m].valueDisp += val;
      }

      const totalValue = Object.values(metalData).reduce((s, m) => s + m.valueDisp, 0);

      // Dominant metal
      const dominantMetal = Object.entries(metalData).sort((a,b) => b[1].valueDisp - a[1].valueDisp)[0][0];

      // Week-on-week portfolio change
      let changeVal = null, changePct = null;
      if (lastWeekPrices) {
        let lastTotal = 0;
        for (const item of activeItems) {
          const m = item.metal;
          const oz = item.grams * item.purity / 31.1035;
          const lastSpot = m === 'gold' ? lastWeekPrices.gold : lastWeekPrices.silver;
          let lastVal;
          if (isMCX && m !== 'platinum') {
            lastVal = (item.grams * item.purity / 10) * lastSpot * priceCache.usd_inr * 1.15 * 1.03;
          } else {
            lastVal = oz * lastSpot * (rates[currency] || 1);
          }
          lastTotal += lastVal;
        }
        if (lastTotal > 0) {
          changeVal = totalValue - lastTotal;
          changePct = (changeVal / lastTotal) * 100;
        }
      }

      // Metal spot change this week
      const metalSpotChange = {};
      if (lastWeekPrices) {
        metalSpotChange.gold = ((priceCache.gold - lastWeekPrices.gold) / lastWeekPrices.gold) * 100;
        metalSpotChange.silver = ((priceCache.silver - lastWeekPrices.silver) / lastWeekPrices.silver) * 100;
      }

      // Spot strings
      const goldSpotStr = isMCX
        ? `₹${Math.round(priceCache.gold * priceCache.usd_inr * INDIA_FACTOR_WEEKLY).toLocaleString('en-IN')}/10g (MCX)`
        : `$${priceCache.gold.toFixed(2)}/oz (COMEX)`;
      const silverSpotStr = isMCX
        ? `₹${Math.round(priceCache.silver * priceCache.usd_inr * INDIA_FACTOR_WEEKLY).toLocaleString('en-IN')}/10g (MCX)`
        : `$${priceCache.silver.toFixed(2)}/oz (COMEX)`;

      // Timestamp
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
      const timeStr = now.toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Asia/Kolkata' });
      const asOf = `${dateStr}, ${timeStr} IST`;

      // Subject
      let subject = 'Your vault this week';
      if (changePct !== null) {
        const sign = changePct >= 0 ? 'up' : 'down';
        subject = `Your vault this week — ${sign} ${Math.abs(changePct).toFixed(1)}%`;
      }

      // Unsubscribe token
      const unsubToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '90d' });
      const unsubUrl = `${APP_URL}/api/auth/unsubscribe-weekly?token=${unsubToken}`;

      // Build metal sections — dominant first
      const metalOrder = Object.keys(metalData).sort((a,b) =>
        metalData[b].valueDisp - metalData[a].valueDisp
      );

      const metalLabels = { gold: 'GOLD', silver: 'SILVER', platinum: 'PLATINUM' };
      const metalEmoji = { gold: '🥇', silver: '🥈', platinum: '⬜' };

      const metalSectionsHTML = metalOrder.map(m => {
        const d = metalData[m];
        const valStr = formatVal(d.valueDisp, isMCX, sym);
        const gramsStr = d.grams.toFixed(2) + 'g';
        const spotStr = m === 'gold' ? goldSpotStr : m === 'silver' ? silverSpotStr : '';
        const wkChange = metalSpotChange[m];
        const wkStr = wkChange !== undefined
          ? `<span style="color:${wkChange >= 0 ? '#2ECC8A' : '#E05C5C'}">${wkChange >= 0 ? '+' : ''}${wkChange.toFixed(1)}% this week</span>`
          : '';
        return `
          <tr><td colspan="2" style="padding:16px 0 6px">
            <span style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8B6914;font-family:Arial,sans-serif">${metalEmoji[m]} ${metalLabels[m] || m.toUpperCase()}</span>
          </td></tr>
          <tr>
            <td style="font-family:Georgia,serif;font-size:20px;font-weight:300;color:#2C2410;padding:0 0 4px">${valStr}</td>
            <td style="text-align:right;font-size:12px;color:#8B6914;padding:0 0 4px">${gramsStr}</td>
          </tr>
          ${spotStr ? `<tr><td colspan="2" style="font-size:11px;color:#999;padding:0 0 2px">Spot: ${spotStr} ${wkStr}</td></tr>` : ''}
        `;
      }).join('');

      const changeHTML = changePct !== null ? `
        <tr><td colspan="2" style="padding:4px 0 2px">
          <span style="font-size:13px;color:${changeVal >= 0 ? '#2ECC8A' : '#E05C5C'};font-family:Arial,sans-serif">
            ${changeVal >= 0 ? '+' : ''}${formatVal(Math.abs(changeVal), isMCX, sym)} &nbsp;
            (${changeVal >= 0 ? '+' : '−'}${Math.abs(changePct).toFixed(1)}% this week)
          </span>
        </td></tr>
      ` : `<tr><td colspan="2" style="padding:4px 0 2px;font-size:11px;color:#999;font-family:Arial,sans-serif">First snapshot — change data from next week</td></tr>`;

      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px">
  <tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
    <p style="margin:6px 0 0;font-size:10px;color:#907030;letter-spacing:.2em;text-transform:uppercase">Weekly Portfolio Update</p>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:28px 32px 8px;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <p style="margin:0 0 4px;font-size:11px;color:#999;font-family:Arial,sans-serif;letter-spacing:.04em">${asOf}</p>
    <p style="margin:0 0 20px;font-size:14px;color:#2C2410">Hi ${user.first_name},</p>
    <table role="presentation" width="100%" style="border:1px solid #E8E0D0;border-radius:10px;overflow:hidden;margin-bottom:24px">
      <tr style="background:#F5EDD0"><td colspan="2" style="padding:12px 16px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8B6914;font-family:Arial,sans-serif">Portfolio Total</td></tr>
      <tr style="background:#FDFAF5">
        <td style="padding:12px 16px;font-family:Georgia,serif;font-size:28px;font-weight:300;color:#2C2410">${formatVal(totalValue, isMCX, sym)}</td>
        <td style="padding:12px 16px;text-align:right"></td>
      </tr>
      <tr style="background:#FDFAF5"><td colspan="2" style="padding:0 16px 12px">${changeHTML.replace(/<tr>|<\/tr>/g,'').replace(/<td[^>]*>/g,'<span style="display:block">').replace(/<\/td>/g,'</span>')}</td></tr>
    </table>
    <table role="presentation" width="100%" style="border-collapse:collapse">
      ${metalSectionsHTML}
    </table>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:20px 32px 28px;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0;text-align:center">
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:14px 32px;border-radius:8px;font-weight:600">Open your vault &rarr;</a>
  </td></tr>
  <tr><td style="background:#F0EBE0;padding:18px 32px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px">
    <p style="margin:0 0 6px;font-size:10px;color:#BBB;line-height:1.85;font-family:Arial,sans-serif">
      Prices are indicative spot rates. MyAurum is a personal record tool, not a financial advisor. Values will differ from jeweller buyback prices. Portfolio change is calculated against last Monday's spot prices.
    </p>
    <p style="margin:0 0 6px;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">&copy; 2026 MyAurum. All rights reserved. &nbsp;&middot;&nbsp; Registered in India &nbsp;&middot;&nbsp; <a href="${APP_URL}/privacy" style="color:#B8860B;text-decoration:none">Privacy Policy</a></p>
    <p style="margin:0;font-size:10px;font-family:Arial,sans-serif">
      <a href="${unsubUrl}" style="color:#B8860B;text-decoration:none">Unsubscribe from weekly emails</a>
      &nbsp;&middot;&nbsp;
      <a href="${APP_URL}" style="color:#B8860B;text-decoration:none">myaurum.app</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

      // Plain text
      const changeText = changePct !== null
        ? `Change: ${changeVal >= 0 ? '+' : ''}${formatVal(Math.abs(changeVal), isMCX, sym)} (${changeVal >= 0 ? '+' : '-'}${Math.abs(changePct).toFixed(1)}%)`
        : 'First snapshot — change data from next week';

      const metalText = metalOrder.map(m => {
        const d = metalData[m];
        const wkChange = metalSpotChange[m];
        const wkStr = wkChange !== undefined ? ` · spot ${wkChange >= 0 ? '+' : ''}${wkChange.toFixed(1)}% this week` : '';
        const spotStr = m === 'gold' ? goldSpotStr : m === 'silver' ? silverSpotStr : '';
        return `${(metalLabels[m]||m).toUpperCase()}: ${formatVal(d.valueDisp, isMCX, sym)} · ${d.grams.toFixed(2)}g${spotStr ? '\nSpot: ' + spotStr + wkStr : ''}`;
      }).join('\n\n');

      const text = [
        `Hi ${user.first_name},`,
        '',
        `Your MyAurum vault · ${asOf}`,
        '',
        `PORTFOLIO TOTAL: ${formatVal(totalValue, isMCX, sym)}`,
        changeText,
        '',
        metalText,
        '',
        APP_URL,
        '',
        '---',
        'Prices are indicative spot rates. MyAurum is a personal record tool, not a financial advisor.',
        `Unsubscribe: ${unsubUrl}`,
      ].join('\n');

      await sendEmail({ to: user.email, subject, html, text });
      await q('UPDATE users SET weekly_email_sent_at=NOW() WHERE id=$1', [user.id]);
      sent++;
      console.log(`[weekly] Sent to ${user.email}`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));

    } catch(e) {
      console.error(`[weekly] Failed for user ${user.id}:`, e.message);
      skipped++;
    }
  }

  console.log(`[weekly] Done — sent: ${sent}, skipped: ${skipped}`);
}

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
//  WEB PUSH
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
//  SENTRY + ERROR HANDLER
// ─────────────────────────────────────────
if (Sentry) app.use(Sentry.Handlers.errorHandler());
app.use((err, req, res, next) => {
  console.error("[server] Unhandled:", err.message);
  if (Sentry) Sentry.captureException(err);
  res.status(500).json({ error: "Server error" });
});

// ─────────────────────────────────────────
//  STATIC ROUTES
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  LIVE PORTFOLIO SHARE LINK
// ─────────────────────────────────────────

// Generate or retrieve share token
app.post('/api/share/generate', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT share_token FROM users WHERE id=$1', [req.user.userId]);
    let token = r.rows[0]?.share_token;
    if (!token) {
      token = require('crypto').randomBytes(24).toString('hex');
      await q('UPDATE users SET share_token=$1 WHERE id=$2', [token, req.user.userId]);
    }
    res.json({ token, url: `${APP_URL}/share/${token}` });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Revoke share token
app.post('/api/share/revoke', requireAuth, async (req, res) => {
  try {
    await q('UPDATE users SET share_token=NULL WHERE id=$1', [req.user.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Serve read-only portfolio view
app.get('/share/:token', async (req, res) => {
  try {
    const r = await q('SELECT * FROM users WHERE share_token=$1', [req.params.token]);
    const u = r.rows[0];
    if (!u) return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>MyAurum</title></head><body style="font-family:Georgia,serif;background:#F5F0E8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#2C2410;text-align:center"><div><div style="font-size:22px;letter-spacing:.2em;color:#8B6914;margin-bottom:12px">MYAURUM</div><p style="color:#888">This portfolio link is no longer active.</p><a href="/" style="color:#B8860B;text-decoration:none;font-size:13px">Visit myaurum.app →</a></div></body></html>`);

    const itemsRes = await q('SELECT * FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE OR gifted IS NULL) ORDER BY added_at DESC', [u.id]);
    const items = itemsRes.rows.map(r => itemToClient(decryptRow(r)));

    // Get latest prices
    const gold = priceCache.gold || 0;
    const silver = priceCache.silver || 0;
    const usdInr = priceCache.usd_inr || 83;
    const INDIA_FACTOR = (10/31.1035)*1.15*1.03;

    const isMCX = (u.country||'').toLowerCase() === 'india';
    const sym = isMCX ? '₹' : '$';

    function spotVal(metal, grams, purity) {
      const oz = grams * purity / 31.1035;
      if (isMCX && metal !== 'platinum') {
        return (grams * purity / 10) * (metal === 'gold' ? gold : silver) * usdInr * 1.15 * 1.03;
      }
      return oz * (metal === 'gold' ? gold : metal === 'silver' ? silver : (priceCache.platinum||980));
    }

    function fmtVal(v) {
      if (isMCX) return '₹' + Math.round(v).toLocaleString('en-IN');
      return '$' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    }

    const total = items.reduce((s,i) => s + spotVal(i.metal, i.grams, i.purity), 0);
    const now = new Date();
    const asOf = now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) + ', ' +
      now.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}) + ' IST';

    const metalGroups = {};
    items.forEach(item => {
      if (!metalGroups[item.metal]) metalGroups[item.metal] = [];
      metalGroups[item.metal].push(item);
    });

    const metalOrder = ['gold','silver','platinum'];
    const metalLabels = {gold:'Gold',silver:'Silver',platinum:'Platinum'};

    let tableRows = '';
    metalOrder.forEach(metal => {
      if (!metalGroups[metal]) return;
      tableRows += `<tr><td colspan="4" style="background:#F5EDD0;font-size:10px;letter-spacing:.14em;color:#8B6914;font-weight:600;padding:7px 12px;text-transform:uppercase">${metalLabels[metal]}</td></tr>`;
      metalGroups[metal].forEach(item => {
        const v = spotVal(item.metal, item.grams, item.purity);
        tableRows += `<tr style="border-bottom:1px solid #EDE8DA">
          <td style="padding:10px 12px;font-size:13px;color:#2C2410">${item.name}</td>
          <td style="padding:10px 12px;font-size:12px;color:#8B6914;text-align:center">${item.gradeName.split(' — ')[0]}</td>
          <td style="padding:10px 12px;font-size:12px;color:#555;text-align:center">${item.grams.toFixed(2)}g</td>
          <td style="padding:10px 12px;font-size:13px;color:#2C2410;font-weight:500;text-align:right">${fmtVal(v)}</td>
        </tr>`;
      });
    });

    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${u.first_name}'s Portfolio — MyAurum</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Jost',sans-serif;background:#F5F0E8;color:#2C2410;min-height:100vh}
.header{background:#1A1508;padding:18px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:300;letter-spacing:.22em;color:#F0B429;text-decoration:none}
.badge{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#6B4F10;background:rgba(184,134,11,.15);padding:4px 10px;border-radius:10px}
.hero{padding:32px 24px 24px;max-width:680px;margin:0 auto}
.owner{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:300;color:#2C2410;margin-bottom:4px}
.asof{font-size:11px;color:#B8A070;letter-spacing:.04em}
.total-card{background:#fff;border:1px solid #DDD5C0;border-radius:12px;padding:20px 24px;margin:20px 0;display:flex;justify-content:space-between;align-items:center}
.total-label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8B6914}
.total-val{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:300;color:#2C2410}
.content{max-width:680px;margin:0 auto;padding:0 24px 48px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #DDD5C0;border-radius:12px;overflow:hidden}
.footer{text-align:center;padding:24px;font-size:10px;color:#B8A070;line-height:1.8}
.footer a{color:#B8860B;text-decoration:none}
.live-dot{width:6px;height:6px;border-radius:50%;background:#4CAF50;display:inline-block;margin-right:5px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:600px){.total-val{font-size:26px}.hero{padding:24px 16px 16px}.content{padding:0 16px 40px}}
</style>
</head><body>
<div class="header">
  <a href="/" class="logo">MYAURUM</a>
  <span class="badge"><span class="live-dot"></span>Live portfolio</span>
</div>
<div class="hero">
  <div class="owner">${u.first_name} ${u.last_name}'s Holdings</div>
  <div class="asof">As of ${asOf} &nbsp;·&nbsp; ${isMCX ? 'MCX benchmark' : 'COMEX benchmark'}</div>
  <div class="total-card">
    <div>
      <div class="total-label">Portfolio Value</div>
      <div class="total-val">${fmtVal(total)}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#B8A070;margin-bottom:4px">${items.length} holding${items.length!==1?'s':''}</div>
      <div style="font-size:11px;color:#8B6914">Prices update live</div>
    </div>
  </div>
</div>
<div class="content">
  <table>
    <thead><tr style="border-bottom:2px solid #DDD5C0">
      <th style="padding:10px 12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8B6914;text-align:left;font-weight:500">Item</th>
      <th style="padding:10px 12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8B6914;text-align:center;font-weight:500">Purity</th>
      <th style="padding:10px 12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8B6914;text-align:center;font-weight:500">Weight</th>
      <th style="padding:10px 12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8B6914;text-align:right;font-weight:500">Value</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div style="margin-top:14px;font-size:11px;color:#B8A070;line-height:1.7;text-align:center">
    Values are indicative estimates at live spot prices. Not financial advice.
  </div>
</div>
<div class="footer">
  <p>This portfolio is shared via MyAurum &nbsp;·&nbsp; <a href="/">myaurum.app</a></p>
  <p style="margin-top:4px;opacity:.7">© 2026 MyAurum. All rights reserved. &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a></p>
</div>
</body></html>`);
  } catch(e) {
    console.error('[share]', e.message);
    res.status(500).send('Something went wrong.');
  }
});

app.get('/security', (req, res) => {
  const p = path.join(__dirname, 'security.html');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(p); }
  else res.redirect('/');
});

// ─────────────────────────────────────────
//  ADMIN DASHBOARD
// ─────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'myaurum_admin_2026';
const ADMIN_IP   = process.env.ADMIN_IP   || '103.156.212.177';
const ADMIN_SLUG = process.env.ADMIN_SLUG || 'dash-4f8a2e91c3b7';
const ADMIN_COOKIE = 'mya_adm';

function adminToken() {
  return crypto.createHmac('sha256', JWT_SECRET).update(ADMIN_PASS).digest('hex');
}

function getAdminCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(ADMIN_COOKIE + '='));
  return match ? match.slice(ADMIN_COOKIE.length + 1) : null;
}

function requireAdmin(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip !== ADMIN_IP) return res.status(404).send('Not found');
  const cookie = getAdminCookie(req);
  if (cookie && cookie === adminToken()) return next();
  const qp = req.query.p || '';
  if (qp === ADMIN_PASS) return next();
  const authHeader = req.headers['x-admin-token'] || '';
  if (authHeader === adminToken()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
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

app.post(`/${ADMIN_SLUG}/login`, (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip !== ADMIN_IP) return res.status(404).send('Not found');
  const { p } = req.body;
  if (p !== ADMIN_PASS) return res.status(401).json({ error: 'Incorrect password' });
  const token = adminToken();
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

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
    html = html.replace('</head>', `<script>window._adminToken="${adminToken()}";</script></head>`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '-1');
    res.type('html').send(html);
  } else res.status(404).send('Not found');
});

app.get(`/api/${ADMIN_SLUG}/stats`, requireAdmin, async (req, res) => {
  try {
    const totalUsers = await q('SELECT COUNT(*) FROM users');
    const signupsByDay = await q(`
      SELECT DATE(created_at) as day, COUNT(*) as count
      FROM users WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY day ASC`);
    const authMethods = await q(`SELECT COALESCE(auth_method,'email') as method, COUNT(*) as count FROM users GROUP BY auth_method`);
    const activeWeek = await q(`SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '7 days'`);
    const activeMonth = await q(`SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '30 days'`);
    const dropoff = await q(`SELECT COUNT(*) FROM users WHERE last_seen IS NULL OR last_seen < created_at + INTERVAL '2 minutes'`);
    const verified = await q(`SELECT email_verified, COUNT(*) as count FROM users GROUP BY email_verified`);
    const holdingsByMetal = await q(`SELECT metal, COUNT(*) as items, COUNT(DISTINCT user_id) as users, ROUND(SUM(grams)::numeric, 1) as total_grams FROM items WHERE sold=FALSE GROUP BY metal`);
    const holdingsByType = await q(`SELECT type, COUNT(*) as items, COUNT(DISTINCT user_id) as users FROM items WHERE sold=FALSE GROUP BY type`);
    const avgItems = await q(`SELECT ROUND(AVG(cnt)::numeric,1) as avg FROM (SELECT user_id, COUNT(*) as cnt FROM items WHERE sold=FALSE GROUP BY user_id) sub`);
    const thisWeek = await q(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'`);
    const lastWeek = await q(`SELECT COUNT(*) FROM users WHERE created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'`);
    const withAlerts = await q(`SELECT COUNT(DISTINCT user_id) FROM alerts`);
    const withHoldings = await q(`SELECT COUNT(DISTINCT user_id) FROM items WHERE sold=FALSE`);
    const zeroHoldings = await q(`SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.user_id = u.id AND i.sold=FALSE)`);
    const activatedUsers = parseInt(withHoldings.rows[0].count);
    const notActivatedUsers = parseInt(zeroHoldings.rows[0].count);
    const activationRate = (activatedUsers + notActivatedUsers) > 0 ? Math.round(activatedUsers / (activatedUsers + notActivatedUsers) * 100) : 0;
    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count),
      signupsByDay: signupsByDay.rows, authMethods: authMethods.rows,
      activeWeek: parseInt(activeWeek.rows[0].count), activeMonth: parseInt(activeMonth.rows[0].count),
      dropoff: parseInt(dropoff.rows[0].count), verified: verified.rows,
      holdingsByMetal: holdingsByMetal.rows, holdingsByType: holdingsByType.rows,
      avgItemsPerUser: parseFloat(avgItems.rows[0].avg) || 0,
      thisWeek: parseInt(thisWeek.rows[0].count), lastWeek: parseInt(lastWeek.rows[0].count),
      withAlerts: parseInt(withAlerts.rows[0].count),
      activatedUsers, notActivatedUsers, activationRate,
    });
  } catch(e) { console.error('[admin]', e.message); res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
//  FAVICON — inline SVG-based PNG (light, no base64 bloat)
// ─────────────────────────────────────────
// Serve a minimal gold coin SVG as favicon
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="#B8860B"/>
  <circle cx="32" cy="32" r="24" fill="#D4A017"/>
  <text x="32" y="42" text-anchor="middle" font-family="Georgia,serif" font-size="28" font-weight="300" fill="#1A1508" letter-spacing="1">M</text>
</svg>`;

app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
});

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
});

app.get('/apple-touch-icon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
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

app.get('/og-image.png', (req, res) => {
  const p = path.join(__dirname, 'og-image.png');
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
  } else {
    res.status(404).send('Not found');
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

    // Weekly digest — Monday 8:00am IST = 02:30 UTC
    cron.schedule('30 2 * * 1', async () => {
      try { await sendWeeklyDigests(); }
      catch(e) { console.error('[weekly] Cron error:', e.message); }
    });

    // Daily cleanup — expired tokens
    cron.schedule('0 3 * * *', async () => {
      try {
        const r1 = await q("DELETE FROM password_reset_tokens WHERE expires_at < NOW()");
        const r2 = await q("DELETE FROM email_verify_tokens WHERE expires_at < NOW()");
        console.log(`[cleanup] Deleted ${r1.rowCount} reset tokens, ${r2.rowCount} verify tokens`);
      } catch(e) { console.error('[cleanup] Token cleanup failed:', e.message); }
    });
    // One-time migration — encrypt existing plaintext rows
    setImmediate(async () => {
      try {
        const rows = await q('SELECT id, name, grade_name, notes, held_by, nominee, sell_notes FROM items');
        let migrated = 0;
        for (const row of rows.rows) {
          const updates = {};
          if (row.name && !row.name.startsWith(ENC_PREFIX)) updates.name = encryptField(row.name);
          if (row.grade_name && !row.grade_name.startsWith(ENC_PREFIX)) updates.grade_name = encryptField(row.grade_name);
          if (row.notes && !row.notes.startsWith(ENC_PREFIX)) updates.notes = encryptField(row.notes);
          if (row.held_by && !row.held_by.startsWith(ENC_PREFIX)) updates.held_by = encryptField(row.held_by);
          if (row.nominee && !row.nominee.startsWith(ENC_PREFIX)) updates.nominee = encryptField(row.nominee);
          if (row.sell_notes && !row.sell_notes.startsWith(ENC_PREFIX)) updates.sell_notes = encryptField(row.sell_notes);
          if (Object.keys(updates).length) {
            const fields = Object.keys(updates).map((k,i) => `${k}=$${i+2}`).join(',');
            const vals = Object.values(updates);
            await q(`UPDATE items SET ${fields} WHERE id=$1`, [row.id, ...vals]);
            migrated++;
          }
        }
        if (migrated > 0) console.log(`[encryption] Migrated ${migrated} plaintext rows to encrypted storage`);
        else console.log('[encryption] All rows already encrypted');
      } catch(e) {
        console.error('[encryption] Migration error:', e.message);
      }
    });

    refreshPrices().catch(console.error);
    app.listen(PORT, () => console.log(`\n🏛  MyAurum running on port ${PORT} (PostgreSQL)\n`));
  })
  .catch(err => { console.error('[fatal] DB init failed:', err); process.exit(1); });
