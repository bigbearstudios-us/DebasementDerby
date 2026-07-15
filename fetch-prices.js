// fetch-prices.js
// Runs every 15 minutes via GitHub Actions. Pulls BTC/USD (CoinGecko) and USD->fiat
// FX rates (open.er-api.com), then upserts one OHLC row per currency per calendar date
// into Supabase's price_snapshots table.
//
// Required environment variables (set as GitHub Secrets — see workflow file):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (bypasses RLS — never expose this publicly)
//   COINGECKO_API_KEY           (free Demo key from coingecko.com)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Step 1: get BTC/USD from CoinGecko -------------------------------------------------
async function getBtcUsd() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { headers: { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } }
  );
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.bitcoin.usd;
}

// --- Step 2: get USD -> every fiat currency rate ----------------------------------------
// open.er-api.com is free, keyless, and covers ~160 currencies — broader coverage than
// Frankfurter/ECB, which is needed since several seeded currencies (SAR, AED, QAR, VES,
// EGP, NGN, PKR, etc.) aren't part of the ECB reference-rate set Frankfurter publishes.
async function getFxRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`FX API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (data.result !== 'success') throw new Error(`FX API returned non-success: ${JSON.stringify(data)}`);
  return data.rates; // { USD: 1, EUR: 0.91, JPY: 156.2, ... }
}

// --- Step 3: upsert today's OHLC row for one currency -----------------------------------
async function upsertCurrency(currencyCode, btcUsd, fxRate, today) {
  const priceInCurrency = btcUsd * fxRate;

  // Check whether a row already exists for this currency today.
  const { data: existing, error: fetchErr } = await supabase
    .from('price_snapshots')
    .select('open_price, high_price, low_price')
    .eq('currency_code', currencyCode)
    .eq('snapshot_date', today)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  const row = existing
    ? {
        // day already has a row: keep open, expand high/low, overwrite close
        high_price: Math.max(existing.high_price, priceInCurrency),
        low_price: Math.min(existing.low_price, priceInCurrency),
        close_price: priceInCurrency,
        btc_usd_close: btcUsd,
        fx_rate_close: fxRate,
        last_updated_at: new Date().toISOString(),
      }
    : {
        // first tick of the day: open = high = low = close
        currency_code: currencyCode,
        snapshot_date: today,
        open_price: priceInCurrency,
        high_price: priceInCurrency,
        low_price: priceInCurrency,
        close_price: priceInCurrency,
        btc_usd_close: btcUsd,
        fx_rate_close: fxRate,
        last_updated_at: new Date().toISOString(),
      };

  const { error: upsertErr } = existing
    ? await supabase.from('price_snapshots').update(row).eq('currency_code', currencyCode).eq('snapshot_date', today)
    : await supabase.from('price_snapshots').insert(row);

  if (upsertErr) throw upsertErr;
}

// --- Main ---------------------------------------------------------------------------------
async function run() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  console.log(`[${new Date().toISOString()}] Starting fetch for ${today}`);

  const [btcUsd, fxRates] = await Promise.all([getBtcUsd(), getFxRates()]);
  console.log(`BTC/USD: ${btcUsd}`);

  const { data: currencies, error } = await supabase.from('currencies').select('code');
  if (error) throw error;

  const results = { ok: [], skipped: [], failed: [] };

  for (const { code } of currencies) {
    const fxRate = fxRates[code];
    if (fxRate === undefined) {
      results.skipped.push(code); // currency not covered by this FX source
      continue;
    }
    try {
      await upsertCurrency(code, btcUsd, fxRate, today);
      results.ok.push(code);
    } catch (e) {
      console.error(`Failed for ${code}:`, e.message);
      results.failed.push(code);
    }
  }

  console.log(`Done. Updated: ${results.ok.length}, skipped (no FX rate): ${results.skipped.join(', ') || 'none'}, failed: ${results.failed.join(', ') || 'none'}`);

  if (results.failed.length > 0) process.exit(1); // non-zero exit fails the GitHub Action run visibly
}

run().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
