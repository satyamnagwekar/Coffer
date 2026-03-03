/**
 * coffer-alerts.js — Resend edition
 *
 * SETUP:
 *   npm install resend
 *
 * .env:
 *   RESEND_API_KEY=re_xxxxxxxxxxxx
 *   RESEND_FROM=COFFER Alerts <alerts@coffer.app>
 *   APP_URL=https://yourapp.com
 *
 * USAGE (server.js):
 *   const { startAlertChecker } = require('./coffer-alerts');
 *   startAlertChecker(db, fetchSpotPrices);
 *
 * DB INTERFACE:
 *   db.getUnfiredAlerts()       -> Promise<Alert[]>
 *   db.markAlertFired(alertId)  -> Promise<void>
 *
 * fetchSpotPrices():
 *   -> Promise<{ gold: number, silver: number, rates: { INR: number } }>
 */

'use strict';

const { Resend } = require('resend');

const INDIA_FACTOR = (10 / 31.1035) * 1.15 * 1.03;

function fmtTarget(alert, inrRate) {
  if (alert.priceCurrency === 'INR') {
    const v = alert.priceDisplay || Math.round(alert.price * inrRate * INDIA_FACTOR);
    return '\u20b9' + Math.round(v).toLocaleString('en-IN') + ' / 10g';
  }
  const v = alert.priceDisplay || alert.price;
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' / oz';
}

function fmtSpot(spotUSD, alert, inrRate) {
  if (alert.priceCurrency === 'INR') {
    return '\u20b9' + Math.round(spotUSD * inrRate * INDIA_FACTOR).toLocaleString('en-IN') + ' / 10g';
  }
  return '$' + spotUSD.toFixed(2) + ' / oz';
}

function buildEmail(alert, spotUSD, inrRate) {
  const isGold    = alert.metal === 'gold';
  const metalName = isGold ? 'Gold' : 'Silver';
  const emoji     = isGold ? '&#127950;' : '&#129360;';
  const above     = alert.dir === 'above';
  const dirWord   = above ? 'risen above' : 'fallen below';
  const dirArrow  = above ? '\u2191' : '\u2193';
  const accent    = above ? '#2ECC8A' : '#E05C5C';
  const accentBg  = above ? 'rgba(46,204,138,.12)' : 'rgba(224,92,92,.12)';
  const accentBdr = above ? 'rgba(46,204,138,.3)' : 'rgba(224,92,92,.3)';
  const targetFmt = fmtTarget(alert, inrRate);
  const spotFmt   = fmtSpot(spotUSD, alert, inrRate);
  const appUrl    = process.env.APP_URL || 'https://yourapp.com';
  const noteRow   = alert.note
    ? `<p style="font-size:13px;color:#888;font-style:italic;margin:0 0 20px;padding:12px 16px;background:#F5F0E8;border-radius:8px;border-left:3px solid #D4A017">&ldquo;${alert.note}&rdquo;</p>`
    : '';

  const subject = `${metalName} has ${dirWord} your target \u2014 COFFER Alert`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px">
  <tr><td style="background:#1A1508;padding:24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:300;letter-spacing:.24em;color:#F0B429">COFFER</p>
    <p style="margin:5px 0 0;font-size:10px;color:#907030;letter-spacing:.22em;text-transform:uppercase">Price Alert</p>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:28px 32px 8px;text-align:center;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <span style="display:inline-block;background:${accentBg};border:1px solid ${accentBdr};border-radius:24px;padding:7px 18px;font-size:11px;color:${accent};letter-spacing:.12em;text-transform:uppercase;font-weight:600">${dirArrow} Target Reached</span>
  </td></tr>
  <tr><td style="background:#FDFAF5;padding:12px 32px 28px;text-align:center;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0">
    <p style="font-family:Georgia,serif;font-size:40px;font-weight:300;color:#2C2410;margin:0 0 2px;line-height:1">${emoji}</p>
    <p style="font-family:Georgia,serif;font-size:28px;font-weight:300;color:#2C2410;margin:0 0 4px">${metalName}</p>
    <p style="font-size:13px;color:#999;margin:0 0 24px;letter-spacing:.04em">has ${dirWord} your target</p>
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
    <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#B8860B,#D4A017);color:#0c0a06;text-decoration:none;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:15px 32px;border-radius:8px;font-weight:600">Open My Coffer &rarr;</a>
  </td></tr>
  <tr><td style="background:#F0EBE0;padding:18px 32px;border:1px solid #DDD5C0;border-top:none;border-radius:0 0 16px 16px;text-align:center">
    <p style="margin:0;font-size:10px;color:#BBB;line-height:1.85;letter-spacing:.03em">
      This alert is now marked as fired and will not trigger again.<br>
      Prices are indicative spot rates &mdash; actual buyback values vary by dealer.<br>
      <a href="${appUrl}" style="color:#B8860B;text-decoration:none">Manage alerts in COFFER</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    'COFFER Price Alert',
    '------------------',
    `${metalName} has ${dirWord} your target.`,
    '',
    `Your target : ${targetFmt}`,
    `Current spot: ${spotFmt}`,
    alert.note ? `Note        : "${alert.note}"` : null,
    '',
    'This alert is now marked as fired and will not trigger again.',
    `Open your Coffer: ${appUrl}`,
  ].filter(l => l !== null).join('\n');

  return { subject, html, text };
}

async function checkAndFireAlerts(db, fetchSpotPrices) {
  let spot, inrRate;
  try {
    const prices = await fetchSpotPrices();
    spot    = { gold: prices.gold, silver: prices.silver };
    inrRate = (prices.rates && prices.rates.INR) || 84;
  } catch (e) {
    console.error('[coffer-alerts] Price fetch failed:', e.message);
    return;
  }

  let alerts;
  try {
    alerts = await db.getUnfiredAlerts();
  } catch (e) {
    console.error('[coffer-alerts] Could not load alerts:', e.message);
    return;
  }

  if (!alerts || !alerts.length) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from   = process.env.RESEND_FROM || 'COFFER Alerts <alerts@coffer.app>';

  for (const alert of alerts) {
    const currentSpot = alert.metal === 'gold' ? spot.gold : spot.silver;
    const hit = alert.dir === 'above' ? currentSpot >= alert.price : currentSpot <= alert.price;
    if (!hit) continue;

    // Mark fired first — prevents double-send if email throws
    try {
      await db.markAlertFired(alert.id);
    } catch (e) {
      console.error(`[coffer-alerts] Could not mark alert ${alert.id} fired:`, e.message);
      continue;
    }

    if (!alert.notifyEmail) {
      console.log(`[coffer-alerts] Alert ${alert.id} fired (no email on record)`);
      continue;
    }

    const { subject, html, text } = buildEmail(alert, currentSpot, inrRate);

    try {
      const { data, error } = await resend.emails.send({
        from,
        to: [alert.notifyEmail],
        subject,
        html,
        text,
        tags: [
          { name: 'alert_id',  value: String(alert.id) },
          { name: 'metal',     value: alert.metal },
          { name: 'direction', value: alert.dir },
        ],
      });

      if (error) {
        console.error(`[coffer-alerts] Resend error for alert ${alert.id}:`, error);
      } else {
        console.log(`[coffer-alerts] Alert ${alert.id} fired -> email ${data.id} -> ${alert.notifyEmail}`);
      }
    } catch (e) {
      console.error(`[coffer-alerts] Unexpected error for alert ${alert.id}:`, e.message);
    }
  }
}

function startAlertChecker(db, fetchSpotPrices, intervalMs = 5 * 60 * 1000) {
  const mins = Math.round(intervalMs / 60000);
  console.log(`[coffer-alerts] Started — checking every ${mins} minute${mins !== 1 ? 's' : ''}`);
  checkAndFireAlerts(db, fetchSpotPrices);
  setInterval(() => checkAndFireAlerts(db, fetchSpotPrices), intervalMs);
}

module.exports = { startAlertChecker, checkAndFireAlerts };
