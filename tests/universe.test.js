const test = require('node:test');
const assert = require('node:assert');

test('coin filter removes stablecoins, wrapped and gold tokens', async () => {
  const { isTradableCoin } = await import('../scripts/universe/build.mjs');
  assert.strictEqual(isTradableCoin({ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100000 }), true);
  assert.strictEqual(isTradableCoin({ id: 'tether', symbol: 'usdt', name: 'Tether', current_price: 1 }), false);
  assert.strictEqual(isTradableCoin({ id: 'wrapped-bitcoin', symbol: 'wbtc', name: 'Wrapped Bitcoin', current_price: 100000 }), false);
  assert.strictEqual(isTradableCoin({ id: 'staked-ether', symbol: 'steth', name: 'Lido Staked Ether', current_price: 4000 }), false);
  assert.strictEqual(isTradableCoin({ id: 'pax-gold', symbol: 'paxg', name: 'PAX Gold', current_price: 4000 }), false);
});

test('S&P 100 table parse', async () => {
  const { parseSp100 } = await import('../scripts/universe/build.mjs');
  const html = '<table class="wikitable" id="constituents"><tr><th>Symbol</th><th>Name</th><th>Sector</th></tr>' +
    '<tr><td><a>AAPL</a></td><td><a>Apple Inc.</a></td><td>Information Technology</td></tr><tr><td>BRK.B</td><td>Berkshire Hathaway</td><td>Financials</td></tr></table>';
  assert.deepStrictEqual(parseSp100(html), [['AAPL', 'Apple Inc.', 'Information Technology'], ['BRK.B', 'Berkshire Hathaway', 'Financials']]);
});

test('Stooq and Yahoo parsers', async () => {
  const { parseStooq, parseYahoo } = await import('../scripts/universe/build.mjs');
  assert.deepStrictEqual(parseStooq('Date,Open,High,Low,Close,Volume\n2026-11-03,1,2,1,1.5,100\n2026-11-04,1,2,1,1.6,100'), [['2026-11-03', 1.5], ['2026-11-04', 1.6]]);
  assert.strictEqual(parseStooq('No data'), null);
  const y = parseYahoo({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [1793800000, 1793886400], indicators: { quote: [{ close: [100, 101] }] } }] } });
  assert.strictEqual(y.length, 2); assert.strictEqual(y[1][1], 101);
});

test('history validation', async () => {
  const { validate } = await import('../scripts/universe/build.mjs');
  const today = Date.now();
  const s = Array.from({ length: 150 }, (_, i) => [new Date(today - (149 - i) * 86400000).toISOString().slice(0, 10), 10 + i * 0.01]);
  assert.strictEqual(validate(s), null);
  assert.ok(validate(s.slice(0, 50)));
  const bad = s.slice(); bad[100] = [bad[100][0], 50]; assert.ok(/jump/.test(validate(bad)));
});

test('Kraken pair map', async () => {
  const { krakenPairs } = await import('../scripts/universe/build.mjs');
  const m = krakenPairs({ result: { XXBTZUSD: { base: 'XXBT', quote: 'ZUSD' }, SOLUSD: { base: 'SOL', quote: 'USD' }, XDGUSD: { base: 'XXDG', quote: 'ZUSD' }, SOLEUR: { base: 'SOL', quote: 'ZEUR' }, 'XXBTZUSD.d': { base: 'XXBT', quote: 'ZUSD' } } });
  assert.strictEqual(m.BTC, 'XXBTZUSD'); assert.strictEqual(m.SOL, 'SOLUSD'); assert.strictEqual(m.DOGE, 'XDGUSD');
});
