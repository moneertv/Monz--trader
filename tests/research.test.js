const test = require('node:test');
const assert = require('node:assert');

const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const up = (n, base) => days(n).map((d, i) => [d, +(base * (1 + 0.003 * i) * (1 + Math.sin(i * 1.7) * 0.004)).toFixed(4)]);
const wl = { holdings: [{ key: 'ASE:RJAL', name: 'RJ', market: 'ASE' }], watch: [{ key: 'US:HLAL', name: 'HLAL', market: 'US' }] };
const prices = { 'ASE:RJAL': { name: 'Royal Jordanian', market: 'ASE', currency: 'JOD', source: 'ASE', url: 'https://www.exchange.jo/en/company_historical/RJAL', series: up(120, 0.5) } };

test('build merges deterministic signal with sourced research', async () => {
  const { build } = await import('../scripts/research/build.mjs');
  const qual = { 'ASE:RJAL': { news: [{ date: '2026-10-30', headline: 'x', source: 'Petra', url: 'https://petra.gov.jo/x', impact: 'neutral' }],
    review: { thesis: 'ok', data_gaps: ['no analyst coverage'] } } };
  const { errors, doc } = build(prices, qual, wl);
  assert.deepStrictEqual(errors, []);
  const a = doc.assets.find((x) => x.key === 'ASE:RJAL');
  assert.ok(a.recommendation && a.recommendation.levels.target > 0);
  assert.strictEqual(a.recommendation.action, a.technical.action);
  assert.strictEqual(a.news.length, 1);
  assert.ok(doc.assets.find((x) => x.key === 'US:HLAL').data_gaps.includes('no price history collected'));
});

test('build rejects unsourced facts and big action changes', async () => {
  const { build } = await import('../scripts/research/build.mjs');
  const qual = { 'ASE:RJAL': { fundamentals: [{ label: 'P/E', value: '9' }], review: { action: 'STRONG SELL', reason: 'x' } } };
  const { errors } = build(prices, qual, wl);
  assert.ok(errors.some((e) => /without source/.test(e)));
  assert.ok(errors.some((e) => /more than one step/.test(e)));
});

test('series validation', async () => {
  const { validateSeries } = await import('../scripts/research/build.mjs');
  assert.deepStrictEqual(validateSeries('k', [['2026-01-01', 1], ['2026-01-02', 1.1]]), []);
  assert.ok(validateSeries('k', [['2026-01-02', 1], ['2026-01-01', 1]]).length);
  assert.ok(validateSeries('k', [['2026-01-01', 1], ['2026-01-02', 3]]).length);
});
