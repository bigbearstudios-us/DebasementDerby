// backfill.js
// ONE-TIME script — not part of the recurring 15-minute job. Run manually once,
// after subscribing to CoinGecko's Analyst tier, then never again (unless you
// want to re-run a wider backfill later).
//
// What it does, per currency:
//   - 40 currencies directly supported by CoinGecko's vs_currency list: pulls
//     "BTC priced in that currency" directly, in one call per currency, back to
//     BACKFILL_START.
//   - RON: not in CoinGecko's list, backfilled via Frankfurter's free historical
//     FX data instead, combined with the BTC/USD series pulled once from CoinGecko.
//   - KZT, EGP, IQD, COP, PEN: no clean free historical FX source at this depth.
//     Best-effort via Yahoo Finance's historical chart data. This section is
//     wrapped so a failure here doesn't block the rest of the backfill — if it
//     doesn't work cleanly, it's flagged in the log rather than silently skipped.
//   - VES: deliberately NOT attempted. Venezuela's redenominations and the gap
//     between official/parallel rates make this currency unreliable at this
//     depth — left for later, manual, dedicated handling rather than faked here.
//
// IMPORTANT: historical rows only get true open=high=low=close all equal to the
// single daily price CoinGecko/Frankfurter/Yahoo report for that date — none of
// these sources give true intraday OHLC that far back. True OHLC only starts
// being real once your recurring 15-minute job (fetch-prices.js) takes over.
//
// Required environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   COINGECKO_PRO_API_KEY   (the paid Analyst-tier key — different from your
//                             recurring job's Demo key, and uses a different
//                             API host: pro-api.coingecko.com)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BACKFILL_START = '2013-10-06'; // Kraken/CoinGecko-era start; predates this, data gets unreliable
const BACKFILL_START_UNIX = Math.floor(new Date(BACKFILL_START).getTime() / 1000);
const NOW_UNIX = Math.floor(Date.now() / 1000);

// Currencies CoinGecko supports directly as a vs_currency (confirmed against your 47).
// Excludes RON (Frankfurter), KZT/EGP/IQD/COP/PEN (Yahoo), VES (not attempted).
const COINGECKO_CURRENCIES = [
  'usd','eur','jpy','gbp','cny','cad','aud','chf','hkd','sgd','krw','inr','brl','mxn',
  'rub','sar','aed','sek','nok','dkk','pln','zar','try','thb','idr','ils','nzd','php','myr',
  'czk','huf','clp','ars','vnd','ngn','pkr','bdt','kwd','bhd','uah'
];

const FRANKFURTER_CURRENCIES = ['ron'];
const YAHOO_CURRENCIES = ['kzt', 'egp', 'iqd', 'cop', 'pen'];
const SKIPPED = ['ves'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Upsert helper: writes ONE historical row, open=high=low=close ------------------
async function upsertHistoricalRow(currencyCode, dateStr, price, btcUsd, fxRate) {
  const { error } = await supabase.from('price_snapshots').upsert(
    {
      currency_code: currencyCode.toUpperCase(),
      snapshot_date: dateStr,
      open_price: price,
      high_price: price,
      low_price: price,
      close_price: price,
      btc_usd_close: btcUsd,
      fx_rate_close: fxRate,
      last_updated_at: new Date().toISOString(),
    },
    { onConflict: 'currency_code,snapshot_date' }
  );
  if (error) throw error;
}

// --- Step A: BTC/USD daily series, fetched once, reused everywhere ------------------
async function getBtcUsdSeries() {
  const url = `https://pro-api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${BACKFILL_START_UNIX}&to=${NOW_UNIX}`;
  const res = await fetch(url, { headers: { 'x-cg-pro-api-key': process.env.COINGECKO_PRO_API_KEY } });
  if (!res.ok) throw new Error(`CoinGecko BTC/USD range error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const byDate = {};
  for (const [ts, price] of data.prices) {
    const date = new Date(ts).toISOString().slice(0, 10);
    byDate[date] = price; // later timestamps on the same date overwrite earlier ones — fine, just need one point per day
  }
  return byDate; // { '2013-10-06': 123.45, ... }
}

// --- Step B: currencies CoinGecko supports directly ---------------------------------
async function backfillCoinGeckoDirect(currencyCode, btcUsdByDate) {
  if (currencyCode === 'usd') {
    // already have this from Step A directly
    for (const [date, price] of Object.entries(btcUsdByDate)) {
      await upsertHistoricalRow('USD', date, price, price, 1.0);
    }
    return;
  }
  const url = `https://pro-api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=${currencyCode}&from=${BACKFILL_START_UNIX}&to=${NOW_UNIX}`;
  const res = await fetch(url, { headers: { 'x-cg-pro-api-key': process.env.COINGECKO_PRO_API_KEY } });
  if (!res.ok) throw new Error(`CoinGecko ${currencyCode} range error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  for (const [ts, price] of data.prices) {
    const date = new Date(ts).toISOString().slice(0, 10);
    const btcUsd = btcUsdByDate[date];
    if (!btcUsd) continue; // no matching USD point that day, skip rather than guess
    const fxRate = price / btcUsd;
    await upsertHistoricalRow(currencyCode, date, price, btcUsd, fxRate);
  }
}

// --- Step C: Frankfurter, for currencies CoinGecko doesn't cover (RON) ---------------
async function backfillFrankfurter(currencyCode, btcUsdByDate) {
  const url = `https://api.frankfurter.dev/v1/${BACKFILL_START}..${new Date().toISOString().slice(0, 10)}?base=USD&symbols=${currencyCode.toUpperCase()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${currencyCode} error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  for (const [date, rates] of Object.entries(data.rates)) {
    const fxRate = rates[currencyCode.toUpperCase()];
    const btcUsd = btcUsdByDate[date];
    if (!fxRate || !btcUsd) continue;
    await upsertHistoricalRow(currencyCode, date, btcUsd * fxRate, btcUsd, fxRate);
  }
}

// --- Step D: Yahoo Finance, best-effort for the 5 harder currencies ------------------
async function backfillYahoo(currencyCode, btcUsdByDate) {
  const ticker = `${currencyCode.toUpperCase()}=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${BACKFILL_START_UNIX}&period2=${NOW_UNIX}&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${ticker} error: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker}: no data in response`);
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  for (let i = 0; i < timestamps.length; i++) {
    const fxRate = closes[i];
    if (fxRate == null) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    const btcUsd = btcUsdByDate[date];
    if (!btcUsd) continue;
    await upsertHistoricalRow(currencyCode, date, btcUsd * fxRate, btcUsd, fxRate);
  }
}

// --- Main -----------------------------------------------------------------------------
async function run() {
  console.log(`Backfilling from ${BACKFILL_START} to today...`);
  console.log('Step A: fetching BTC/USD series...');
  const btcUsdByDate = await getBtcUsdSeries();
  console.log(`Got ${Object.keys(btcUsdByDate).length} days of BTC/USD data.`);

  const results = { ok: [], failed: [] };

  for (const code of COINGECKO_CURRENCIES) {
    try {
      console.log(`CoinGecko: backfilling ${code}...`);
      await backfillCoinGeckoDirect(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (CoinGecko) ${code}:`, e.message);
      results.failed.push(code);
    }
    await sleep(1500); // pace calls comfortably under the Analyst tier's 300/min limit
  }

  for (const code of FRANKFURTER_CURRENCIES) {
    try {
      console.log(`Frankfurter: backfilling ${code}...`);
      await backfillFrankfurter(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (Frankfurter) ${code}:`, e.message);
      results.failed.push(code);
    }
  }

  for (const code of YAHOO_CURRENCIES) {
    try {
      console.log(`Yahoo (best-effort): backfilling ${code}...`);
      await backfillYahoo(code, btcUsdByDate);
      results.ok.push(code);
    } catch (e) {
      console.error(`FAILED (Yahoo, best-effort) ${code}:`, e.message);
      results.failed.push(code);
    }
    await sleep(500);
  }

  console.log('\n=== Backfill summary ===');
  console.log(`Succeeded: ${results.ok.join(', ')}`);
  console.log(`Failed: ${results.failed.join(', ') || 'none'}`);
  console.log(`Not attempted (flagged, not faked): ${SKIPPED.join(', ')}`);
}

run().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
