const test = require('node:test');
const assert = require('node:assert');
require('../app/src/main/assets/www/signals.js');
const G = globalThis.Signals;

const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const mk = (prices) => days(prices.length).map((d, i) => [d, prices[i]]);
// deterministic pseudo-noise
const noise = (i) => Math.sin(i * 1.7) * 0.004 + Math.cos(i * 0.9) * 0.003;

test('RSI reference values', () => {
  assert.strictEqual(G.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 100);
  const r = G.rsi([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]);
  assert.ok(Math.abs(r - 70.53) < 0.1, 'Wilder RSI example ≈70.53, got ' + r);   // classic Wilder/StockCharts example
});

test('MACD sign follows trend', () => {
  const up = Array.from({ length: 80 }, (_, i) => 10 + i * 0.1);
  assert.ok(G.macd(up).macd > 0);
  assert.ok(G.macd(up.slice().reverse()).macd < 0);
});

test('insufficient history gives no recommendation', () => {
  const a = G.analyze({ key: 'ASE:X', market: 'ASE', series: mk(Array(30).fill(1)) });
  assert.ok(a.insufficient);
});

test('steady uptrend -> bullish with sane levels', () => {
  const p = Array.from({ length: 200 }, (_, i) => 5 * (1 + 0.003 * i) * (1 + noise(i)));
  const a = G.analyze({ key: 'ASE:UP', name: 'Up', market: 'ASE', series: mk(p) });
  assert.ok(['BUY', 'STRONG BUY', 'ACCUMULATE'].includes(a.action), a.action + ' ' + a.score);
  assert.ok(a.levels.stop < a.price && a.levels.target > a.price && a.levels.entryLow <= a.levels.entryHigh);
  assert.ok(a.levels.riskReward > 0);
  assert.ok(a.thesis.length > 20 && a.invalidation.length >= 1);
  assert.strictEqual(a.weights.fundamental, 0);
  const sum = Object.values(a.contributions).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(Math.round(sum) - a.score) <= 1);
});

test('steady downtrend -> bearish', () => {
  const p = Array.from({ length: 200 }, (_, i) => 5 * (1 - 0.003 * i) * (1 + noise(i)));
  const a = G.analyze({ key: 'ASE:DN', market: 'ASE', series: mk(p) });
  assert.ok(['SELL', 'STRONG SELL', 'REDUCE'].includes(a.action), a.action + ' ' + a.score);
  assert.ok(a.levels.stop > a.price && a.levels.target < a.price);
});

test('illiquid flat ASE stock is penalised and not a buy', () => {
  const p = Array.from({ length: 120 }, (_, i) => (i % 15 === 0 ? 1.01 : 1.0));
  const a = G.analyze({ key: 'ASE:FLAT', market: 'ASE', series: mk(p), staleDays: 3 });
  assert.ok(a.factors.liquidity < 0);
  assert.ok(!['BUY', 'STRONG BUY'].includes(a.action));
});

test('large position lowers portfolio factor', () => {
  const p = Array.from({ length: 200 }, (_, i) => 5 * (1 + 0.003 * i) * (1 + noise(i)));
  const small = G.analyze({ key: 'k', market: 'ASE', series: mk(p), portfolioWeightPct: 0 });
  const big = G.analyze({ key: 'k', market: 'ASE', series: mk(p), portfolioWeightPct: 60 });
  assert.ok(big.factors.portfolio < small.factors.portfolio && big.score < small.score);
});

test('evaluate past signals', () => {
  const r = G.evaluate([{ key: 'a', action: 'BUY', price: 10 }, { key: 'b', action: 'SELL', price: 10 }, { key: 'c', action: 'HOLD', price: 10 }], { a: 11, b: 11, c: 9 });
  assert.deepStrictEqual(r.map((x) => x.correct), [true, false, null]);
});

test('strategies: a dip in an uptrend is a buy for dip-buying, not for trend', () => {
  // long uptrend, then a sharp 8-day pullback
  const p = Array.from({ length: 220 }, (_, i) => 5 * (1 + 0.003 * i) * (1 + noise(i)));
  for (let k = 0; k < 8; k++) p[212 + k] = p[211] * (1 - 0.012 * (k + 1));
  const s = mk(p);
  const dip = G.analyze({ key: 'k', market: 'ASE', series: s, strategy: 'dip' });
  const trend = G.analyze({ key: 'k', market: 'ASE', series: s, strategy: 'trend' });
  assert.strictEqual(dip.strategy, 'dip');
  assert.ok(dip.score > trend.score, 'dip ' + dip.score + ' vs trend ' + trend.score);
  assert.ok(['BUY', 'STRONG BUY', 'ACCUMULATE'].includes(dip.action), dip.action);
});

test('strategies: dip-buying refuses a broken downtrend', () => {
  const p = Array.from({ length: 220 }, (_, i) => 5 * (1 - 0.003 * i) * (1 + noise(i)));
  for (let k = 0; k < 8; k++) p[212 + k] = p[211] * (1 - 0.012 * (k + 1));
  const a = G.analyze({ key: 'k', market: 'ASE', series: mk(p), strategy: 'dip' });
  assert.ok(!['BUY', 'STRONG BUY', 'ACCUMULATE'].includes(a.action), a.action + ' ' + a.score);
});
