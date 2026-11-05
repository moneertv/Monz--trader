const test = require('node:test');
const assert = require('node:assert');
require('../app/src/main/assets/www/core.js');
require('../app/src/main/assets/www/sources.js');
require('../app/src/main/assets/www/signals.js');
require('../app/src/main/assets/www/alerts.js');
const A = globalThis.MonzAlerts;

test('alert only when an action newly becomes STRONG', () => {
  const last = {};
  assert.strictEqual(A.decide(last, 'k', 'BUY'), false);
  assert.strictEqual(A.decide(last, 'k', 'STRONG BUY'), true);
  assert.strictEqual(A.decide(last, 'k', 'STRONG BUY'), false);   // no repeat every 15 minutes
  assert.strictEqual(A.decide(last, 'k', 'HOLD'), false);
  assert.strictEqual(A.decide(last, 'k', 'STRONG BUY'), true);    // re-entry alerts again
  assert.strictEqual(A.decide(last, 'k', 'STRONG SELL'), true);
});

test('provisional live point is appended or replaces today', () => {
  const s = [['2026-11-03', 10], ['2026-11-04', 11]];
  assert.deepStrictEqual(A.withLive(s, '2026-11-05', 12).series.slice(-1)[0], ['2026-11-05', 12]);
  const r = A.withLive(s, '2026-11-04', 11.5);
  assert.strictEqual(r.series.length, 2); assert.strictEqual(r.series[1][1], 11.5); assert.strictEqual(r.provisional, true);
  assert.strictEqual(A.withLive(s, '2026-11-02', 9).provisional, false);   // never rewrites the past
  assert.strictEqual(A.withLive(s, null, null).series.length, 2);
});

test('held keys come from the ledger (sold-out positions excluded)', () => {
  const st = { txs: [
    { type: 'BUY', on: '2026-01-01', asset: 'ASE:RJAL', account: 'default', quantity: '10', price: '0.5', currency: 'JOD', fees: '0' },
    { type: 'BUY', on: '2026-01-01', asset: 'ASE:JOPH', account: 'default', quantity: '5', price: '17', currency: 'JOD', fees: '0' },
    { type: 'SELL', on: '2026-02-01', asset: 'ASE:JOPH', account: 'default', quantity: '5', price: '18', currency: 'JOD', fees: '0' } ] };
  assert.deepStrictEqual(A.heldKeys(st), ['ASE:RJAL']);
});

test('strategy follows settings, then the strategy test', () => {
  assert.strictEqual(A.strategyFor({ settings: {} }, 'US'), 'trend');
  assert.strictEqual(A.strategyFor({ settings: {}, backtest: { markets: { US: { chosen: 'balanced' } } } }, 'US'), 'balanced');
  assert.strictEqual(A.strategyFor({ settings: { strategy: { US: 'dip' } }, backtest: { markets: { US: { chosen: 'balanced' } } } }, 'US'), 'dip');
});

test('message says provisional and gives levels', () => {
  const m = A.message({ action: 'STRONG SELL', name: 'JOPH', price: 13.9, currency: 'JOD', levels: { stop: 14.3 }, thesis: 'The trend is negative: price below average. More.' }, true, false);
  assert.ok(/STRONG SELL/.test(m.title) && /provisional/.test(m.body) && /14\.30/.test(m.body));
});

test('profit alert fires once at the threshold and re-arms after falling back', () => {
  const st = { txs: [{ type: 'BUY', on: '2026-01-01', asset: 'US:XOM', account: 'default', quantity: '2', price: '100', currency: 'USD', fees: '0' }] };
  const state = {};
  assert.strictEqual(A.profitHits(st, { 'US:XOM': { price: '115', currency: 'USD' } }, 20, state).length, 0);
  const h = A.profitHits(st, { 'US:XOM': { price: '121', currency: 'USD' } }, 20, state);
  assert.strictEqual(h.length, 1); assert.ok(/Up 21\.0%/.test(h[0].body), h[0].body);
  assert.strictEqual(A.profitHits(st, { 'US:XOM': { price: '125', currency: 'USD' } }, 20, state).length, 0);   // no repeat
  A.profitHits(st, { 'US:XOM': { price: '112', currency: 'USD' } }, 20, state);                                  // falls below 15%
  assert.strictEqual(A.profitHits(st, { 'US:XOM': { price: '122', currency: 'USD' } }, 20, state).length, 1);   // re-armed
});
