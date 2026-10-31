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

test('ase workbook parse', () => {
  const book = { sheets: [{ name: 'Sheet1', rows: [
    ['Amman Stock Exchange'], [],
    ['Date', 'Symbol', 'Company Name', 'Previous Close', 'Closing Price', 'No. of Shares', 'Value Traded', 'No. of Transactions'],
    ['46323', 'ARBK', 'ARAB BANK', '5.1', '5.10', '12000', '61200', '40'],
    ['29/10/2026', 'ARBK', 'ARAB BANK', '5.1', '5.20', '15000', '78000', '51'],
    ['2026-10-29', 'JOPH', 'JORDAN PHOSPHATE', '30', '30', '0', '0', '0'],
  ] }] };
  const bars = S.parseAseWorkbook(book);
  assert.strictEqual(bars[0].on, '2026-10-28');
  const q = Object.fromEntries(S.aseQuotes(bars).map((x) => [x.symbol, x]));
  eq(q.ARBK.price, '5.2'); eq(q.ARBK.extra.change, '0.1');
  assert.strictEqual(q.JOPH.extra.noTrades, true);
  assert.throws(() => S.parseAseWorkbook({ sheets: [{ name: 'x', rows: [['a', 'b']] }] }), S.SchemaChanged);
});

test('stale flag', () => {
  const q = S.parseRoya(ROYA)[0];
  assert.strictEqual(S.checked(q, Date.parse('2026-11-02T00:00:00Z')).status, 'stale');
  assert.strictEqual(S.checked(q, Date.parse('2026-10-31T12:00:00Z')).status, 'delayed');
});
