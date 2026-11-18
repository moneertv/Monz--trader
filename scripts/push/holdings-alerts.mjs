#!/usr/bin/env node
/* After the nightly data update: recompute each holding's signal (holdings and strategies from
 * data/watchlist.json; US and crypto prices from data/universe, Amman SE and gold from the
 * latest research file) and push a notification when a holding newly turns STRONG BUY or
 * STRONG SELL. State is kept in data/push-state.json so each change is pushed once. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serviceAccount, send } from './fcm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
await import(join(root, 'app/src/main/assets/www/signals.js'));
const G = globalThis.Signals;
const STRONG = new Set(['STRONG BUY', 'STRONG SELL']);
const read = (f, d) => { try { return JSON.parse(readFileSync(join(root, f), 'utf8')); } catch (e) { return d; } };
const fmt = (x) => (x >= 1000 ? x.toFixed(0) : x >= 10 ? x.toFixed(2) : x.toFixed(3));

export function evaluate(watchlist, universe, research, state) {
  const out = [], seriesFor = {};
  for (const kind of ['us', 'crypto']) for (const a of (universe[kind] && universe[kind].assets) || []) seriesFor[a.key] = { series: a.series, name: a.symbol + ' · ' + a.name, currency: 'USD' };
  const fresh = research && Date.now() - Date.parse(research.generated_at) < 3 * 86400000;
  if (fresh) for (const a of research.assets || []) if (!seriesFor[a.key] && Array.isArray(a.series) && a.series.length) seriesFor[a.key] = { series: a.series, name: a.name, currency: a.currency || 'JOD' };
  for (const h of watchlist.holdings || []) {
    const s = seriesFor[h.key];
    if (!s) continue;
    const a = G.analyze({ key: h.key, name: s.name, market: h.market, currency: s.currency, series: s.series, strategy: (watchlist.strategies || {})[h.market] || 'trend' });
    if (a.insufficient) continue;
    const prev = state[h.key];
    state[h.key] = a.action;
    if (STRONG.has(a.action) && prev !== a.action) {
      const L = a.levels || {};
      const lvl = a.action === 'STRONG BUY' ? 'stop ' + fmt(L.stop) + ', target ' + fmt(L.target) : 'invalid above ' + fmt(L.stop);
      out.push({ key: h.key, title: a.action + ' · ' + s.name, body: fmt(a.price) + ' ' + s.currency + ' (close ' + a.asOf + ') — ' + a.thesis.split('. ')[0] + '. ' + lvl + '. Not financial advice.' });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const statePath = join(root, 'data/push-state.json');
  const state = existsSync(statePath) ? read('data/push-state.json', {}) : {};
  const firstRun = !existsSync(statePath);
  const alerts = evaluate(read('data/watchlist.json', {}), { us: read('data/universe/us.json', null), crypto: read('data/universe/crypto.json', null) }, read('data/research/latest.json', null), state);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log('::notice::holding signals: ' + Object.entries(state).map(([k, v]) => k + ' ' + v).join(', '));
  let sa = null;
  try { sa = serviceAccount(); } catch (e) { console.log('::warning::' + e.message); }
  if (!sa) { if (alerts.length) console.log('::warning::' + alerts.length + ' alert(s) not pushed: add the FIREBASE_SERVICE_ACCOUNT secret'); process.exit(0); }
  if (firstRun) console.log('::notice::first run: recording current signals only');
  for (const a of firstRun ? [] : alerts) {
    try { await send(sa, a.title, a.body, a.key); console.log('::notice::pushed ' + a.title); }
    catch (e) { console.log('::warning::push failed for ' + a.key + ': ' + e.message); }
  }
}
