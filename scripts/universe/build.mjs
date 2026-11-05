#!/usr/bin/env node
/* Daily market universe for the app (runs on GitHub Actions; no API key required).
 *
 *   data/universe/crypto.json  top 100 coins by market cap (stablecoins and wrapped/staked
 *                              tokens removed), ~1 year of daily closes in USD — CoinGecko
 *   data/universe/us.json      S&P 100 stocks (list read from Wikipedia) + popular and
 *                              Sharia-screened ETFs, ~1 year of daily closes in USD —
 *                              Stooq CSV, falling back to Yahoo Finance's chart endpoint
 *
 * Every asset records where its prices came from. Assets whose history fails validation are
 * dropped (and listed under "skipped") rather than published with bad data.
 * Usage: node scripts/universe/build.mjs [crypto|us|all]
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../data/universe');
const UA = 'MonzTrader-universe/1.0 (+https://github.com/moneertv/Monz--trader)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CG_KEY = process.env.COINGECKO_API_KEY || '';
const BUDGET_MS = { crypto: 30 * 60000, us: 30 * 60000 };   // publish what we have rather than time out

const T0 = Date.now();
const minutes = () => ((Date.now() - T0) / 60000).toFixed(1);
const notice = (msg) => console.log('::notice::' + msg + ' (' + minutes() + ' min)');

async function get(url, { json = false, headers = {}, tries = 3, wait = 2000, timeout = 20000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...headers }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 429 || r.status >= 500) {
        last = new Error('HTTP ' + r.status);
        const ra = Number(r.headers.get('retry-after'));
        await sleep(Math.min(60000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait * (i + 1) * (r.status === 429 ? 5 : 1)));
        continue;
      }
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: r.status === 404 || r.status === 400 });
      return json ? await r.json() : await r.text();
    } catch (e) { last = e; if (e.fatal) break; await sleep(wait * (i + 1)); }
  }
  throw last;
}

const round = (x) => (x >= 100 ? Math.round(x * 100) / 100 : x >= 1 ? Math.round(x * 10000) / 10000 : Number(x.toPrecision(6)));

export function validate(series) {
  if (!Array.isArray(series) || series.length < 120) return 'only ' + (series ? series.length : 0) + ' closes';
  for (let i = 0; i < series.length; i++) {
    const [d, v] = series[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(v > 0) || !Number.isFinite(v)) return 'bad point at ' + d;
    if (i && d <= series[i - 1][0]) return 'dates not ascending at ' + d;
    if (i && Math.abs(v / series[i - 1][1] - 1) > 0.7) return 'jump >70% at ' + d;
  }
  const lastDate = series[series.length - 1][0];
  if (Date.now() - Date.parse(lastDate) > 10 * 86400000) return 'stale (last close ' + lastDate + ')';
  return null;
}

// ------------------------------------------------------------------ crypto (CoinGecko)
const STABLE = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'usdd', 'pyusd', 'usds', 'busd', 'gusd', 'frax', 'usdp', 'lusd', 'eurc', 'eurs', 'usd0', 'rlusd', 'usdtb', 'usdy', 'susds', 'susde', 'usd1', 'bfusd', 'usdg', 'buidl', 'usdf', 'syrupusdc', 'gho', 'crvusd', 'usdx', 'ousg', 'usyc']);
const WRAPPED = /(^|\s)(wrapped|bridged|staked|liquid staked|restaked)\b|\bw?steth\b|\bweeth\b|\bcbbtc\b|\bwbtc\b|\bweth\b|\breth\b|\bmeth\b|\bjitosol\b|\bmsol\b|\bbnsol\b|binance-peg|\(wormhole\)|\bbtcb\b|\blbtc\b|\bsolvbtc\b|\bezeth\b|\brseth\b|\bwbeth\b|\bclbtc\b/i;
const GOLD_TOKENS = new Set(['xaut', 'paxg']);   // tracked separately as gold

export function isTradableCoin(c) {
  const sym = String(c.symbol || '').toLowerCase(), name = String(c.name || '');
  if (STABLE.has(sym) || GOLD_TOKENS.has(sym)) return false;
  if (WRAPPED.test(name) || WRAPPED.test(sym) || WRAPPED.test(c.id || '')) return false;
  if (c.current_price > 0.97 && c.current_price < 1.03 && Math.abs(c.price_change_percentage_24h || 0) < 0.6 && /usd|eur/i.test(sym + name)) return false;
  return true;
}

async function buildCrypto() {
  const h = CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {};
  const markets = [];
  for (const page of [1, 2]) {
    markets.push(...await get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=' + page + '&price_change_percentage=24h', { json: true, headers: h, tries: 4, wait: 5000 }));
    await sleep(CG_KEY ? 1500 : 6000);
  }
  const picked = markets.filter(isTradableCoin).slice(0, 100);
  notice('crypto: ' + picked.length + ' coins selected from CoinGecko market caps');
  // Kraken public OHLC (no key, generous limits) covers most large coins; CoinGecko fills the rest.
  let kraken = {};
  try { kraken = krakenPairs(await get('https://api.kraken.com/0/public/AssetPairs', { json: true })); } catch (e) { notice('crypto: Kraken pair list unavailable: ' + e.message); }
  const assets = [], skipped = [], used = { Kraken: 0, CoinGecko: 0 };
  let cgCooldown = 0;
  for (const c of picked) {
    if (Date.now() - T0 > BUDGET_MS.crypto) { skipped.push({ id: c.id, reason: 'time budget reached' }); continue; }
    const sym = String(c.symbol).toUpperCase();
    let series = null, source = null, reason = null;
    const pair = kraken[sym];
    if (pair) {
      try {
        const j = await get('https://api.kraken.com/0/public/OHLC?pair=' + pair + '&interval=1440', { json: true, tries: 2 });
        const rows = j.result && Object.entries(j.result).find(([k]) => k !== 'last');
        if (rows) series = rows[1].map((r) => [new Date(r[0] * 1000).toISOString().slice(0, 10), round(Number(r[4]))]).filter((x) => x[1] > 0).slice(-366);
        source = 'Kraken';
        await sleep(1100);
      } catch (e) { reason = 'Kraken: ' + e.message; }
    }
    if (!series || validate(series)) {
      if (Date.now() < cgCooldown) await sleep(cgCooldown - Date.now());
      try {
        const j = await get('https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(c.id) + '/market_chart?vs_currency=usd&days=365&interval=daily', { json: true, headers: h, tries: 2, wait: 5000 });
        const byDay = {};
        for (const [ms, p] of j.prices || []) if (Number.isFinite(p) && p > 0) byDay[new Date(ms).toISOString().slice(0, 10)] = p;
        series = Object.keys(byDay).sort().map((d) => [d, round(byDay[d])]);
        source = 'CoinGecko';
      } catch (e) { reason = (reason ? reason + '; ' : '') + 'CoinGecko: ' + e.message; series = null; }
      cgCooldown = Date.now() + (CG_KEY ? 2200 : 6500);
    }
    const err = series ? validate(series) : reason || 'no history';
    if (err) skipped.push({ id: c.id, reason: err });
    else { used[source]++; assets.push({ key: 'CRYPTO:' + c.id, id: c.id, symbol: sym, name: c.name, rank: c.market_cap_rank, marketCap: c.market_cap,
      price: c.current_price, change24h: c.price_change_percentage_24h, currency: 'USD', source, series }); }
    if ((assets.length + skipped.length) % 20 === 0) notice('crypto: ' + (assets.length + skipped.length) + '/' + picked.length + ' done, ' + assets.length + ' ok (Kraken ' + used.Kraken + ', CoinGecko ' + used.CoinGecko + ')');
  }
  return { schema: 1, kind: 'crypto', generated_at: new Date().toISOString(), source: 'Top coins by market cap from CoinGecko (stablecoins and wrapped tokens excluded); daily closes from Kraken, else CoinGecko', assets, skipped };
}

/** Map coin symbol -> Kraken USD pair name (Kraken calls BTC "XBT" and DOGE "XDG"). */
export function krakenPairs(j) {
  const alias = { XBT: 'BTC', XXBT: 'BTC', XDG: 'DOGE', XXDG: 'DOGE', XETH: 'ETH', XXRP: 'XRP', XLTC: 'LTC', XXLM: 'XLM', XETC: 'ETC', XZEC: 'ZEC', XXMR: 'XMR' };
  const out = {};
  for (const [name, p] of Object.entries((j && j.result) || {})) {
    if (!/^(USD|ZUSD)$/.test(p.quote) || /\.d$/.test(name) || p.status && p.status !== 'online') continue;
    const base = alias[p.base] || p.base.replace(/^X(?=[A-Z]{3,}$)/, '');
    if (!out[base]) out[base] = name;
  }
  return out;
}

// ------------------------------------------------------------------ US stocks & ETFs
const ETFS = [
  ['SPY', 'SPDR S&P 500 ETF'], ['VOO', 'Vanguard S&P 500 ETF'], ['VTI', 'Vanguard Total Stock Market ETF'], ['QQQ', 'Invesco QQQ (Nasdaq-100)'],
  ['DIA', 'SPDR Dow Jones Industrial Average ETF'], ['IWM', 'iShares Russell 2000 ETF'], ['VEA', 'Vanguard Developed Markets ETF'], ['VWO', 'Vanguard Emerging Markets ETF'],
  ['SCHD', 'Schwab US Dividend Equity ETF'], ['VIG', 'Vanguard Dividend Appreciation ETF'], ['XLK', 'Technology Select Sector SPDR'], ['XLF', 'Financial Select Sector SPDR'],
  ['XLE', 'Energy Select Sector SPDR'], ['XLV', 'Health Care Select Sector SPDR'], ['GLD', 'SPDR Gold Shares'], ['IAU', 'iShares Gold Trust'], ['SLV', 'iShares Silver Trust'],
  ['HLAL', 'Wahed FTSE USA Shariah ETF'], ['SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF'], ['SPSK', 'SP Funds Dow Jones Global Sukuk ETF'],
  ['SPRE', 'SP Funds S&P Global REIT Sharia ETF'], ['SPTE', 'SP Funds S&P Global Technology ETF'], ['SPWO', 'SP Funds S&P World (ex-US) ETF'], ['UMMA', 'Wahed Dow Jones Islamic World ETF'],
];
// Used only if the Wikipedia list cannot be read (S&P 100 constituents, mid-2026).
const SP100_FALLBACK = 'AAPL ABBV ABT ACN ADBE AIG AMD AMGN AMT AMZN AVGO AXP BA BAC BK BKNG BLK BMY BRK.B C CAT CHTR CL CMCSA COF COP COST CRM CSCO CVS CVX DE DHR DIS DUK EMR F FDX GD GE GILD GM GOOG GOOGL GS HD HON IBM INTC INTU ISRG JNJ JPM KO LIN LLY LMT LOW MA MCD MDLZ MDT MET META MMM MO MRK MS MSFT NEE NFLX NKE NOW NVDA ORCL PEP PFE PG PLTR PM PYPL QCOM RTX SBUX SCHW SO SPG T TGT TMO TMUS TSLA TXN UBER UNH UNP UPS USB V VZ WFC WMT XOM'.split(' ');

export function parseSp100(html) {
  const t = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i);
  if (!t) return [];
  const out = [];
  for (const tr of t[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').trim());
    if (cells.length >= 2 && /^[A-Z.]{1,6}$/.test(cells[0])) out.push([cells[0], cells[1], cells[2] || null]);
  }
  return out;
}

export function parseStooq(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0] || '')) return null;
  const head = lines[0].split(','), ci = head.findIndex((h) => /^close$/i.test(h));
  return lines.slice(1).map((l) => l.split(',')).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0]) && Number(c[ci]) > 0).map((c) => [c[0], round(Number(c[ci]))]);
}
export function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const close = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
  const off = (r.meta && r.meta.gmtoffset) || 0, byDay = {};
  r.timestamp.forEach((t, i) => { if (close[i] > 0) byDay[new Date((t + off) * 1000).toISOString().slice(0, 10)] = round(close[i]); });
  return Object.keys(byDay).sort().map((d) => [d, byDay[d]]);
}

let stooqFails = 0;
async function history(sym) {
  const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  if (stooqFails < 5) {
    try {
      const s = parseStooq(await get('https://stooq.com/q/d/l/?s=' + sym.toLowerCase().replace('.', '-') + '.us&i=d&d1=' + from, { tries: 1, timeout: 15000 }));
      if (s && s.length > 100) { stooqFails = 0; return { series: s.slice(-300), source: 'Stooq', url: 'https://stooq.com/q/?s=' + sym.toLowerCase() + '.us' }; }
      stooqFails++;
    } catch (e) { stooqFails++; }
    if (stooqFails === 5) notice('us: Stooq is not returning data; using Yahoo Finance for the rest');
  }
  const y = parseYahoo(await get('https://query1.finance.yahoo.com/v8/finance/chart/' + sym.replace('.', '-') + '?range=14mo&interval=1d', { json: true, tries: 2, timeout: 15000 }));
  if (y && y.length) return { series: y.slice(-300), source: 'Yahoo Finance', url: 'https://finance.yahoo.com/quote/' + sym.replace('.', '-') };
  throw new Error('no history from Stooq or Yahoo');
}

async function buildUs() {
  let list = [], listSource = 'Wikipedia: S&P 100';
  try { list = parseSp100(await get('https://en.wikipedia.org/wiki/S%26P_100')); } catch (e) { /* fallback */ }
  if (list.length < 90) { list = SP100_FALLBACK.map((s) => [s, s, null]); listSource = 'built-in S&P 100 list (Wikipedia unavailable)'; }
  const entries = [...list.map(([s, n, sec]) => ({ sym: s, name: n, sector: sec, type: 'stock' })), ...ETFS.map(([s, n]) => ({ sym: s, name: n, sector: null, type: 'etf' }))];
  const assets = [], skipped = [];
  notice('us: ' + entries.length + ' symbols (' + listSource + ')');
  for (const e of entries) {
    if (Date.now() - T0 > BUDGET_MS.us) { skipped.push({ symbol: e.sym, reason: 'time budget reached' }); continue; }
    if ((assets.length + skipped.length) % 25 === 0 && assets.length + skipped.length) notice('us: ' + (assets.length + skipped.length) + '/' + entries.length + ' done, ' + assets.length + ' ok');
    try {
      const h = await history(e.sym);
      const err = validate(h.series);
      if (err) skipped.push({ symbol: e.sym, reason: err });
      else {
        const s = h.series, last = s[s.length - 1][1], prev = s.length > 1 ? s[s.length - 2][1] : null;
        assets.push({ key: 'US:' + e.sym, symbol: e.sym, name: e.name, type: e.type, sector: e.sector, price: last, change1d: prev ? (last / prev - 1) * 100 : null,
          asOf: s[s.length - 1][0], currency: 'USD', source: h.source, url: h.url, series: s });
      }
    } catch (err) { skipped.push({ symbol: e.sym, reason: err.message }); }
    await sleep(400);
  }
  return { schema: 1, kind: 'us', generated_at: new Date().toISOString(), source: 'S&P 100 list: ' + listSource + '; daily closes: Stooq, else Yahoo Finance (end of day)', assets, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const what = process.argv[2] || 'all';
  mkdirSync(OUT, { recursive: true });
  for (const [kind, fn] of [['crypto', buildCrypto], ['us', buildUs]]) {
    if (what !== 'all' && what !== kind) continue;
    const file = join(OUT, kind + '.json');
    try {
      const doc = await fn();
      notice(kind + ': ' + doc.assets.length + ' assets, ' + doc.skipped.length + ' skipped');
      if (doc.skipped.length) notice(kind + ' skipped: ' + doc.skipped.slice(0, 25).map((x) => (x.id || x.symbol) + ' (' + x.reason + ')').join(', '));
      const min = kind === 'crypto' ? 50 : 60;
      if (doc.assets.length < min) {
        console.log('::warning::' + kind + ': only ' + doc.assets.length + ' assets (need ' + min + '); keeping the previous file');
        if (!existsSync(file)) writeFileSync(file, JSON.stringify(doc) + '\n');
        process.exitCode = 1;
        continue;
      }
      writeFileSync(file, JSON.stringify(doc) + '\n');
    } catch (e) { console.log('::warning::' + kind + ' failed: ' + e.message); process.exitCode = 1; }
  }
}
