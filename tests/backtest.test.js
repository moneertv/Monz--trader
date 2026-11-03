const test = require('node:test');
const assert = require('node:assert');
require('../app/src/main/assets/www/signals.js');
require('../app/src/main/assets/www/backtest.js');
const B = globalThis.Backtest;

const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const mk = (p) => days(p.length).map((d, i) => [d, p[i]]);
const noise = (i) => Math.sin(i * 1.7) * 0.004 + Math.cos(i * 0.9) * 0.003;

test('trend strategy makes money in a steady uptrend and reports a benchmark', () => {
  const s = mk(Array.from({ length: 200 }, (_, i) => 5 * (1 + 0.003 * i) * (1 + noise(i))));
  const r = B.runOne(s, 'ASE', 'trend');
  assert.ok(r.total > 0, 'total ' + r.total);
  assert.ok(r.buyHold.total > 0 && r.trades >= 0 && r.exposure > 0);
  assert.ok(r.total <= r.buyHold.total + 1e-9, 'cannot beat holding a pure uptrend after costs');
});

test('costs are applied: a flat price with trades loses money', () => {
  const p = Array.from({ length: 200 }, (_, i) => 5 * (1 + Math.sin(i / 6) * 0.05));
  const r0 = B.runOne(mk(p), 'ASE', 'balanced', { cost: 0 });
  const r1 = B.runOne(mk(p), 'ASE', 'balanced', { cost: 0.02 });
  if (r0.trades > 0) assert.ok(r1.total < r0.total);
});

test('no look-ahead: changing future prices does not change past equity decisions', () => {
  const base = Array.from({ length: 200 }, (_, i) => 5 * (1 + 0.002 * i) * (1 + noise(i)));
  const a = B.runOne(mk(base), 'ASE', 'trend');
  const changed = base.slice(); for (let i = 190; i < 200; i++) changed[i] *= 0.5;
  const b = B.runOne(mk(changed), 'ASE', 'trend');
  assert.strictEqual(a.train, b.train);   // train period ends before day 190
});

test('summarise picks on train and reports test', () => {
  const s = mk(Array.from({ length: 200 }, (_, i) => 5 * (1 + 0.003 * i) * (1 + noise(i))));
  const results = {}; for (const k of B.STRATS) results[k] = B.runOne(s, 'ASE', k);
  const sum = B.summarise('ASE', [{ key: 'x', results }]);
  assert.ok(B.STRATS.includes(sum.chosen));
  assert.strictEqual(sum.chosenTest, sum.by[sum.chosen].test);
  assert.ok(sum.buyHold.test !== null && sum.period.split > sum.period.from);
});
