'use strict'; // v6 - welcome email, removed login verify gate
// build: 2026-03-19
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
const ENCRYPT_KEY = (process.env.ENCRYPTION_KEY || process.env.MYA_ENCRYPTION_KEY)
  ? Buffer.from((process.env.ENCRYPTION_KEY || process.env.MYA_ENCRYPTION_KEY), 'hex')
  : (() => { console.log('[security] Using derived encryption key'); return require('crypto').scryptSync(process.env.JWT_SECRET || 'mya_9$Kp2#xL8nRvTw4@Yz6bNjHcFsUeGdK3mXpA7!', 'myaurum-salt-v1', 32); })();
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '826792551094-s9dg885quvbfd04ocaohnkp1ar8jvm5h.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
const RESEND_KEY  = process.env.RESEND_API_KEY || process.env.MY_RESEND_KEY || 're_C6LyyCaZ_DWMmyNgHbcSdSAFpKxtoAyhR';
const APP_URL     = process.env.APP_URL || 'https://myaurum.app';
const METALS_DEV_KEY = process.env.METALS_DEV_KEY || null; // set in Railway when ready
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BObbou1l2U7fZqh1RsXxp3_gUNibmR1MXgQpGYSj9pXgkzZCzfMUfuNp9uPdm4jeJpuYPvJzb4yKoJE_uuox0Ls';
const VAPID_PRIVATE= process.env.VAPID_PRIVATE_KEY || 'eW-amR4xbefXF4BUBWTfLO6sg3SmKSPWllRUt4Uaqjs';
const VAPID_EMAIL  = process.env.VAPID_EMAIL || 'mailto:admin@myaurum.app';

const _DB_URL = process.env.MYA_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:cSANKPNApcPSSBMfqJkyeLAhUWrgcOwd@turntable.proxy.rlwy.net:36567/railway';
console.log('[config] DATABASE_URL:', _DB_URL !== 'postgresql://postgres:cSANKPNApcPSSBMfqJkyeLAhUWrgcOwd@turntable.proxy.rlwy.net:36567/railway' ? _DB_URL.slice(0, 40) + '...' : 'using hardcoded fallback (ok)');

const RZP_KEY_ID      = process.env.RAZORPAY_KEY_ID      || 'rzp_test_placeholder';
const RZP_KEY_SECRET  = process.env.RAZORPAY_KEY_SECRET  || 'placeholder_secret';
const RZP_PLAN_ID       = process.env.RAZORPAY_PLAN_ID       || 'plan_placeholder';
const RZP_SUPER_PLAN_ID = process.env.RAZORPAY_SUPER_PLAN_ID || 'plan_super_placeholder';
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'webhook_placeholder';

const pool = new Pool({
  connectionString: _DB_URL,
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
      platinum    REAL,
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      is_daily    BOOLEAN DEFAULT FALSE
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
  await q(`ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_metal_check`);
  await q(`ALTER TABLE alerts ADD CONSTRAINT alerts_metal_check CHECK(metal IN ('gold','silver','platinum'))`);
  await q(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fired_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_method TEXT DEFAULT 'email'`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_opt_out BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_email_sent_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_since TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_notes TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency TEXT`);
  await q(`ALTER TABLE price_cache ADD COLUMN IF NOT EXISTS ibja_gold_inr REAL`);
  await q(`ALTER TABLE price_cache ADD COLUMN IF NOT EXISTS ibja_silver_inr REAL`);
  await q(`ALTER TABLE price_cache ADD COLUMN IF NOT EXISTS ibja_fetched_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE`);
  await q(`
    CREATE TABLE IF NOT EXISTS page_views (
      id          BIGSERIAL PRIMARY KEY,
      slug        TEXT NOT NULL,
      referrer    TEXT,
      ref_domain  TEXT,
      country     TEXT,
      city        TEXT,
      ua_type     TEXT DEFAULT 'unknown',
      is_bot      BOOLEAN DEFAULT FALSE,
      viewed_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS page_views_slug_idx ON page_views(slug)`);
  await q(`CREATE INDEX IF NOT EXISTS page_views_viewed_at_idx ON page_views(viewed_at)`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_tier TEXT DEFAULT 'standard'`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_warn_15_sent_at TIMESTAMPTZ`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_warn_19_sent_at TIMESTAMPTZ`);

  // Dead man's switch
  await q(`
    CREATE TABLE IF NOT EXISTS nominees (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, email)
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS deadmans_switch (
      user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled        BOOLEAN DEFAULT FALSE,
      period_days    INTEGER DEFAULT 90,
      last_warned_at TIMESTAMPTZ,
      fired_at       TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS estate_notes_decrypted TEXT`);

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
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gift_value_usd REAL`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gift_gain_usd REAL`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS gift_notes TEXT`);
  await q(`ALTER TABLE items ADD COLUMN IF NOT EXISTS received_as_gift BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS platinum REAL`);
  await q(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS is_daily BOOLEAN DEFAULT FALSE`);
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

// ─────────────────────────────────────────
//  HISTORICAL PRICE BACKFILL (stooq.com)
// ─────────────────────────────────────────
function fetchStooq(symbol, fromDate, toDate) {
  // fromDate, toDate: 'YYYYMMDD'
  return new Promise((resolve, reject) => {
    const url = `https://stooq.com/q/d/l/?s=${symbol}&d1=${fromDate}&d2=${toDate}&i=d`;
    const req = https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // CSV: Date,Open,High,Low,Close,Volume
        const rows = [];
        const lines = data.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 5 && parts[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
            rows.push({ date: parts[0], close: parseFloat(parts[4]) });
          }
        }
        resolve(rows);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('stooq timeout')); });
  });
}

async function backfillPriceHistory() {
  try {
    // Find the oldest purchase date across all items
    const oldest = await q(`
      SELECT MIN(purchase_date) as oldest_date FROM items
      WHERE purchase_date IS NOT NULL AND purchase_date != ''
    `);
    if (!oldest.rows[0]?.oldest_date) {
      console.log('[backfill] No purchase dates found, skipping');
      return;
    }

    // Find the oldest date we already have in price_history
    const existingOldest = await q(`SELECT MIN(recorded_at) as oldest FROM price_history WHERE is_daily = TRUE`);
    const targetStart = new Date(oldest.rows[0].oldest_date);
    const dbOldest = existingOldest.rows[0]?.oldest ? new Date(existingOldest.rows[0].oldest) : null;

    // Check if we already have data going back far enough (within 2 days)
    if (dbOldest && (dbOldest - targetStart) < 2 * 24 * 60 * 60 * 1000) {
      console.log('[backfill] History already covers oldest purchase date, skipping');
      return;
    }

    // Format dates for stooq
    const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
    const fromStr = fmt(targetStart);
    const toStr = fmt(new Date());

    console.log(`[backfill] Fetching gold history from ${fromStr} to ${toStr}`);
    const goldRows = await fetchStooq('xauusd', fromStr, toStr);
    const silverRows = await fetchStooq('xagusd', fromStr, toStr);

    if (!goldRows.length) {
      console.log('[backfill] No data returned from stooq');
      return;
    }

    // Build a silver lookup by date
    const silverByDate = {};
    for (const r of silverRows) silverByDate[r.date] = r.close;

    // Insert daily closes — skip dates we already have
    let inserted = 0;
    for (const g of goldRows) {
      const silver = silverByDate[g.date] || null;
      if (!silver) continue;
      try {
        await q(`
          INSERT INTO price_history (gold, silver, is_daily, recorded_at)
          VALUES ($1, $2, TRUE, $3::date)
          ON CONFLICT DO NOTHING
        `, [g.close, silver, g.date]);
        inserted++;
      } catch(e) { /* skip duplicates */ }
    }
    console.log(`[backfill] Inserted ${inserted} daily price records`);
  } catch(e) {
    console.warn('[backfill] Error:', e.message);
  }
}

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

// ─────────────────────────────────────────
//  IBJA RATES (via Metals.dev)
// ─────────────────────────────────────────
async function fetchIBJARates() {
  if (!METALS_DEV_KEY) {
    console.log('[ibja] No METALS_DEV_KEY set — skipping IBJA fetch');
    return;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.metals.dev',
        path: `/v1/latest?api_key=${METALS_DEV_KEY}&currency=INR&unit=tola`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      };
      https.get(opts, r => {
        let buf = '';
        r.on('data', d => buf += d);
        r.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch(e) { reject(e); }
        });
      }).on('error', reject);
    });

    // Metals.dev returns rates per tola (11.6638g) in INR
    // Convert to per-10g: value / 11.6638 * 10
    const TOLA_TO_10G = 10 / 11.6638;
    const gold_inr  = data.metals?.gold  ? Math.round(data.metals.gold  * TOLA_TO_10G) : null;
    const silver_inr = data.metals?.silver ? Math.round(data.metals.silver * TOLA_TO_10G) : null;

    if (gold_inr && silver_inr) {
      await q('UPDATE price_cache SET ibja_gold_inr=$1, ibja_silver_inr=$2, ibja_fetched_at=NOW() WHERE id=1',
        [gold_inr, silver_inr]);
      priceCache.ibja_gold_inr  = gold_inr;
      priceCache.ibja_silver_inr = silver_inr;
      console.log(`[ibja] Gold ₹${gold_inr.toLocaleString()}/10g · Silver ₹${silver_inr.toLocaleString()}/10g`);
    } else {
      console.warn('[ibja] Unexpected response format:', JSON.stringify(data).slice(0, 200));
    }
  } catch(e) {
    console.error('[ibja] Fetch failed:', e.message);
  }
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
    await q('INSERT INTO price_history (gold, silver, platinum, is_daily) VALUES ($1, $2, $3, FALSE)',
      [gold, silver, priceCache.platinum||null]);
    // Only delete intraday snapshots older than 90 days — keep daily records forever
    await q("DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '90 days' AND is_daily = FALSE");
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
    gifted:!!r.gifted, giftedTo:r.gifted_to||'', giftedAt:r.gifted_at||'', photos:r.photos||null,
    giftDate:r.gifted_at||'', giftTo:r.gifted_to||'', giftNotes:r.gift_notes||'',
    giftValueUSD:r.gift_value_usd||null, giftGainUSD:r.gift_gain_usd||null,
    receivedAsGift:!!r.received_as_gift };
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
    gift_notes: decryptField(r.gift_notes),
  };
}



function alertToClient(r) {
  return { id:r.id, clientId:r.client_id, metal:r.metal, dir:r.direction, price:r.price,
    priceDisplay:r.price_display||null, priceCurrency:r.price_currency||'USD',
    note:r.note||'', fired:!!r.fired, firedAt:r.fired_at||null, createdAt:r.created_at };
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
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, preferred_currency:u.preferred_currency||null, joinedAt:u.created_at, emailVerified:true } });
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
    res.json({ token, user:{ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, preferred_currency:u.preferred_currency||null, joinedAt:u.created_at, emailVerified:true } });
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
    res.json({ token, user: { id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, preferred_currency:u.preferred_currency||null, joinedAt:u.created_at, emailVerified:true } });
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
    const isPremium = !!u.is_premium && (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());
    const premiumTier = isPremium ? (u.premium_tier || 'standard') : null;
    res.json({ id:u.id, email:u.email, firstName:u.first_name, lastName:u.last_name, age:u.age, country:u.country, preferred_currency:u.preferred_currency||null, joinedAt:u.created_at, emailVerified:!!u.email_verified, twoFactorEnabled:!!u.two_factor_enabled, isPremium, premiumTier, premiumExpiresAt:u.premium_expires_at||null, razorpaySubscriptionId:u.razorpay_subscription_id||null });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  const { firstName, lastName, age, country, email, password, preferred_currency } = req.body;
  try {
    const r = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error:'User not found' });

    // Lightweight currency-only update (from setCurrency in app)
    if (preferred_currency && Object.keys(req.body).length === 1) {
      const valid = ['INR','USD','GBP','EUR','AED'];
      if (!valid.includes(preferred_currency)) return res.status(400).json({ error:'Invalid currency' });
      await q('UPDATE users SET preferred_currency=$1 WHERE id=$2', [preferred_currency, u.id]);
      return res.json({ ok: true });
    }

    const newEmail = email ? email.toLowerCase().trim() : u.email;
    if (newEmail !== u.email) {
      const conflict = await q('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id!=$2', [newEmail, u.id]);
      if (conflict.rows.length) return res.status(409).json({ error:'That email is already in use' });
    }
    let newHash = u.password;
    if (password && password.length >= 6) newHash = await bcrypt.hash(password, 12);
    const updated = await q(`UPDATE users SET email=$1,password=$2,first_name=$3,last_name=$4,age=$5,country=$6,preferred_currency=COALESCE($7,preferred_currency),updated_at=NOW() WHERE id=$8 RETURNING *`,
      [newEmail, newHash, firstName||u.first_name, lastName||u.last_name, age||u.age, country||u.country, preferred_currency||null, u.id]);
    const uu = updated.rows[0];
    const token = jwt.sign({ userId:uu.id, email:uu.email }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user:{ id:uu.id, email:uu.email, firstName:uu.first_name, lastName:uu.last_name, age:uu.age, country:uu.country, preferred_currency:uu.preferred_currency, joinedAt:uu.created_at } });
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
    <p style="margin:6px 0 0;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">MyAurum is a personal record tool, not a financial product. Values shown are indicative estimates based on live spot prices and do not constitute financial advice, or a valuation for insurance, legal, or tax purposes.</p>
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
    'MyAurum is free up to 20 holdings. No credit card, no catch.',
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
    <p style="margin:0;font-size:10px;color:#CCC;line-height:1.7;font-family:Arial,sans-serif">MyAurum is a personal record tool, not a financial product. Values shown are indicative estimates based on live spot prices and do not constitute financial advice, or a valuation for insurance, legal, or tax purposes.</p>
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
    'MyAurum premium is coming. For those who want to go further — up to 200 holdings, advanced succession tools, priority support — we are building it. You will hear from me first.',
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
      Prices are indicative spot rates — actual buyback values vary by dealer. Values do not constitute a valuation for insurance, legal, or tax purposes.<br>
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
      await q('UPDATE alerts SET fired=TRUE, fired_at=NOW() WHERE id=$1', [alert.id]);
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
      ibja:{ goldInr: priceCache.ibja_gold_inr||null, silverInr: priceCache.ibja_silver_inr||null, fetchedAt: priceCache.ibja_fetched_at||null },
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

// ── Cap constants ──
const FREE_CAP      = 20;
const STANDARD_CAP  = 200;
const SUPER_CAP     = 300;

// ── Warning email: 15 holdings ──
async function sendLimitWarn15(user) {
  const remaining = FREE_CAP - 15;
  const html = `
    <div style="font-family:'Georgia',serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#2C2410">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8B6914;margin-bottom:24px">MyAurum</div>
      <p style="font-size:16px;line-height:1.7;margin-bottom:18px">Hi ${user.first_name},</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:18px">You have reached 15 holdings in MyAurum — ${remaining} remain on the free tier.</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:18px">If you are tracking a larger collection, MyAurum Premium gives you up to 200 holdings for ₹600 a year (or $15 internationally).</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:24px">No pressure — your current holdings are safe and fully accessible. This is just a heads-up.</p>
      <a href="${APP_URL}/#profile" style="display:inline-block;padding:12px 24px;background:#8B6914;color:#FDF8F0;text-decoration:none;border-radius:8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase">View Plans</a>
      <p style="font-size:12px;color:#888;margin-top:32px;line-height:1.6">You are receiving this because you have an active MyAurum account.</p>
    </div>`;
  const text = `Hi ${user.first_name},\n\nYou have reached 15 holdings in MyAurum — ${remaining} remain on the free tier.\n\nIf you are tracking a larger collection, MyAurum Premium gives you up to 200 holdings for ₹600/yr or $15/yr internationally.\n\nNo pressure — your holdings are safe. This is just a heads-up.\n\n${APP_URL}/#profile`;
  return sendEmail({ to: user.email, subject: 'MyAurum: 15 of 20 free holdings used', html, text });
}

// ── Warning email: 19 holdings ──
async function sendLimitWarn19(user) {
  const html = `
    <div style="font-family:'Georgia',serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#2C2410">
      <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8B6914;margin-bottom:24px">MyAurum</div>
      <p style="font-size:16px;line-height:1.7;margin-bottom:18px">Hi ${user.first_name},</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:18px">You have 1 holding left on the free tier.</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:18px">Once you reach 20, you will not be able to add more without upgrading. MyAurum Premium gives you up to 200 holdings for ₹600 a year.</p>
      <p style="font-size:15px;line-height:1.8;margin-bottom:24px">Your existing holdings will always remain accessible — upgrading simply lets you continue adding.</p>
      <a href="${APP_URL}/#profile" style="display:inline-block;padding:12px 24px;background:#8B6914;color:#FDF8F0;text-decoration:none;border-radius:8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase">Upgrade to Premium</a>
      <p style="font-size:12px;color:#888;margin-top:32px;line-height:1.6">You are receiving this because you have an active MyAurum account.</p>
    </div>`;
  const text = `Hi ${user.first_name},\n\nYou have 1 holding left on the free tier.\n\nMyAurum Premium gives you up to 200 holdings for ₹600/yr or $15/yr internationally.\n\nYour existing holdings will always remain accessible.\n\n${APP_URL}/#profile`;
  return sendEmail({ to: user.email, subject: 'MyAurum: 1 free holding remaining', html, text });
}

app.post('/api/items', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    // ── Server-side cap enforcement ──
    const userRes = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = userRes.rows[0];
    const isPremium = !!u.is_premium && (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());
    const tier = isPremium ? (u.premium_tier || 'standard') : null;
    const cap = isPremium ? (tier === 'super' ? SUPER_CAP : STANDARD_CAP) : FREE_CAP;
    const countRes = await q('SELECT COUNT(*) FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE)', [req.user.userId]);
    const activeCount = parseInt(countRes.rows[0].count, 10);
    if (activeCount >= cap) {
      const msg = isPremium && tier !== 'super'
        ? `You have reached the ${STANDARD_CAP}-holding Premium limit. Upgrade to Super Premium for up to ${SUPER_CAP} holdings.`
        : isPremium
        ? `You have reached the ${SUPER_CAP}-holding Super Premium limit.`
        : `You have reached the ${FREE_CAP}-holding free tier limit. Upgrade to Premium to continue adding holdings.`;
      return res.status(403).json({ error: msg, limitReached: true, cap, tier: tier||'free' });
    }

    const r = await q(`INSERT INTO items (user_id,client_id,name,metal,type,grade_name,purity,grams,notes,purchase_date,price_paid,price_paid_curr,price_paid_usd,receipt,held_by,nominee,making_charge,making_charge_currency,gold_cost_basis_usd,photos,received_as_gift,added_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [req.user.userId, d.clientId||null,
       encryptField(d.name), d.metal, d.type, encryptField(d.gradeName), d.purity, d.grams,
       d.notes?encryptField(d.notes):null, d.purchaseDate||null,
       d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null,
       d.receipt||null,
       d.heldBy||null, d.nominee||null,
       d.makingCharge||null, d.makingChargeCurrency||null, d.goldCostBasisUSD||null,
       d.photos?JSON.stringify(d.photos):null,
       d.receivedAsGift||false,
       d.addedAt||new Date().toISOString()]);
    const newItem = itemToClient(decryptRow(r.rows[0]));
    res.status(201).json(newItem);

    // ── Warning email triggers (fire-and-forget, after response sent) ──
    (async () => {
      try {
        const freshUser = (await q('SELECT * FROM users WHERE id=$1', [req.user.userId])).rows[0];
        const freshIsPremium = !!freshUser.is_premium && (!freshUser.premium_expires_at || new Date(freshUser.premium_expires_at) > new Date());
        if (freshIsPremium) return; // premium users don't get free-tier warnings
        const freshCount = parseInt((await q('SELECT COUNT(*) FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE)', [req.user.userId])).rows[0].count, 10);

        if (freshCount >= 15 && freshCount < FREE_CAP) {
          // Check if warn-15 should reset (user dropped below 15 since last send, now back)
          // We reset limit_warn_15_sent_at when count drops below 15 (handled in sell/gift routes)
          if (!freshUser.limit_warn_15_sent_at) {
            await q('UPDATE users SET limit_warn_15_sent_at=NOW() WHERE id=$1', [freshUser.id]);
            await sendLimitWarn15(freshUser).catch(e => console.error('[warn15]', e.message));
          }
        }
        if (freshCount >= 19) {
          if (!freshUser.limit_warn_19_sent_at) {
            await q('UPDATE users SET limit_warn_19_sent_at=NOW() WHERE id=$1', [freshUser.id]);
            await sendLimitWarn19(freshUser).catch(e => console.error('[warn19]', e.message));
          }
        }
      } catch(e) { console.error('[warn-email]', e.message); }
    })();
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
  const d = req.body;
  try {
    const exists = await q('SELECT id FROM items WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (!exists.rows.length) return res.status(404).json({ error:'Item not found' });

    // ── Dormancy check: block sell/gift when lapsed with >FREE_CAP active holdings ──
    if (d.sold || d.gifted) {
      const uRes = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
      const u = uRes.rows[0];
      const isPremium = !!u.is_premium && (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());
      const graceEnd = u.premium_expires_at ? new Date(new Date(u.premium_expires_at).getTime() + 30*24*60*60*1000) : null;
      const inGrace = graceEnd && new Date() <= graceEnd;
      if (!isPremium && !inGrace) {
        const cntRes = await q('SELECT COUNT(*) FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE)', [req.user.userId]);
        const activeCount = parseInt(cntRes.rows[0].count, 10);
        if (activeCount > FREE_CAP) {
          return res.status(403).json({ error: 'Your account is in read-only mode. Renew your Premium subscription to record sales or gifts.', dormant: true });
        }
      }
    }

    // Reset warning flags if active count drops below threshold after edit
    (async () => {
      try {
        const freshCount = parseInt((await q('SELECT COUNT(*) FROM items WHERE user_id=$1 AND sold=FALSE AND (gifted IS NOT TRUE)', [req.user.userId])).rows[0].count, 10);
        if (freshCount < 19) await q('UPDATE users SET limit_warn_19_sent_at=NULL WHERE id=$1', [req.user.userId]);
        if (freshCount < 15) await q('UPDATE users SET limit_warn_15_sent_at=NULL WHERE id=$1', [req.user.userId]);
      } catch(e) {}
    })();
    const r = await q(`UPDATE items SET name=$1,metal=$2,type=$3,grade_name=$4,purity=$5,grams=$6,notes=$7,purchase_date=$8,price_paid=$9,price_paid_curr=$10,price_paid_usd=$11,receipt=$12,sold=$13,sell_price=$14,sell_currency=$15,sell_price_usd=$16,sell_date=$17,sell_notes=$18,held_by=$19,nominee=$20,making_charge=$21,making_charge_currency=$22,gold_cost_basis_usd=$23,photos=$24,received_as_gift=$25,gifted=$26,gifted_to=$27,gifted_at=$28,gift_notes=$29,gift_value_usd=$30,gift_gain_usd=$31,updated_at=NOW() WHERE id=$32 AND user_id=$33 RETURNING *`,
      [encryptField(d.name), d.metal, d.type, encryptField(d.gradeName), d.purity, d.grams,
       d.notes?encryptField(d.notes):null, d.purchaseDate||null,
       d.pricePaid||null, d.pricePaidCurrency||'USD', d.pricePaidUSD||null, d.receipt||null, !!d.sold,
       d.sellPrice||null, d.sellCurrency||null, d.sellPriceUSD||null, d.sellDate||null,
       d.sellNotes?encryptField(d.sellNotes):null,
       d.heldBy||null, d.nominee||null,
       d.makingCharge||null, d.makingChargeCurrency||null, d.goldCostBasisUSD||null,
       d.photos?JSON.stringify(d.photos):null,
       d.receivedAsGift||false,
       !!d.gifted, d.giftTo||null, d.giftDate||null,
       d.giftNotes?encryptField(d.giftNotes):null,
       d.giftValueUSD||null, d.giftGainUSD||null,
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
  if (!['gold','silver','platinum'].includes(metal)) return res.status(400).json({ error:'Invalid metal' });
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
      'UPDATE alerts SET fired=TRUE, fired_at=NOW() WHERE id=$1 AND user_id=$2 AND fired=FALSE RETURNING *',
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


app.patch('/api/alerts/:id/rearm', requireAuth, async (req, res) => {
  try {
    const r = await q(
      'UPDATE alerts SET fired=FALSE, fired_at=NULL WHERE id=$1 AND user_id=$2 RETURNING *',
      [req.params.id, req.user.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error:'Alert not found' });
    res.json(alertToClient(r.rows[0]));
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.delete('/api/alerts/fired', requireAuth, async (req, res) => {
  try {
    await q('DELETE FROM alerts WHERE user_id=$1 AND fired=TRUE', [req.user.userId]);
    res.json({ ok:true });
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
    res.json({ token, isNewUser, user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, age: u.age, country: u.country, preferred_currency: u.preferred_currency||null, joinedAt: u.created_at, emailVerified: true } });
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
      const bLabel = isIndia ? 'India Bullion' : 'COMEX';
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
          // Match app formula: oz * spotUSD * INR * 1.054
          val = oz * (m === 'gold' ? priceCache.gold : priceCache.silver) * priceCache.usd_inr * 1.054;
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
            lastVal = oz * lastSpot * priceCache.usd_inr * 1.054;
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
        ? `₹${Math.round(priceCache.gold / 31.1035 * 10 * priceCache.usd_inr * 1.054).toLocaleString('en-IN')}/10g (India Bullion)`
        : `$${priceCache.gold.toFixed(2)}/oz (COMEX)`;
      const silverSpotStr = isMCX
        ? `₹${Math.round(priceCache.silver / 31.1035 * 10 * priceCache.usd_inr * 1.054).toLocaleString('en-IN')}/10g (India Bullion)`
        : `$${priceCache.silver.toFixed(2)}/oz (COMEX)`;
      const platinumSpotStr = isMCX
        ? `₹${Math.round((priceCache.platinum||980) / 31.1035 * 10 * priceCache.usd_inr).toLocaleString('en-IN')}/10g (COMEX)`
        : `$${(priceCache.platinum||980).toFixed(2)}/oz (COMEX)`;

      // Timestamp
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
      const timeStr = now.toLocaleTimeString('en-IN', { hour:'numeric', minute:'2-digit', hour12:true, timeZone:'Asia/Kolkata' });
      const asOf = `${dateStr}, ${timeStr} IST`;

      // Subject
      const subject = 'Your vault this week';

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
        const spotStr = m === 'gold' ? goldSpotStr : m === 'silver' ? silverSpotStr : platinumSpotStr;
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

      const changeHTML = "";

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
      Prices are indicative spot rates. MyAurum is a personal record tool, not a financial advisor. Values do not constitute a valuation for insurance, legal, or tax purposes. Values will differ from jeweller buyback prices and do not constitute a valuation for insurance, legal, or tax purposes.
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


      const metalText = metalOrder.map(m => {
        const d = metalData[m];
        const wkChange = metalSpotChange[m];
        const wkStr = wkChange !== undefined ? ` · spot ${wkChange >= 0 ? '+' : ''}${wkChange.toFixed(1)}% this week` : '';
        const spotStr = m === 'gold' ? goldSpotStr : m === 'silver' ? silverSpotStr : platinumSpotStr;
        return `${(metalLabels[m]||m).toUpperCase()}: ${formatVal(d.valueDisp, isMCX, sym)} · ${d.grams.toFixed(2)}g${spotStr ? '\nSpot: ' + spotStr + wkStr : ''}`;
      }).join('\n\n');

      const text = [
        `Hi ${user.first_name},`,
        '',
        `Your MyAurum vault · ${asOf}`,
        '',
        `PORTFOLIO TOTAL: ${formatVal(totalValue, isMCX, sym)}`,
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
    let rows;
    if (req.query.from) {
      // Fetch from a specific date to now
      rows = await q(
        `SELECT gold, silver, platinum, recorded_at FROM price_history
         WHERE recorded_at >= $1
         ORDER BY recorded_at ASC`,
        [req.query.from]
      );
    } else {
      const days = Math.min(parseInt(req.query.days) || 30, 3650);
      rows = await q(
        `SELECT gold, silver, platinum, recorded_at FROM price_history
         WHERE recorded_at > NOW() - ($1 || ' days')::INTERVAL
         ORDER BY recorded_at ASC`,
        [days]
      );
    }
    // Deduplicate to one record per day (prefer daily records, else last intraday)
    const byDay = {};
    for (const r of rows.rows) {
      const day = r.recorded_at.toISOString().slice(0, 10);
      if (!byDay[day] || r.is_daily) byDay[day] = r;
    }
    res.json(Object.values(byDay).sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────
//  WEB PUSH
// ─────────────────────────────────────────
// Serve the push ServiceWorker as a real file (blob URLs are not supported for SW registration)
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`self.addEventListener('push',e=>{const d=e.data?e.data.json():{};e.waitUntil(self.registration.showNotification(d.title||'MyAurum Alert',{body:d.body||'',icon:'/favicon.ico',badge:'/favicon.ico',tag:'myaurum-alert',data:{url:d.url||'/'}}))});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.openWindow(e.notification.data.url||'/'))});`);
});

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


// ─────────────────────────────────────────
//  IMPRESSION TRACKING
// ─────────────────────────────────────────

const BOT_PATTERNS = /bot|crawl|spider|slurp|mediapartners|adsbot|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|curl|wget|python-requests|axios|go-http|java\/|okhttp|apache-httpclient/i;

function detectUAType(ua) {
  if (!ua) return 'unknown';
  if (BOT_PATTERNS.test(ua)) return 'bot';
  if (/mobile|android|iphone|ipad|ipod/i.test(ua)) return 'mobile';
  if (/tablet/i.test(ua)) return 'tablet';
  return 'desktop';
}

function extractRefDomain(ref) {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

function geoLookup(ip) {
  return new Promise(resolve => {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
      return resolve({ country: 'Local', city: null });
    }
    const opts = {
      hostname: 'ip-api.com',
      path: `/json/${ip}?fields=country,city,status`,
      method: 'GET',
      timeout: 3000,
    };
    const req = https.get(opts, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const d = JSON.parse(buf);
          if (d.status === 'success') resolve({ country: d.country || null, city: d.city || null });
          else resolve({ country: null, city: null });
        } catch { resolve({ country: null, city: null }); }
      });
    });
    req.on('error', () => resolve({ country: null, city: null }));
    req.on('timeout', () => { req.destroy(); resolve({ country: null, city: null }); });
  });
}

// 1×1 transparent GIF bytes
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /px?s=slug&r=referrer
app.get('/px', async (req, res) => {
  // Serve the pixel immediately — tracking is fire-and-forget
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(PIXEL_GIF);

  // Async tracking — never blocks the response
  setImmediate(async () => {
    try {
      const slug = (req.query.s || '').slice(0, 200).replace(/[^a-z0-9-_\/]/gi, '');
      if (!slug) return;
      const referrer  = (req.query.r || '').slice(0, 500) || null;
      const refDomain = extractRefDomain(referrer);
      const ua        = req.headers['user-agent'] || '';
      const uaType    = detectUAType(ua);
      const isBot     = uaType === 'bot';
      const ip        = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
      const { country, city } = await geoLookup(ip);

      await q(
        `INSERT INTO page_views (slug, referrer, ref_domain, country, city, ua_type, is_bot) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [slug, referrer, refDomain, country, city, uaType, isBot]
      );
    } catch(e) { console.error('[px]', e.message); }
  });
});

app.get('/blog', (req, res) => {
  const p = path.join(__dirname, 'blog', 'index.html');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(p); return; }
  // Generate index from _index.json when index.html not deployed
  const idxFile = path.join(__dirname, 'blog', '_index.json');
  const articles = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile,'utf8')) : [];
  const GEO_LABEL = { india:'🇮🇳 India', uae:'🇦🇪 UAE', ny:'🗽 New York', intl:'🌐 Global' };
  const GEO_COLOR = { india:'#8B6914', uae:'#2E6B8A', ny:'#5A3B7A', intl:'#3A6B4A' };
  const GEO_BG    = { india:'rgba(139,105,20,.10)', uae:'rgba(46,107,138,.10)', ny:'rgba(90,59,122,.10)', intl:'rgba(58,107,74,.10)' };
  const cards = articles.map(a => `
    <a class="card" href="/blog/${a.slug}" data-geo="${a.geo}">
      <div class="card-meta">
        <span class="geo-tag" style="background:${GEO_BG[a.geo]||GEO_BG.india};color:${GEO_COLOR[a.geo]||GEO_COLOR.india}">${GEO_LABEL[a.geo]||a.geo}</span>
        ${a.category ? `<span class="cat-tag">${a.category}</span>` : ''}
        <span class="card-date">${a.date||''}</span>
      </div>
      <h2 class="card-title">${a.headline}</h2>
      <p class="card-excerpt">${a.excerpt||''}</p>
      <span class="card-read">Read article \u2192</span>
    </a>`).join('');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MyAurum Journal \u2014 Gold Intelligence</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root{--gold-dim:#8B6914;--parchment:#F5F0E8;--ink:#2C2410;--ink-dim:#8B7A5A;--border:rgba(139,105,20,.18)}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--parchment);font-family:'Jost',sans-serif;color:var(--ink)}
  .wrap{max-width:900px;margin:0 auto;padding:0 24px 80px}
  .topnav{display:flex;align-items:center;justify-content:space-between;padding:20px 0;margin-bottom:40px;border-bottom:1px solid var(--border)}
  .nav-brand{font-family:'Cormorant Garamond',serif;font-size:18px;color:var(--gold-dim);text-decoration:none}
  .nav-home{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);text-decoration:none;padding:8px 16px;border:1px solid var(--border);border-radius:20px}
  .nav-home:hover{border-color:var(--gold-dim);color:var(--gold-dim)}
  .header{margin-bottom:36px}
  .header-title{font-family:'Cormorant Garamond',serif;font-size:clamp(32px,6vw,48px);font-weight:300;line-height:1.1;letter-spacing:-.02em;margin-bottom:10px}
  .header-sub{font-size:14px;color:var(--ink-dim);line-height:1.7;max-width:560px}
  .articles{display:grid;gap:20px}
  @media(min-width:640px){.articles{grid-template-columns:1fr 1fr}.card:first-child{grid-column:span 2}}
  .card{background:#fff;border:1.5px solid var(--border);border-radius:14px;padding:26px;text-decoration:none;display:block;color:inherit;transition:box-shadow .2s,transform .18s}
  .card:hover{box-shadow:0 8px 28px rgba(139,105,20,.12);transform:translateY(-2px)}
  .card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .geo-tag{font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:10px;font-weight:500}
  .cat-tag{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);opacity:.7}
  .card-date{font-size:10px;color:var(--ink-dim);opacity:.6;margin-left:auto}
  .card-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:400;line-height:1.25;margin-bottom:10px;letter-spacing:-.01em}
  .card:first-child .card-title{font-size:28px}
  .card-excerpt{font-size:13px;color:var(--ink-dim);line-height:1.75;margin-bottom:14px}
  .card-read{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-dim);font-weight:500}
  .empty{text-align:center;padding:60px 0;color:var(--ink-dim);font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <nav class="topnav">
    <a class="nav-brand" href="https://myaurum.app">MyAurum</a>
    <a class="nav-home" href="https://myaurum.app">Track your gold \u2192</a>
  </nav>
  <div class="header">
    <div style="font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:10px;opacity:.7">MyAurum Journal</div>
    <h1 class="header-title">Gold intelligence,<br>sourced and verified</h1>
    <p class="header-sub">Current reporting on gold buying, retail practices, scams, and market conditions across India, UAE, and New York.</p>
  </div>
  <div class="articles">
    ${cards || '<div class="empty">No articles published yet.</div>'}
  </div>
</div>
</body>
</html>`;
  res.setHeader('Cache-Control','no-cache,no-store,must-revalidate');
  res.type('html').send(html);
});

app.get('/blog/:slug', (req, res) => {
  const p = path.join(__dirname, 'blog', req.params.slug + '.html');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(p); }
  else res.status(404).redirect('/blog');
});

app.get('/gold', (req, res) => {
  const p = path.join(__dirname, 'gold.html');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(p); }
  else res.status(404).send('Not found');
});

app.get('/terms', (req, res) => {
  const termsPath = path.join(__dirname, 'terms.html');
  if (fs.existsSync(termsPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(termsPath); }
  else res.status(404).send('Terms not found');
});

// ─────────────────────────────────────────
//  ESTATE NOTES (CLIENT-ENCRYPTED)
// ─────────────────────────────────────────

app.get('/api/vault-notes', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT vault_notes FROM users WHERE id=$1', [req.user.userId]);
    const raw = r.rows[0]?.vault_notes;
    if (!raw) return res.json({ notes: [] });
    // Notes are client-side encrypted — serve without server-side decryption
    let notes;
    try {
      notes = JSON.parse(raw); // new format: plain JSON array of client-encrypted notes
    } catch(e) {
      try { notes = JSON.parse(decryptField(raw)); } // legacy: server-side encrypted
      catch(e2) { notes = []; }
    }
    res.json({ notes });
  } catch(e) {
    console.error('[vault-notes] GET error:', e.message);
    res.json({ notes: [] });
  }
});

app.post('/api/vault-notes', requireAuth, async (req, res) => {
  const { notes } = req.body;
  if (!Array.isArray(notes) || notes.length > 10) {
    return res.status(400).json({ error: 'Invalid notes — max 10 entries' });
  }
  // Validate each entry
  for (const n of notes) {
    if (!n.label || typeof n.label !== 'string' || !n.value || typeof n.value !== 'string') {
      return res.status(400).json({ error: 'Each note must have a label and value' });
    }
    if (n.label.length > 60) return res.status(400).json({ error: 'Label must be 60 characters or fewer' });
    // Value may be client-side encrypted (vlt:v1: prefix) — only limit plaintext values
    if (!n.value.startsWith('vlt:v1:') && n.value.length > 300) {
      return res.status(400).json({ error: 'Value must be 300 characters or fewer' });
    }
  }
  try {
    // Store as plain JSON — values are already client-side encrypted
    await q('UPDATE users SET vault_notes=$1 WHERE id=$2', [JSON.stringify(notes), req.user.userId]);
    res.json({ ok: true });
  } catch(e) {
    console.error('[vault-notes] POST error:', e.message);
    res.status(500).json({ error: 'Could not save notes' });
  }
});

// ─────────────────────────────────────────
//  NOMINEES
// ─────────────────────────────────────────
app.get('/api/custodians', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM nominees WHERE user_id=$1 ORDER BY created_at ASC', [req.user.userId]);
    res.json(r.rows.map(n => ({ id: n.id, name: n.name, email: n.email, createdAt: n.created_at })));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/custodians', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email || !email.includes('@')) return res.status(400).json({ error: 'Name and valid email required' });
  try {
    const r = await q(
      'INSERT INTO nominees (user_id, name, email) VALUES ($1,$2,$3) ON CONFLICT (user_id, email) DO UPDATE SET name=$2 RETURNING *',
      [req.user.userId, name.trim(), email.toLowerCase().trim()]
    );
    res.status(201).json({ id: r.rows[0].id, name: r.rows[0].name, email: r.rows[0].email });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/custodians/:id', requireAuth, async (req, res) => {
  try {
    const r = await q('DELETE FROM nominees WHERE id=$1 AND user_id=$2', [req.params.id, req.user.userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Nominee not found' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────
//  DEAD MAN'S SWITCH
// ─────────────────────────────────────────
app.get('/api/deadmans-switch', requireAuth, async (req, res) => {
  try {
    const r = await q('SELECT * FROM deadmans_switch WHERE user_id=$1', [req.user.userId]);
    const row = r.rows[0];
    if (!row) return res.json({ enabled: false, periodDays: 90, lastWarnedAt: null, firedAt: null });
    res.json({ enabled: row.enabled, periodDays: row.period_days, lastWarnedAt: row.last_warned_at, firedAt: row.fired_at });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/deadmans-switch', requireAuth, async (req, res) => {
  const { enabled, periodDays } = req.body;
  const valid = [60, 90, 180, 360];
  if (!valid.includes(periodDays)) return res.status(400).json({ error: 'Period must be 60, 90, 180, or 360 days' });
  try {
    await q(`
      INSERT INTO deadmans_switch (user_id, enabled, period_days, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id) DO UPDATE SET enabled=$2, period_days=$3, updated_at=NOW()
    `, [req.user.userId, !!enabled, periodDays]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Called from index.html when user saves decrypted notes for nominee delivery
app.post('/api/estate-notes/store-decrypted', requireAuth, async (req, res) => {
  const { notes } = req.body;
  if (!Array.isArray(notes)) return res.status(400).json({ error: 'Invalid notes' });
  try {
    // Server-side encrypt the decrypted copy for storage
    const encrypted = encryptField(JSON.stringify(notes));
    await q('UPDATE users SET estate_notes_decrypted=$1 WHERE id=$2', [encrypted, req.user.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// Nominee access view — one-time token
app.get('/nominee/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, JWT_SECRET);
    if (payload.type !== 'nominee_access') return res.status(403).send('Invalid link');
    const ur = await q('SELECT * FROM users WHERE id=$1', [payload.userId]);
    const u = ur.rows[0];
    if (!u) return res.status(404).send('Not found');
    const nominees = await q('SELECT * FROM nominees WHERE user_id=$1', [u.id]);
    const nominee = nominees.rows.find(n => n.id === payload.nomineeId);
    if (!nominee) return res.status(403).send('Access revoked');
    // Decrypt stored plaintext copy
    let notes = [];
    if (u.estate_notes_decrypted) {
      try { notes = JSON.parse(decryptField(u.estate_notes_decrypted)); } catch(e) { notes = []; }
    }
    const CAT_ICONS = { bank:'🏦', safe:'🔐', lawyer:'⚖️', will:'📋', insurance:'🛡️', emergency:'🆘', ca:'🧾', other:'📁' };
    const CAT_LABELS = { bank:'Bank Locker', safe:'Safe', lawyer:'Lawyer', will:'Will', insurance:'Insurance', emergency:'Emergency', ca:'CA / Tax', other:'Other' };
    const noteRows = notes.length ? notes.map(n => `
      <div style="background:#fff;border:1.5px solid #E8E0D0;border-radius:12px;padding:18px 20px;margin-bottom:10px">
        <div style="font-size:11px;color:#8B6914;font-family:Arial,sans-serif;margin-bottom:6px;font-weight:500">
          ${CAT_ICONS[n.category]||'📁'} ${n.label||CAT_LABELS[n.category]||n.category}
        </div>
        <div style="font-size:15px;color:#2C2410;font-family:Georgia,serif;line-height:1.6;word-break:break-word">${(n.value||'').replace(/</g,'&lt;')}</div>
      </div>`).join('') : `<p style="color:#999;font-size:13px;font-family:Arial,sans-serif">No estate notes have been recorded.</p>`;
    const now = new Date();
    const asOf = now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${u.first_name} ${u.last_name}'s Estate Notes — MyAurum</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='40' fill='%23F5F0E8'/><circle cx='76' cy='96' r='36' fill='none' stroke='%238B6914' stroke-width='12'/><circle cx='116' cy='96' r='36' fill='none' stroke='%238B6914' stroke-width='12'/></svg>">
</head><body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,serif">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
  <div style="font-family:Georgia,serif;font-size:13px;font-weight:300;letter-spacing:.2em;color:#B8860B;margin-bottom:32px">MYAURUM</div>
  <h1 style="font-family:Georgia,serif;font-size:32px;font-weight:300;color:#2C2410;margin:0 0 6px">${u.first_name} ${u.last_name}'s Estate Notes</h1>
  <p style="font-size:12px;color:#999;font-family:Arial,sans-serif;margin:0 0 32px">Shared with ${nominee.name} · ${asOf}</p>
  <div style="background:#FDF5E0;border:1px solid #E8D8A0;border-radius:10px;padding:14px 18px;margin-bottom:28px;font-size:12px;color:#8B6914;font-family:Arial,sans-serif;line-height:1.7">
    This is a private document. Please handle it with care and share it only with those who need it.
  </div>
  ${noteRows}
  <p style="font-size:10px;color:#CCC;font-family:Arial,sans-serif;margin-top:32px;line-height:1.7">Generated by MyAurum · myaurum.app<br>This link was shared by ${u.first_name} ${u.last_name}.</p>
</div></body></html>`);
  } catch(e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(403).send('This link has expired or is invalid.');
    console.error('[nominee-view]', e.message);
    res.status(500).send('Something went wrong.');
  }
});

// ─────────────────────────────────────────
//  RAZORPAY PAYMENTS
// ─────────────────────────────────────────

// Create subscription
app.post('/api/payment/create-subscription', requireAuth, async (req, res) => {
  if (RZP_KEY_ID === 'rzp_test_placeholder') {
    return res.status(503).json({ error: 'Payment gateway not configured yet. Please check back soon.' });
  }
  const requestedTier = req.body.tier === 'super' ? 'super' : 'standard';
  try {
    const userRes = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = userRes.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const isPremium = !!u.is_premium && (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());
    // Super Premium only available to existing premium subscribers
    if (requestedTier === 'super' && !isPremium) {
      return res.status(400).json({ error: 'Super Premium is available to existing Premium subscribers only.' });
    }
    // Block new standard subscription if already premium standard
    if (requestedTier === 'standard' && isPremium && u.premium_tier !== 'super') {
      return res.status(400).json({ error: 'Already a Premium member.' });
    }

    // Create or retrieve Razorpay customer
    let customerId = u.razorpay_customer_id;
    if (!customerId) {
      const custResp = await razorpayRequest('POST', '/customers', {
        name: `${u.first_name} ${u.last_name}`.trim(),
        email: u.email,
        fail_existing: 0,
      });
      customerId = custResp.id;
      await q('UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', [customerId, u.id]);
    }

    // Create subscription
    const sub = await razorpayRequest('POST', '/subscriptions', {
      plan_id: RZP_PLAN_ID,
      customer_notify: 1,
      quantity: 1,
      total_count: 12, // up to 12 years
      customer_id: customerId,
      addons: [],
      notes: { user_id: String(u.id), email: u.email },
    });

    res.json({
      subscriptionId: sub.id,
      keyId: RZP_KEY_ID,
      name: 'MyAurum Premium',
      description: '₹600/year · Cancel anytime · Access continues until period end',
      prefill: { name: `${u.first_name} ${u.last_name}`.trim(), email: u.email },
    });
  } catch(e) {
    console.error('[payment] create-subscription error:', e.message);
    res.status(500).json({ error: 'Could not create subscription. Please try again.' });
  }
});


// ── Upgrade Premium → Super Premium (pro-rata) ──
app.post('/api/payment/upgrade-to-super', requireAuth, async (req, res) => {
  if (RZP_KEY_ID === 'rzp_test_placeholder') {
    return res.status(503).json({ error: 'Payment gateway not configured yet.' });
  }
  try {
    const userRes = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = userRes.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const isPremium = !!u.is_premium && (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());
    if (!isPremium) return res.status(400).json({ error: 'You must be a Premium subscriber to upgrade.' });
    if (u.premium_tier === 'super') return res.status(400).json({ error: 'Already on Super Premium.' });

    // ── Pro-rata calculation (integer paise arithmetic to avoid float errors) ──
    const now = new Date();
    const expiresAt = new Date(u.premium_expires_at);
    const totalMs = 365 * 24 * 60 * 60 * 1000; // 1 year in ms
    const remainingMs = Math.max(0, expiresAt - now);
    // Prices in paise (1 INR = 100 paise) — avoids float errors
    const STANDARD_PAISE = 60000;  // ₹600
    const SUPER_PAISE    = 120000; // ₹1200
    // Credit = remaining fraction of standard year, applied to super price
    // credit_paise = floor(STANDARD_PAISE * remainingMs / totalMs)
    const creditPaise = Math.floor(STANDARD_PAISE * remainingMs / totalMs);
    const chargePaise = SUPER_PAISE - creditPaise;
    const chargeINR   = (chargePaise / 100).toFixed(2);

    // Cancel existing standard subscription at Razorpay (no refund, access continues)
    if (u.razorpay_subscription_id && RZP_KEY_ID !== 'rzp_test_placeholder') {
      try {
        await razorpayRequest('POST', `/subscriptions/${u.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 0 });
      } catch(e) { console.warn('[upgrade] Could not cancel old sub:', e.message); }
    }

    // Create new Super Premium subscription
    let customerId = u.razorpay_customer_id;
    if (!customerId) {
      const custResp = await razorpayRequest('POST', '/customers', {
        name: `${u.first_name} ${u.last_name}`.trim(),
        email: u.email,
        fail_existing: 0,
      });
      customerId = custResp.id;
      await q('UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', [customerId, u.id]);
    }

    const sub = await razorpayRequest('POST', '/subscriptions', {
      plan_id: RZP_SUPER_PLAN_ID,
      customer_notify: 1,
      quantity: 1,
      total_count: 12,
      customer_id: customerId,
      addons: [],
      notes: { user_id: String(u.id), email: u.email, tier: 'super', upgraded_from: 'standard' },
    });

    res.json({
      subscriptionId: sub.id,
      keyId: RZP_KEY_ID,
      name: 'MyAurum Super Premium',
      description: `₹${chargeINR} due today (₹1,200/yr less ₹${(creditPaise/100).toFixed(2)} credit for remaining Premium days)`,
      prefill: { name: `${u.first_name} ${u.last_name}`.trim(), email: u.email },
      tier: 'super',
      creditINR: (creditPaise / 100).toFixed(2),
      chargeINR,
    });
  } catch(e) {
    console.error('[upgrade-to-super] error:', e.message);
    res.status(500).json({ error: 'Could not process upgrade. Please try again.' });
  }
});

// Verify payment after checkout
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
  try {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', RZP_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    // Determine tier from subscription notes
    let verifyTier = 'standard';
    try {
      const subDetails = await razorpayRequest('GET', `/subscriptions/${razorpay_subscription_id}`, null);
      if (subDetails.notes && subDetails.notes.tier === 'super') verifyTier = 'super';
    } catch(e) { /* default to standard */ }
    await q(`UPDATE users SET is_premium=TRUE, premium_since=NOW(), premium_expires_at=$1, razorpay_subscription_id=$2, premium_tier=$3 WHERE id=$4`,
      [expires, razorpay_subscription_id, verifyTier, req.user.userId]);
    console.log(`[payment] ${verifyTier} activated for user ${req.user.userId}`);
    res.json({ ok: true, premiumExpiresAt: expires, premiumTier: verifyTier });
  } catch(e) {
    console.error('[payment] verify error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Cancel subscription
app.post('/api/payment/cancel', requireAuth, async (req, res) => {
  try {
    const userRes = await q('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u = userRes.rows[0];
    if (!u?.razorpay_subscription_id) return res.status(400).json({ error: 'No active subscription found' });
    if (RZP_KEY_ID !== 'rzp_test_placeholder') {
      await razorpayRequest('POST', `/subscriptions/${u.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 1 });
    }
    // Access continues until premium_expires_at — just stop auto-renew
    await q('UPDATE users SET razorpay_subscription_id=NULL WHERE id=$1', [req.user.userId]);
    console.log(`[payment] Subscription cancelled for user ${req.user.userId}`);
    res.json({ ok: true, message: 'Subscription cancelled. Your premium access continues until the end of your current billing period.' });
  } catch(e) {
    console.error('[payment] cancel error:', e.message);
    res.status(500).json({ error: 'Could not cancel subscription. Please try again.' });
  }
});

// Razorpay webhook
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const sig = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(req.body).digest('hex');
    if (expected !== sig) return res.status(400).send('Invalid signature');

    const event = JSON.parse(req.body.toString());
    const { event: eventType, payload } = event;

    if (eventType === 'subscription.charged') {
      const sub = payload.subscription.entity;
      const userId = sub.notes?.user_id;
      if (userId) {
        const expires = new Date();
        expires.setFullYear(expires.getFullYear() + 1);
        const whTier = sub.notes?.tier === 'super' ? 'super' : 'standard';
        await q('UPDATE users SET is_premium=TRUE, premium_expires_at=$1, premium_tier=$2 WHERE id=$3', [expires, whTier, userId]);
        console.log(`[webhook] subscription.charged — user ${userId} (${whTier}) renewed until ${expires.toISOString()}`);
      }
    } else if (eventType === 'subscription.cancelled' || eventType === 'subscription.halted') {
      const sub = payload.subscription.entity;
      const userId = sub.notes?.user_id;
      if (userId) {
        // Don't revoke immediately — let premium_expires_at handle it
        await q('UPDATE users SET razorpay_subscription_id=NULL WHERE id=$1', [userId]);
        console.log(`[webhook] ${eventType} — user ${userId} subscription ended`);
      }
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[webhook] error:', e.message);
    res.status(500).send('Error');
  }
});

// Razorpay API helper
function razorpayRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64');
    const data = JSON.stringify(body || {});
    const opts = {
      hostname: 'api.razorpay.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, r => {
      let buf = '';
      r.on('data', d => buf += d);
      r.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          if (r.statusCode >= 400) reject(new Error(parsed.error?.description || `HTTP ${r.statusCode}`));
          else resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

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

    const isMCX = !u.country || (u.country||'').toLowerCase() === 'india';
    const sym = isMCX ? '₹' : '$';

    function spotVal(metal, grams, purity) {
      const oz = grams * purity / 31.1035;
      if (isMCX && metal !== 'platinum') {
        // Match app formula: oz * spotUSD * INR * 1.054
        return oz * (metal === 'gold' ? gold : silver) * usdInr * 1.054;
      }
      // Platinum and non-MCX: convert to INR if isMCX, else keep in USD
      const spotUSD = metal === 'gold' ? gold : metal === 'silver' ? silver : (priceCache.platinum||980);
      return isMCX ? oz * spotUSD * usdInr : oz * spotUSD;
    }

    function fmtVal(v) {
      if (isMCX) return '₹' + Math.round(v).toLocaleString('en-IN');
      return '$' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    }

    const total = items.reduce((s,i) => s + spotVal(i.metal, i.grams, i.purity), 0);
    const now = new Date();
    const userTz = isMCX ? 'Asia/Kolkata' : (u.country === 'UAE' ? 'Asia/Dubai' : 'America/New_York');
    const tzLabel = isMCX ? 'IST' : (u.country === 'UAE' ? 'GST' : 'ET');
    const asOf = now.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:userTz}) + ', ' +
      now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:userTz}) + ' ' + tzLabel;

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
      const groupItems = metalGroups[metal];
      const groupGrams = groupItems.reduce((s,i) => s + i.grams, 0);
      const groupVal = groupItems.reduce((s,i) => s + spotVal(i.metal, i.grams, i.purity), 0);
      tableRows += `<tr><td colspan="4" style="background:#F5EDD0;font-size:10px;letter-spacing:.14em;color:#8B6914;font-weight:600;padding:7px 12px;text-transform:uppercase">
        <span>${metalLabels[metal]}</span>
        <span style="float:right;font-weight:400;color:#A08040">${groupGrams.toFixed(2)}g &nbsp;·&nbsp; ${fmtVal(groupVal)}</span>
      </td></tr>`;
      groupItems.forEach(item => {
        const v = spotVal(item.metal, item.grams, item.purity);
        tableRows += `<tr style="border-bottom:1px solid #EDE8DA">
          <td style="padding:10px 12px;font-size:13px;color:#2C2410;word-break:break-word">${item.name}</td>
          <td style="padding:10px 12px;font-size:12px;color:#8B6914;text-align:center;white-space:nowrap">${item.gradeName.split(' — ')[0]}</td>
          <td style="padding:10px 12px;font-size:12px;color:#555;text-align:center;white-space:nowrap">${item.grams.toFixed(2)}g</td>
          <td style="padding:10px 12px;font-size:13px;color:#2C2410;font-weight:500;text-align:right;white-space:nowrap">${fmtVal(v)}</td>
        </tr>`;
      });
    });

    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${u.first_name}'s Portfolio — MyAurum</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='40' fill='%23F5F0E8'/><circle cx='76' cy='96' r='36' fill='none' stroke='%238B6914' stroke-width='12'/><circle cx='116' cy='96' r='36' fill='none' stroke='%238B6914' stroke-width='12'/></svg>">
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
@media(max-width:600px){
  .total-val{font-size:26px}
  .hero{padding:24px 16px 16px}
  .content{padding:0 16px 40px}
  table{font-size:12px}
  th,td{padding:8px 8px !important;font-size:11px !important}
  .owner{font-size:21px}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
}
</style>
</head><body>
<div class="header">
  <a href="/" class="logo">MYAURUM</a>
  <span class="badge"><span class="live-dot"></span>Live portfolio</span>
</div>
<div class="hero">
  <div class="owner">${u.first_name} ${u.last_name}'s Holdings</div>
  <div class="asof">As of ${asOf} &nbsp;·&nbsp; ${isMCX ? 'India Bullion benchmark' : 'COMEX benchmark'}</div>
  <div class="total-card">
    <div>
      <div class="total-label">Portfolio Value</div>
      <div class="total-val">${fmtVal(total)}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#B8A070;margin-bottom:4px">${items.length} holding${items.length!==1?'s':''}</div>
      <div style="font-size:11px;color:#8B6914;display:flex;align-items:center;gap:8px">Prices update live &nbsp;<button onclick="window.location.reload()" style="background:rgba(184,134,11,.1);border:1.5px solid rgba(184,134,11,.5);border-radius:20px;padding:4px 12px;font-size:11px;color:#8B6914;cursor:pointer;font-family:Arial,sans-serif;letter-spacing:.06em;font-weight:600">↻ Refresh</button></div>
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
    Values are indicative estimates at live spot prices. Not financial advice. Does not constitute a valuation for insurance, legal, or tax purposes.
  </div>
</div>
<div class="footer">
  <p>This portfolio is shared via MyAurum &nbsp;·&nbsp; <a href="/">myaurum.app</a></p>
  <p style="margin-top:4px;opacity:.7">© 2026 MyAurum. All rights reserved.</p>
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
// TEMP: IP debug — remove after fixing admin access
app.get('/myip', (req, res) => {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const socket = req.socket.remoteAddress || '';
  res.json({ forwarded, socket, first: forwarded.split(',')[0].trim(), adminIp: ADMIN_IP });
});



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
  console.log('[admin]', req.method, req.path, 'ip:', ip, 'adminIp:', ADMIN_IP, 'match:', ip===ADMIN_IP);
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

// ─────────────────────────────────────────
//  BLOG EDITOR API
// ─────────────────────────────────────────

const BLOG_DIR = path.join(__dirname, 'blog');

// Ensure blog dir exists
if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });

// Geo tag colours matching blog CSS
const GEO_STYLES = {
  india: { label: '🇮🇳 India',    color: '#8B6914', bg: 'rgba(139,105,20,.10)' },
  uae:   { label: '🇦🇪 UAE',      color: '#2E6B8A', bg: 'rgba(46,107,138,.10)' },
  ny:    { label: '🗽 New York',  color: '#5A3B7A', bg: 'rgba(90,59,122,.10)'  },
  intl:  { label: '🌐 Global',    color: '#3A6B4A', bg: 'rgba(58,107,74,.10)'  },
};

// Generate article HTML from fields
function buildArticleHTML({ slug, headline, geo, category, body, imageBase64, imageCaption, date }) {
  const geoStyle = GEO_STYLES[geo] || GEO_STYLES.india;
  const dateStr  = date || new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  const imgBlock = imageBase64
    ? `<figure style="margin:0 0 28px;border-radius:12px;overflow:hidden">
        <img src="${imageBase64}" alt="${escapeHtml(headline)}" style="width:100%;display:block;max-height:400px;object-fit:cover">
        ${imageCaption ? `<figcaption style="font-size:11px;color:#8B7A5A;padding:8px 0;font-family:'Jost',sans-serif;font-style:italic">${escapeHtml(imageCaption)}</figcaption>` : ''}
       </figure>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(headline)} — MyAurum Journal</title>
<meta name="description" content="${escapeHtml(headline)}">
<meta property="og:title" content="${escapeHtml(headline)} — MyAurum Journal">
<meta property="og:image" content="https://myaurum.app/og-image.png">
<link rel="canonical" href="https://myaurum.app/blog/${slug}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(headline)},"datePublished":"${new Date().toISOString().slice(0,10)}","publisher":{"@type":"Organization","name":"MyAurum","url":"https://myaurum.app"}}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root{--gold:#B8860B;--gold-dim:#8B6914;--parchment:#F5F0E8;--ink:#2C2410;--ink-mid:#5A4A2A;--ink-dim:#8B7A5A;--border:rgba(139,105,20,.18)}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--parchment);font-family:'Jost',sans-serif;color:var(--ink)}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 35% at 50% 0%,rgba(184,134,11,.08) 0%,transparent 70%);pointer-events:none;z-index:0}
  .wrap{position:relative;z-index:1;max-width:680px;margin:0 auto;padding:0 24px 80px}
  .topnav{display:flex;align-items:center;justify-content:space-between;padding:20px 0;margin-bottom:40px;border-bottom:1px solid var(--border)}
  .nav-brand{font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:400;color:var(--gold-dim);text-decoration:none}
  .nav-back{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);text-decoration:none;transition:color .15s}
  .nav-back:hover{color:var(--gold-dim)}
  .article-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px}
  .geo-tag{font-size:9px;letter-spacing:.16em;text-transform:uppercase;padding:4px 10px;border-radius:10px;font-weight:500;background:${geoStyle.bg};color:${geoStyle.color}}
  .cat-tag{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);opacity:.7}
  .art-date{font-size:10px;color:var(--ink-dim);opacity:.6;margin-left:auto}
  h1{font-family:'Cormorant Garamond',serif;font-size:clamp(28px,5vw,42px);font-weight:300;line-height:1.15;color:var(--ink);margin-bottom:28px;letter-spacing:-.02em}
  .article-body{font-size:15px;line-height:1.85;color:var(--ink)}
  .article-body h2{font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:400;color:var(--ink);margin:36px 0 14px;letter-spacing:-.01em}
  .article-body h3{font-size:15px;font-weight:600;color:var(--ink);margin:24px 0 10px}
  .article-body p{margin-bottom:18px}
  .article-body a{color:var(--gold-dim);text-decoration:underline;text-underline-offset:3px}
  .article-body a:hover{color:var(--ink)}
  .article-body ul,.article-body ol{margin:0 0 18px;padding-left:20px;line-height:2}
  .article-body blockquote{border-left:3px solid var(--gold-dim);padding:14px 18px;margin:24px 0;background:rgba(139,105,20,.06);border-radius:0 8px 8px 0;font-style:italic;color:var(--ink-mid)}
  .cta-block{margin:40px 0;padding:24px 26px;background:linear-gradient(135deg,rgba(139,105,20,.08),rgba(184,134,11,.04));border:1.5px solid var(--border);border-radius:14px;text-align:center}
  .cta-block p{font-size:14px;color:var(--ink-mid);line-height:1.75;margin-bottom:16px}
  .cta-btn{display:inline-block;padding:12px 26px;background:var(--gold-dim);color:#FDF8F0;font-family:'Jost',sans-serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;border-radius:8px;margin-right:10px;box-shadow:0 3px 14px rgba(139,105,20,.28);transition:box-shadow .2s}
  .cta-btn:hover{box-shadow:0 5px 22px rgba(139,105,20,.4)}
  .cta-btn-sec{display:inline-block;padding:12px 26px;border:1.5px solid var(--border);color:var(--ink-dim);font-family:'Jost',sans-serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;border-radius:8px;transition:all .18s}
  .cta-btn-sec:hover{border-color:var(--gold-dim);color:var(--gold-dim)}
  .art-footer{margin-top:48px;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .art-footer a{font-size:11px;color:var(--ink-dim);text-decoration:none;letter-spacing:.08em;transition:color .15s}
  .art-footer a:hover{color:var(--gold-dim)}
  .disclaimer{margin-top:20px;font-size:11px;color:var(--ink-dim);line-height:1.7;opacity:.7}
</style>
</head>
<body>
<div class="wrap">
  <nav class="topnav">
    <a class="nav-brand" href="https://myaurum.app">MyAurum</a>
    <a class="nav-back" href="/blog">← Journal</a>
  </nav>
  <div class="article-meta">
    <span class="geo-tag">${geoStyle.label}</span>
    ${category ? `<span class="cat-tag">${escapeHtml(category)}</span>` : ''}
    <span class="art-date">${dateStr}</span>
  </div>
  <h1>${escapeHtml(headline)}</h1>
  ${imgBlock}
  <div class="article-body">${body}</div>
  <div class="cta-block">
    <p>Track the live value of your physical gold — free, private, no KYC required.</p>
    <a class="cta-btn" href="https://myaurum.app">Track your gold free →</a>
    <a class="cta-btn-sec" href="https://myaurum.app/gold">Quick calculator</a>
  </div>
  <footer class="art-footer">
    <a href="/blog">← All articles</a>
    <a href="https://myaurum.app">myaurum.app</a>
  </footer>
  <p class="disclaimer">MyAurum Journal articles are sourced from publicly available reporting. This article does not constitute financial or legal advice.</p>
  <img src="/px?s=blog/${slug}&r=" width="1" height="1" alt="" style="display:none;position:absolute">
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Read article index (metadata stored as JSON sidecar)
function readArticleIndex() {
  const p = path.join(BLOG_DIR, '_index.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeArticleIndex(articles) {
  fs.writeFileSync(path.join(BLOG_DIR, '_index.json'), JSON.stringify(articles, null, 2));
}

function rebuildBlogIndex(articles) {
  const GEO_CSS = {
    india:'rgba(139,105,20,.10)',uae:'rgba(46,107,138,.10)',ny:'rgba(90,59,122,.10)',intl:'rgba(58,107,74,.10)'
  };
  const GEO_COLOR = { india:'#8B6914',uae:'#2E6B8A',ny:'#5A3B7A',intl:'#3A6B4A' };
  const GEO_LABEL = { india:'🇮🇳 India',uae:'🇦🇪 UAE',ny:'🗽 New York',intl:'🌐 Global' };

  const cards = articles.map((a, i) => `
    <a class="card" href="/blog/${a.slug}" data-geo="${a.geo}">
      <div class="card-meta">
        <span class="geo-tag ${a.geo}">${GEO_LABEL[a.geo]||a.geo}</span>
        ${a.category ? `<span class="cat-tag">${a.category}</span>` : ''}
        <span class="card-date">${a.date||''}</span>
      </div>
      <h2 class="card-title">${a.headline}</h2>
      <p class="card-excerpt">${a.excerpt||''}</p>
      <span class="card-read">Read article →</span>
    </a>`).join('\n');

  // Read existing index and replace article grid
  const idxPath = path.join(BLOG_DIR, 'index.html');
  if (!fs.existsSync(idxPath)) return;
  let html = fs.readFileSync(idxPath, 'utf8');
  // Replace content between article grid markers
  html = html.replace(
    /(<div class="articles" id="articleGrid">)[\s\S]*?(<div class="empty" id="emptyState">)/,
    `$1\n${cards}\n\n    $2`
  );
  fs.writeFileSync(idxPath, html);
}

// POST — publish article
app.post(`/api/${ADMIN_SLUG}/blog/publish`, requireAdmin, express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const { headline, slug: rawSlug, geo, category, body, imageBase64, imageCaption, excerpt, date } = req.body;
    if (!headline || !body) return res.status(400).json({ error: 'Headline and body are required.' });

    // Sanitise slug
    const slug = (rawSlug || headline)
      .toLowerCase().trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);

    if (!slug) return res.status(400).json({ error: 'Could not generate a valid slug.' });

    const html = buildArticleHTML({ slug, headline, geo: geo||'india', category, body, imageBase64, imageCaption, date });
    const filePath = path.join(BLOG_DIR, slug + '.html');
    fs.writeFileSync(filePath, html);

    // Update index
    const articles = readArticleIndex().filter(a => a.slug !== slug);
    const dateStr = date || new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
    articles.unshift({ slug, headline, geo: geo||'india', category: category||'', excerpt: excerpt||'', date: dateStr });
    writeArticleIndex(articles);
    rebuildBlogIndex(articles);

    console.log(`[blog] Published: ${slug}`);
    res.json({ ok: true, slug, url: `/blog/${slug}` });
  } catch(e) {
    console.error('[blog publish]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET — list articles
app.get(`/api/${ADMIN_SLUG}/blog/articles`, requireAdmin, (req, res) => {
  res.json(readArticleIndex());
});

// DELETE — remove article
app.delete(`/api/${ADMIN_SLUG}/blog/:slug`, requireAdmin, (req, res) => {
  try {
    const slug = req.params.slug.replace(/[^a-z0-9-]/g, '');
    const filePath = path.join(BLOG_DIR, slug + '.html');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const articles = readArticleIndex().filter(a => a.slug !== slug);
    writeArticleIndex(articles);
    rebuildBlogIndex(articles);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/signed-out', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed Out</title>
  <style>body{font-family:Georgia,serif;background:#FAF7F2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;color:#8B6914}.box h2{font-weight:300;letter-spacing:.15em;font-size:22px;margin-bottom:8px}
  .box p{font-family:monospace;font-size:12px;color:#aaa;letter-spacing:.08em}</style></head>
  <body><div class="box"><h2>MYAURUM</h2><p>You have been signed out.</p></div></body></html>`);
});

app.get(`/${ADMIN_SLUG}/blog`, requireAdmin, (req, res) => {
  const p = path.join(__dirname, 'admin-blog.html');
  if (fs.existsSync(p)) {
    let html = fs.readFileSync(p, 'utf8');
    html = html.replace('</head>', `<script>window._adminToken="${adminToken()}";window._adminSlug="${ADMIN_SLUG}";</script></head>`);
    const nav = ``.replace(/SLUG/g, ADMIN_SLUG);
    html = html.replace('<body>', '<body>' + nav);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } else res.status(404).send('Not found');
});

app.get(`/${ADMIN_SLUG}/impressions`, requireAdmin, (req, res) => {
  const p = path.join(__dirname, 'admin-impressions.html');
  if (fs.existsSync(p)) {
    let html = fs.readFileSync(p, 'utf8');
    html = html.replace('</head>', `<script>window._adminToken="${adminToken()}";window._adminSlug="${ADMIN_SLUG}";</script></head>`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } else res.status(404).send('Not found');
});

app.get(`/${ADMIN_SLUG}`, requireAdmin, (req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminPath)) {
    let html = fs.readFileSync(adminPath, 'utf8');
    html = html.replace('</head>', `<script>window._adminToken="${adminToken()}";window._adminSlug="${ADMIN_SLUG}";</script></head>`);
    const adminNav = `<div style="background:#1A1508;padding:12px 24px;display:flex;align-items:center;gap:6px;font-family:monospace"><span style="font-size:11px;letter-spacing:.2em;color:rgba(212,160,23,.6);text-transform:uppercase;margin-right:16px">MyAurum</span><a href="/${ADMIN_SLUG}" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px;border-radius:6px;text-decoration:none;background:rgba(184,134,11,.2);color:rgba(212,160,23,.9)">Dashboard</a><a href="/${ADMIN_SLUG}/blog" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px;border-radius:6px;text-decoration:none;color:rgba(245,240,232,.5)">Blog</a><a href="/${ADMIN_SLUG}/impressions" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px;border-radius:6px;text-decoration:none;color:rgba(245,240,232,.5)">Analytics</a><a href="/${ADMIN_SLUG}/logout" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px;border-radius:6px;text-decoration:none;color:rgba(245,240,232,.3);margin-left:auto">Sign Out</a></div>`;
    html = html.replace('<body>', '<body>' + adminNav);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '-1');
    res.type('html').send(html);
  } else res.status(404).send('Not found');
});


// Impression stats for admin
app.get(`/api/${ADMIN_SLUG}/impressions`, requireAdmin, async (req, res) => {
  try {
    // Total views per slug (humans only), last 30 days default
    const days = parseInt(req.query.days || '30');
    const bySlug = await q(`
      SELECT slug,
        COUNT(*) FILTER (WHERE NOT is_bot) AS views,
        COUNT(*) FILTER (WHERE is_bot)     AS bots,
        MAX(viewed_at)                     AS last_seen
      FROM page_views
      WHERE viewed_at > NOW() - ($1 || ' days')::interval
      GROUP BY slug ORDER BY views DESC LIMIT 50
    `, [days]);

    // Daily views (humans) last 30 days
    const daily = await q(`
      SELECT DATE(viewed_at) AS day, COUNT(*) AS views
      FROM page_views
      WHERE NOT is_bot AND viewed_at > NOW() - ($1 || ' days')::interval
      GROUP BY DATE(viewed_at) ORDER BY day ASC
    `, [days]);

    // Top referrer domains (humans)
    const referrers = await q(`
      SELECT COALESCE(ref_domain, 'direct') AS domain, COUNT(*) AS views
      FROM page_views
      WHERE NOT is_bot AND viewed_at > NOW() - ($1 || ' days')::interval
      GROUP BY ref_domain ORDER BY views DESC LIMIT 20
    `, [days]);

    // Top countries (humans)
    const countries = await q(`
      SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS views
      FROM page_views
      WHERE NOT is_bot AND viewed_at > NOW() - ($1 || ' days')::interval
      GROUP BY country ORDER BY views DESC LIMIT 20
    `, [days]);

    // Device breakdown
    const devices = await q(`
      SELECT ua_type, COUNT(*) AS views
      FROM page_views
      WHERE NOT is_bot AND viewed_at > NOW() - ($1 || ' days')::interval
      GROUP BY ua_type
    `, [days]);

    // All-time totals
    const totals = await q(`
      SELECT COUNT(*) FILTER (WHERE NOT is_bot) AS total_views,
             COUNT(*) FILTER (WHERE is_bot)     AS total_bots,
             COUNT(DISTINCT slug)               AS total_slugs
      FROM page_views
    `);

    res.json({
      bySlug: bySlug.rows,
      daily: daily.rows,
      referrers: referrers.rows,
      countries: countries.rows,
      devices: devices.rows,
      totals: totals.rows[0],
      days,
    });
  } catch(e) { console.error('[impressions]', e.message); res.status(500).json({ error: e.message }); }
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
//  REACTIVATION EMAIL — zero-item users
// ─────────────────────────────────────────
app.post(`/api/${ADMIN_SLUG}/reactivation-email`, requireAdmin, async (req, res) => {
  try {
    // Find users with no items, registered more than 1 day ago
    const users = await q(`
      SELECT u.id, u.email, u.first_name
      FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.user_id = u.id)
      AND u.created_at < NOW() - INTERVAL '1 day'
      AND u.email IS NOT NULL
      ORDER BY u.created_at DESC
    `);

    if (!users.rows.length) {
      return res.json({ sent: 0, message: 'No zero-item users found' });
    }

    const { dryRun } = req.body;
    const results = [];

    for (const user of users.rows) {
      const firstName = user.first_name || 'there';
      const subject = `Quick question`;
      const text = `Hi ${firstName},\n\nYou signed up for MyAurum but never added anything — is there something confusing?\n\nHappy to help.\n\nSatyam\nmyaurum.app`;
      const html = `<div style="font-family:Georgia,serif;font-size:15px;color:#2C2410;line-height:1.8;max-width:480px">
        <p>Hi ${firstName},</p>
        <p>You signed up for MyAurum but never added anything — is there something confusing?</p>
        <p>Happy to help.</p>
        <p>Satyam<br><a href="https://myaurum.app" style="color:#8B6914;text-decoration:none">myaurum.app</a></p>
      </div>`;

      if (dryRun) {
        results.push({ email: user.email, firstName, status: 'dry-run' });
      } else {
        try {
          await sendEmail({ to: user.email, subject, html, text });
          results.push({ email: user.email, firstName, status: 'sent' });
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 300));
        } catch(e) {
          results.push({ email: user.email, firstName, status: 'failed', error: e.message });
        }
      }
    }

    console.log(`[reactivation] ${dryRun ? 'DRY RUN' : 'SENT'} to ${results.length} users`);
    res.json({ sent: results.filter(r => r.status === 'sent').length, total: results.length, dryRun: !!dryRun, results });
  } catch(e) {
    console.error('[reactivation]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────
// Serve a minimal gold coin SVG as favicon
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#F5F0E8"/><circle cx="76" cy="96" r="36" fill="none" stroke="#8B6914" stroke-width="12"/><circle cx="116" cy="96" r="36" fill="none" stroke="#8B6914" stroke-width="12"/></svg>`;

app.get('/manifest.json', (req, res) => {
  const p = path.join(__dirname, 'manifest.json');
  if (require('fs').existsSync(p)) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(p);
  } else {
    // Inline fallback
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json({
      name: 'MyAurum — Precious Metals', short_name: 'MyAurum',
      start_url: '/', display: 'standalone',
      background_color: '#F5F0E8', theme_color: '#1A1508',
      orientation: 'portrait', categories: ['finance','lifestyle'],
      icons: [{ src: '/favicon.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }]
    });
  }
});

app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(FAVICON_SVG);
});

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(FAVICON_SVG);
});

app.get('/apple-touch-icon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
    <loc>${base}/security</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${base}/privacy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${base}/terms</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${base}/gold</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${base}/blog</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${base}/blog/india-gold-hallmark-scams-2026</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${base}/blog/dubai-gold-souk-what-indians-need-to-know</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${base}/blog/buying-indian-gold-jewellery-new-york</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>`;
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /share/\nDisallow: /api/\n\nSitemap: https://myaurum.app/sitemap.xml`
  );
});

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
  // Never serve index.html for admin or blog paths — let them 404 cleanly
  if (req.path.startsWith('/' + ADMIN_SLUG) || req.path.startsWith('/blog')) {
    return res.status(404).send('Not found');
  }
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) { res.setHeader('Cache-Control','no-cache,no-store,must-revalidate'); res.sendFile(indexPath); }
  else res.status(200).send('<h2>MyAurum backend running ✓</h2>');
});

app.get('/health', (req, res) => res.json({ ok:true, uptime:process.uptime() }));

// ─────────────────────────────────────────
//  DEAD MAN'S SWITCH — EMAIL BUILDERS
// ─────────────────────────────────────────
async function sendDMSWarningEmail(user, daysLeft, periodDays) {
  const subject = `MyAurum — your custodians will be notified in ${daysLeft} day${daysLeft===1?'':'s'}`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F0E8;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center"><table role="presentation" width="100%" style="max-width:520px">
<tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
  <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
</td></tr>
<tr><td style="background:#FDFAF5;padding:28px 32px;border:1px solid #DDD5C0">
  <p style="font-size:14px;color:#2C2410;line-height:1.8">Hi ${user.first_name},</p>
  <p style="font-size:13px;color:#555;line-height:1.8">You set up a dead man's switch on MyAurum with a ${periodDays}-day inactivity period. You haven't logged in for a while — your custodians will be notified in <strong>${daysLeft} day${daysLeft===1?'':'s'}</strong> if you don't log in before then.</p>
  <p style="font-size:13px;color:#555;line-height:1.8">If everything is fine, just open MyAurum. That resets the clock automatically.</p>
  <div style="text-align:center;margin:28px 0">
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 32px;border-radius:8px;font-weight:600">Open MyAurum — I'm here →</a>
  </div>
  <p style="font-size:11px;color:#AAA;line-height:1.7">If you'd like to disable or change this setting, you can do so in the Succession tab under Estate Notes.</p>
</td></tr>
<tr><td style="background:#F0EBE0;padding:16px 32px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px">
  <p style="margin:0;font-size:10px;color:#BBB">© 2026 MyAurum · <a href="${APP_URL}" style="color:#B8860B;text-decoration:none">myaurum.app</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
  return sendEmail({ to: user.email, subject, html, text: `Hi ${user.first_name},\n\nYour MyAurum dead man's switch will notify your custodians in ${daysLeft} day${daysLeft===1?'':'s'}.\n\nJust open MyAurum to reset the clock: ${APP_URL}` });
}

async function sendDMSFiredEmail(nominee, user, accessToken) {
  const accessUrl = `${APP_URL}/nominee/${accessToken}`;
  const subject = `${user.first_name} ${user.last_name} has shared their Estate Notes with you`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F0E8;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center"><table role="presentation" width="100%" style="max-width:520px">
<tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
  <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:.24em;color:#F0B429">MYAURUM</p>
  <p style="margin:6px 0 0;font-size:10px;color:#907030;letter-spacing:.2em;text-transform:uppercase">Estate Notes</p>
</td></tr>
<tr><td style="background:#FDFAF5;padding:28px 32px;border:1px solid #DDD5C0">
  <p style="font-size:14px;color:#2C2410;line-height:1.8">Hi ${nominee.name},</p>
  <p style="font-size:13px;color:#555;line-height:1.8">${user.first_name} ${user.last_name} set up an automatic notification on MyAurum and hasn't logged in for ${user._periodDays} days. They have designated you as a nominee and shared their Estate Notes with you.</p>
  <p style="font-size:13px;color:#555;line-height:1.8">This may mean nothing — they may simply have forgotten to log in. Please reach out to them directly before acting on anything in this document.</p>
  <div style="text-align:center;margin:28px 0">
    <a href="${accessUrl}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 32px;border-radius:8px;font-weight:600">View Estate Notes →</a>
  </div>
  <p style="font-size:11px;color:#AAA;line-height:1.7">This link does not expire. Handle this document with care.</p>
</td></tr>
<tr><td style="background:#F0EBE0;padding:16px 32px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px">
  <p style="margin:0;font-size:10px;color:#BBB">© 2026 MyAurum · <a href="${APP_URL}" style="color:#B8860B;text-decoration:none">myaurum.app</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
  return sendEmail({ to: nominee.email, subject, html, text: `Hi ${nominee.name},\n\n${user.first_name} ${user.last_name} has shared their Estate Notes with you via MyAurum.\n\nView here: ${accessUrl}\n\nPlease reach out to them directly before acting on anything.` });
}

async function checkDeadmansSwitch() {
  console.log('[dms] Running dead man\'s switch check');
  try {
    const switches = await q(`
      SELECT d.*, u.email, u.first_name, u.last_name, u.last_seen, u.estate_notes_decrypted
      FROM deadmans_switch d
      JOIN users u ON u.id = d.user_id
      WHERE d.enabled = TRUE AND d.fired_at IS NULL
    `);
    for (const row of switches.rows) {
      const lastSeen = row.last_seen ? new Date(row.last_seen) : new Date(row.created_at);
      const daysSince = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60 * 60 * 24));
      const periodDays = row.period_days;
      const warnAt = Math.floor(periodDays * 0.8); // warn at 80%
      const user = { id: row.user_id, email: row.email, first_name: row.first_name, last_name: row.last_name, _periodDays: periodDays };

      if (daysSince >= periodDays) {
        // FIRE — notify all nominees
        console.log(`[dms] Firing for user ${row.user_id} — ${daysSince} days inactive`);
        const nominees = await q('SELECT * FROM nominees WHERE user_id=$1', [row.user_id]);
        for (const nominee of nominees.rows) {
          const token = jwt.sign(
            { type: 'nominee_access', userId: row.user_id, nomineeId: nominee.id },
            JWT_SECRET
            // No expiry — permanent access once switch fires
          );
          try {
            await sendDMSFiredEmail(nominee, user, token);
            console.log(`[dms] Fired email to custodian ${nominee.email}`);
          } catch(e) { console.error(`[dms] Failed to email custodian ${nominee.email}:`, e.message); }
        }
        await q('UPDATE deadmans_switch SET fired_at=NOW(), updated_at=NOW() WHERE user_id=$1', [row.user_id]);
        // Notify the primary user too
        try {
          await sendEmail({
            to: row.email,
            subject: 'MyAurum — your Estate Notes have been shared with your nominees',
            html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#F5F0E8;border-radius:12px"><p style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#B8860B;letter-spacing:.2em">MYAURUM</p><p style="color:#2C2410;font-size:14px;line-height:1.8">Hi ${row.first_name},</p><p style="color:#555;font-size:13px;line-height:1.8">Your dead man's switch has fired. Your custodians have been sent access to your Estate Notes. If this was a mistake, please log in and contact us.</p><a href="${APP_URL}" style="display:inline-block;background:#B8860B;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:12px;margin-top:16px">Open MyAurum →</a></div>`,
            text: `Hi ${row.first_name},\n\nYour dead man's switch has fired and your nominees have been notified.\n\nIf this was a mistake, please log in immediately: ${APP_URL}`
          });
        } catch(e) { console.error('[dms] Failed to notify primary user:', e.message); }

      } else if (daysSince >= warnAt) {
        // WARN — but only once per period
        const alreadyWarned = row.last_warned_at && new Date(row.last_warned_at) > lastSeen;
        if (!alreadyWarned) {
          const daysLeft = periodDays - daysSince;
          console.log(`[dms] Warning user ${row.user_id} — ${daysLeft} days left`);
          try {
            await sendDMSWarningEmail(user, daysLeft, periodDays);
            await q('UPDATE deadmans_switch SET last_warned_at=NOW(), updated_at=NOW() WHERE user_id=$1', [row.user_id]);
          } catch(e) { console.error(`[dms] Warning email failed for user ${row.user_id}:`, e.message); }
        }
      }
    }
  } catch(e) { console.error('[dms] Check failed:', e.message); }
}

// START
initDB()
  .then(() => q('SELECT * FROM price_cache WHERE id=1'))
  .then(r => {
    if (r.rows[0]) priceCache = r.rows[0];
    cron.schedule('*/5 * * * *', refreshPrices);

    // IBJA rates — daily at 11:00am IST (05:30 UTC), after IBJA AM publish
    cron.schedule('30 5 * * 1-5', async () => {
      try { await fetchIBJARates(); }
      catch(e) { console.error('[ibja] Cron error:', e.message); }
    });

    // Fetch IBJA on startup too
    fetchIBJARates().catch(e => console.error('[ibja] Startup fetch failed:', e.message));

    // Backfill price history from oldest purchase date
    setTimeout(() => {
      backfillPriceHistory().catch(e => console.error('[backfill] Startup error:', e.message));
    }, 5000); // wait 5s after startup to avoid hammering on cold boot

    // Weekly digest — Monday 8:00am IST = 02:30 UTC
    cron.schedule('30 2 * * 1', async () => {
      try { await sendWeeklyDigests(); }
      catch(e) { console.error('[weekly] Cron error:', e.message); }
    });

    // Dead man's switch — daily at 9:00am IST (03:30 UTC)
    cron.schedule('30 3 * * *', async () => {
      try { await checkDeadmansSwitch(); }
      catch(e) { console.error('[dms] Cron error:', e.message); }
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
