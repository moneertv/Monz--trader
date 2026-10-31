// Run: node --test tests/   (same cases as the Python engine's tests)
const test = require('node:test');
const assert = require('node:assert');
require('../app/src/main/assets/www/core.js');
require('../app/src/main/assets/www/sources.js');
const { Dec, FxService, Ledger, AccountingError, xirr, CBJ_PEG, FxRateUnavailable } = globalThis.Core;
const S = globalThis.Sources;
const eq = (a, b) => assert.strictEqual(Dec.of(a).toString(), Dec.of(b).toString());

function fx() {
  const f = new FxService();
  f.add({ base: 'USD', quote: 'JOD', on: '2020-01-01', rate: '0.709', source: 't' });
  f.add({ base: 'USD', quote: 'EUR', on: '2026-01-01', rate: '0.90', source: 't' });
  f.add({ base: 'USD', quote: 'EUR', on: '2026-06-01', rate: '0.80', source: 't' });
  return f;
}
const buy = (asset, on, quantity, price, currency = 'USD', fees = '0', account = 'ib') => ({ type: 'BUY', asset, on, quantity, price, currency, fees, account });
const sell = (asset, on, quantity, price, currency = 'USD', fees = '0', account = 'ib') => ({ type: 'SELL', asset, on, quantity, price, currency, fees, account });
const gains = (L) => L.realized.reduce((s, e) => s.add(e.gain), Dec.of(0));

test('decimal basics', () => {
  eq(Dec.of('0.1').add('0.2'), '0.3');
  eq(Dec.of('10').div('4').mul('4'), '10');
  eq(Dec.of('10').mulDiv('3', '3'), '10');
  eq(Dec.of('5.5E-2'), '0.055');
  assert.strictEqual(Dec.of('1234.5678').toFixed(2), '1,234.57');
  assert.strictEqual(Dec.of('-0.0005').toFixed(3), '-0.001');
});

test('FIFO realized gain with fees', () => {
  const L = new Ledger(fx()).applyAll([buy('AAPL', '2026-01-02', '10', '100', 'USD', '10'), buy('AAPL', '2026-02-02', '10', '120'), sell('AAPL', '2026-03-02', '15', '130', 'USD', '15')]);
  eq(gains(L), '325');
  eq(Ledger.qty(L.positions.AAPL), '5');
  eq(L.realizedJod(), Dec.of('325').mul('0.709'));
});

test('average cost', () => {
  const L = new Ledger(fx(), { AAPL: 'AVERAGE' }).applyAll([buy('AAPL', '2026-01-02', '10', '100'), buy('AAPL', '2026-02-02', '10', '120'), sell('AAPL', '2026-03-02', '15', '130')]);
  eq(gains(L), '300');
});

test('transfer keeps basis, no gain, fee expensed', () => {
  const L = new Ledger(fx()).applyAll([buy('BTC', '2026-01-02', '1', '40000', 'USD', '0', 'binance'),
    { type: 'TRANSFER', asset: 'BTC', on: '2026-02-01', account: 'binance', toAccount: 'ledger', quantity: '0.5', currency: 'USD', fees: '5' }]);
  assert.strictEqual(L.realized.length, 0);
  eq(Ledger.qty(L.positions.BTC, 'ledger'), '0.5');
  eq(Ledger.cost(L.positions.BTC), '40000');
  eq(L.expensesJod, Dec.of('5').mul('0.709'));
});

test('cannot sell from wrong account', () => {
  const L = new Ledger(fx()).applyAll([buy('BTC', '2026-01-02', '1', '40000', 'USD', '0', 'binance')]);
  assert.throws(() => L.apply(sell('BTC', '2026-02-01', '0.5', '50000', 'USD', '0', 'ledger')), AccountingError);
});

test('split keeps basis', () => {
  const L = new Ledger(fx()).applyAll([buy('NVDA', '2026-01-02', '10', '1000'), { type: 'SPLIT', asset: 'NVDA', on: '2026-06-10', ratio: '10' }]);
  eq(Ledger.qty(L.positions.NVDA), '100'); eq(Ledger.cost(L.positions.NVDA), '10000');
});

test('currency-adjusted return', () => {
  const L = new Ledger(fx()).applyAll([buy('SAP', '2026-01-05', '10', '100', 'EUR')]);
  const r = L.valuation({ SAP: { price: '110', currency: 'EUR' } }, '2026-07-01').rows[0];
  eq(r.retNative, '10');
  assert.strictEqual(r.retJod.toFixed(2), '23.75');
});

test('gold at bid, unpriced asset not valued', () => {
  const L = new Ledger(fx()).applyAll([buy('GOLD_21K', '2026-09-01', '20', '76.000', 'JOD', '40'), buy('ARBK', '2026-09-01', '100', '3.5', 'JOD')]);
  const v = L.valuation({ GOLD_21K: { price: '75.400', currency: 'JOD' } }, '2026-10-31');
  const g = v.rows.find((r) => r.asset === 'GOLD_21K');
  eq(g.cost, '1560'); eq(g.unrealized, '-52');
  assert.deepStrictEqual(v.unpriced, ['ARBK']);
});

test('xirr excel reference', () => {
  const r = xirr([['2008-01-01', -10000], ['2008-03-01', 2750], ['2008-10-30', 4250], ['2009-02-15', 3250], ['2009-04-01', 2750]]);
  assert.ok(Math.abs(r - 0.373362535) < 1e-6);
});

test('fx cross via peg, no back-fill', () => {
  const f = new FxService(); f.add(CBJ_PEG);
  S.parseFrankfurter({ base: 'USD', date: '2026-10-30', rates: { EUR: 0.92 } }).forEach((r) => f.add(r));
  const r = f.rate('EUR', 'JOD', '2026-10-31');
  assert.strictEqual(r.rate.toFixed(6), Dec.of('0.709').div('0.92').toFixed(6));
  assert.strictEqual(r.rateDate, '2026-10-30');
  assert.throws(() => f.rate('EUR', 'JOD', '2025-01-01'), FxRateUnavailable);
});

const ROYA = { data: [{ updated_at: '2026-10-31 11:40:00',
  sell_24: { price: '91.100', increase: false }, buy_24: { price: '87.400', increase: false },
  sell_21: { price: '79.300', increase: false }, buy_21: { price: '75.400', increase: false },
  sell_14: { price: '0.000', increase: false }, buy_14: { price: '0.000', increase: false },
  sell_rashadi: { price: '560.100', increase: true }, buy_rashadi: { price: '527.800', increase: true } }] };

test('roya parse', () => {
  const qs = Object.fromEntries(S.parseRoya(ROYA).map((q) => [q.symbol, q]));
  assert.deepStrictEqual(Object.keys(qs).sort(), ['GOLD_21K', 'GOLD_24K', 'GOLD_LIRA_RASHADI']);
  eq(qs.GOLD_21K.price, '75.4'); eq(qs.GOLD_21K.extra.ask, '79.3');
  assert.strictEqual(qs.GOLD_21K.marketTs, '2026-10-31T08:40:00.000Z');
  assert.throws(() => S.parseRoya({ data: [{ price24: 1 }] }), S.SchemaChanged);
});

// Shapes copied from the real exchange.jo files (31 Oct 2026)
test('ase closing prices (wide file)', () => {
  const book = { sheets: [{ name: 'Worksheet', rows: [
    ['Symbol', 'Code', 'Name', '2026-10-27', '2026-10-28', '2026-10-29'],
    ['ARBK', '113023', 'ARAB BANK', '7.27', '7.28', '7.39'],
    ['JOWM', '141014', 'THE JORDAN WORSTED MILLS', '2.85', '2.84', ''],
    ['XXXX', '1', 'NO PRICES', '', '', ''],
  ] }] };
  const parsed = S.parseClosingPrices(book);
  assert.strictEqual(parsed.latestDate, '2026-10-29');
  const q = Object.fromEntries(S.closingQuotes(parsed).map((x) => [x.symbol, x]));
  eq(q.ARBK.price, '7.39'); eq(q.ARBK.extra.change, '0.11'); assert.strictEqual(q.ARBK.extra.name, 'ARAB BANK');
  assert.strictEqual(q.ARBK.extra.notTradedSinceFileDate, false);
  eq(q.JOWM.price, '2.84'); assert.strictEqual(q.JOWM.extra.notTradedSinceFileDate, true);
  assert.ok(!q.XXXX);
  assert.throws(() => S.parseClosingPrices({ sheets: [{ name: 'x', rows: [['a', 'b']] }] }), S.SchemaChanged);
});

test('ase market summary (daily trading data)', () => {
  const book = { sheets: [{ name: 'Sheet1', rows: [
    [], [],
    ['', 'التاريخ', 'القيمة السوقية (دينار)', 'حجم التداول (دينار)'],
    ['', 'Date', 'Market Capitalization (JD)', 'Value Traded (JD)', 'No. of Shares Traded', 'No. of Transactions', 'Free Float Index ASEGI', 'Percentage Change %', 'Free Float Index ASE20', 'Total Return Index ASETR', 'P/E'],
    ['', '46324', '28919398466.059998', '14928580', '5122203', '5386', '4117.33', '5.9296846331240917E-2', '2222.4699999999998', '3074.89', '11.377305171651717'],
    ['', '46323', '28852000098.449997', '15818019', '5118835', '4982', '4114.8900000000003', '-0.92981598696042367', '2221.4', '3073.41', '11.349646665930965'],
  ] }] };
  const m = S.parseMarketSummary(book);
  assert.strictEqual(m.date, '2026-10-29');
  eq(m.asegi, '4117.33'); eq(m.trades, '5386');
  assert.strictEqual(m.changePct.toFixed(4), '0.0593');
  assert.strictEqual(m.asegiHistory.length, 2);
});

test('ase company history page', () => {
  const html = '<h1 class="x">ALIA- THE ROYAL JORDANIAN AIRLINES PLC. Historical</h1><table><thead><tr><th>Date</th><th>High</th><th>Low</th><th>Closing</th><th>Value Traded</th><th>No. of Trans</th><th>No. of Shares</th></tr></thead>' +
    '<tbody><tr><td>29/10/2026</td><td>0.53</td><td>0.51</td><td>0.53</td><td>1,160</td><td>7</td><td>2,264</td></tr>' +
    '<tr><td>28/10/2026</td><td>0.53</td><td>0.51</td><td>0.52</td><td>342</td><td>8</td><td>658</td></tr></tbody></table>';
  const p = S.parseCompanyHistorical(html);
  assert.strictEqual(p.name, 'ALIA- THE ROYAL JORDANIAN AIRLINES PLC.');
  assert.strictEqual(p.rows.length, 2); assert.strictEqual(p.rows[0].on, '2026-10-29'); eq(p.rows[0].value, '1160');
  const q = S.companyQuote('RJAL', p.name, p.rows);
  eq(q.price, '0.53'); eq(q.extra.change, '0.01'); eq(q.extra.volume, '2264');
  assert.deepStrictEqual(S.parseCompanyHistorical('<h1>Nothing</h1>').rows, []);
});

test('stale flag', () => {
  const q = S.parseRoya(ROYA)[0];
  assert.strictEqual(S.checked(q, Date.parse('2026-11-02T00:00:00Z')).status, 'stale');
  assert.strictEqual(S.checked(q, Date.parse('2026-10-31T12:00:00Z')).status, 'delayed');
});
