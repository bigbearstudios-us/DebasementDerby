// gap-fill.js
// ONE-TIME script — fills the specific date gap between the last backup (Aug 17)
// and today, on the NEW project (Debasement Derby 2). Uses the free Demo API key
// (not the canceled Pro one) since this window is only a few days — comfortably
// within the Demo plan's 1-year historical depth limit.
//
// Same source logic as backfill.js: CoinGecko direct for most currencies,
// Frankfurter for RON, Yahoo Finance for KZT/EGP/IQD/COP/PEN, VES skipped.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (the NEW project's values)
//   COINGECKO_API_KEY                          (the free Demo key)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const GAP_START = '2026-08-18'; // day after the last confirmed date in the restored backup
const GAP_START_UNIX = Math.floor(new Date(GAP_START).getTime() / 1000);
const NOW_UNIX = Math.floor(Date.now() / 1000);

const COINGECKO_CURRENCIES = [
  'usd','eur','jpy','gbp','cny','cad','aud','chf','hkd','sgd','krw','inr','brl','mxn',
  'rub','sar','aed','sek','nok','dkk','pln','zar','try','thb','idr','ils','nzd','php','myr',
  'czk','huf','clp','ars','vnd','ngn','pkr','bdt','kwd','bhd','uah'
];
const FRANKFURTER_CURRENCIES = ['ron'];
const YAHOO_CURRENCIES = ['kzt', 'egp', 'iqd', 'cop', 'pen'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 30000;
async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function makeRow(currencyCode, dateStr, price, btcUsd, fxRate) {
  return {
    currency_code: currencyCode.toUpperCase(),
    snapshot_date: dateStr,
    open_price: price,
    high_price: price,
    low_price: price,
    close_price: price,
    btc_usd_close: btcUsd,
    fx_rate_close: fxRate,
    last_updated_at: new Date().toISOString(),
  };
}

async function bulkUpsertRows(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('price_snapshots')
    .upsert(rows, { onConflict: 'currency_code,snapshot_date' });
  if (error) throw error;
}

async function getBtcUsdSeries() {
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${GAP_START_UNIX}&to=${NOW_UNIX}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko BTC/USD gap error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const byDate = {};
  for (const [ts, price] of data.prices) {
    byDate[new Date(ts).toISOString().slice(0, 10)] = price;
  }
  return byDate;
}

async function fillCoinGeckoDirect(currencyCode, btcUsdByDate) {
  if (currencyCode === 'usd') {
    await bulkUpsertRows(Object.entries(btcUsdByDate).map(([date, price]) => makeRow('USD', date, price, price, 1.0)));
    return;
  }
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=${currencyCode}&from=${GAP_START_UNIX}&to=${NOW_UNIX}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko ${currencyCode} gap error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows = [];
  for (const [ts, price] of data.prices) {
    const date = new Date(ts).toISOString().slice(0, 10);
    const btcUsd = btcUsdByDate[date];
    if (!btcUsd) continue;
    rows.push(makeRow(currencyCode, date, price, btcUsd, price / btcUsd));
  }
  await bulkUpsertRows(rows);
}

async function fillFrankfurter(currencyCode, btcUsdByDate) {
  const url = `https://api.frankfurter.dev/v1/${GAP_START}..${new Date().toISOString().slice(0, 10)}?base=USD&symbols=${currencyCode.toUpperCase()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Frankfurter ${currencyCode} gap error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows = [];
  for (const [date, rates] of Object.entries(data.rates)) {
    const fxRate = rates[currencyCode.toUpperCase()];
    const btcUsd = btcUsdByDate[date];
    if (!fxRate || !btcUsd) continue;
    rows.push(makeRow(currencyCode, date, btcUsd * fxRate, btcUsd, fxRate));
  }
  await bulkUpsertRows(rows);
}

async function fillYahoo(currencyCode, btcUsdByDate) {
  const ticker = `${currencyCode.toUpperCase()}=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${GAP_START_UNIX}&period2=${NOW_UNIX}&interval=1d`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Yahoo ${ticker} gap error: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no data in response`);
  const rows = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const fxRate = result.indicators.quote[0].close[i];
    if (fxRate == null) continue;
    const date = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
    const btcUsd = btcUsdByDate[date];
    if (!btcUsd) continue;
    rows.push(makeRow(currencyCode, date, btcUsd * fxRate, btcUsd, fxRate));
  }
  await bulkUpsertRows(rows);
}

async function run() {
  console.log(`Filling gap from ${GAP_START} to today...`);
  const btcUsdByDate = await getBtcUsdSeries();
  console.log(`Got ${Object.keys(btcUsdByDate).length} days of BTC/USD data for the gap window.`);

  const results = { ok: [], failed: [] };

  for (const code of COINGECKO_CURRENCIES) {
    try {
      await fillCoinGeckoDirect(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (CoinGecko) ${code}:`, e.message);
      results.failed.push(code);
    }
    await sleep(4000); // keyless tier: much stricter rate limit, pace conservatively
  }

  for (const code of FRANKFURTER_CURRENCIES) {
    try {
      await fillFrankfurter(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (Frankfurter) ${code}:`, e.message);
      results.failed.push(code);
    }
  }

  for (const code of YAHOO_CURRENCIES) {
    try {
      await fillYahoo(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (Yahoo, best-effort) ${code}:`, e.message);
      results.failed.push(code);
    }
    await sleep(500);
  }

  console.log('\n=== Gap-fill summary ===');
  console.log(`Succeeded: ${results.ok.join(', ')}`);
  console.log(`Failed: ${results.failed.join(', ') || 'none'}`);
}

run().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
