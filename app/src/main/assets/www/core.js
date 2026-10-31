/* Monz Trader core: exact decimals, FX, cost-basis ledger, returns.
 * Ported from the Python engine (backend/app) and covered by the same test cases (core.test.js). */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ Decimal (BigInt, 18 dp)
  const SCALE = 18;
  const ONE = 10n ** 18n;

  function parseDec(x) {
    if (x instanceof Dec) return x.v;
    if (x === null || x === undefined || x === '') throw new Error('Empty number');
    let s = typeof x === 'number' ? (Number.isFinite(x) ? (Math.abs(x) < 1e21 ? x.toFixed(SCALE) : String(x)) : 'NaN') : String(x).trim().replace(/,/g, '');
    if (!/^[-+]?\d*\.?\d*$/.test(s) || s === '' || s === '.' || s === '-' || s === '+') throw new Error('Invalid number: ' + x);
    let neg = s[0] === '-';
    if (s[0] === '-' || s[0] === '+') s = s.slice(1);
    let [i, f = ''] = s.split('.');
    f = (f + '0'.repeat(SCALE)).slice(0, SCALE);
    const v = BigInt(i || '0') * ONE + BigInt(f || '0');
    return neg ? -v : v;
  }

  class Dec {
    constructor(v) { this.v = v; }
    static of(x) { return x instanceof Dec ? x : new Dec(parseDec(x)); }
    static tryOf(x) { try { return Dec.of(x); } catch (e) { return null; } }
    add(o) { return new Dec(this.v + Dec.of(o).v); }
    sub(o) { return new Dec(this.v - Dec.of(o).v); }
    mul(o) { return new Dec(divRound(this.v * Dec.of(o).v, ONE)); }
    div(o) { const b = Dec.of(o).v; if (b === 0n) throw new Error('Division by zero'); return new Dec(divRound(this.v * ONE, b)); }
    /** this * a / b with a single rounding step */
    mulDiv(a, b) { const bb = Dec.of(b).v; if (bb === 0n) throw new Error('Division by zero'); return new Dec(divRound(this.v * Dec.of(a).v, bb)); }
    cmp(o) { const b = Dec.of(o).v; return this.v < b ? -1 : this.v > b ? 1 : 0; }
    eq(o) { return this.cmp(o) === 0; }
    gt(o) { return this.cmp(o) > 0; }
    lt(o) { return this.cmp(o) < 0; }
    isZero() { return this.v === 0n; }
    neg() { return new Dec(-this.v); }
    abs() { return this.v < 0n ? this.neg() : this; }
    min(o) { return this.cmp(o) <= 0 ? this : Dec.of(o); }
    toNumber() { return Number(this.toString()); }
    toString() {
      const neg = this.v < 0n, a = neg ? -this.v : this.v;
      let i = (a / ONE).toString(), f = (a % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
      return (neg ? '-' : '') + i + (f ? '.' + f : '');
    }
    toFixed(dp) {
      const q = 10n ** BigInt(SCALE - dp);
      const r = divRound(this.v, q);
      const neg = r < 0n, a = neg ? -r : r, m = 10n ** BigInt(dp);
      const i = (a / m).toString(), f = dp ? '.' + (a % m).toString().padStart(dp, '0') : '';
      return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + f;
    }
  }
  function divRound(a, b) {          // round half away from zero
    const neg = (a < 0n) !== (b < 0n);
    const aa = a < 0n ? -a : a, bb = b < 0n ? -b : b;
    let q = aa / bb;
    if ((aa % bb) * 2n >= bb) q += 1n;
    return neg ? -q : q;
  }
  const ZERO = new Dec(0n);
  const sum = (arr) => arr.reduce((s, x) => s.add(x), ZERO);

  // ------------------------------------------------------------------ dates
  const iso = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const daysBetween = (a, b) => Math.round((Date.parse(iso(b)) - Date.parse(iso(a))) / 86400000);

  // ------------------------------------------------------------------ FX
  class FxRateUnavailable extends Error {}

  class FxService {
    constructor() { this.book = {}; }
    add(r) {   // {base, quote, on, rate, source, standing}
      const key = r.base.toUpperCase() + '/' + r.quote.toUpperCase();
      const s = (this.book[key] = this.book[key] || []);
      const rec = { ...r, on: iso(r.on), rate: Dec.of(r.rate) };
      const i = s.findIndex((x) => x.on >= rec.on);
      if (i === -1) s.push(rec);
      else if (s[i].on === rec.on) s[i] = rec;
      else s.splice(i, 0, rec);
    }
    lookup(base, quote, on) {
      const s = this.book[base + '/' + quote];
      if (!s) return null;
      let best = null;
      for (const r of s) { if (r.on <= on) best = r; else break; }
      return best;
    }
    rate(base, quote, on, via = 'USD') {
      base = base.toUpperCase(); quote = quote.toUpperCase(); on = iso(on);
      if (base === quote) return { rate: Dec.of(1), rateDate: on, path: 'identity', sources: [] };
      const d = this.lookup(base, quote, on);
      if (d) return { rate: d.rate, rateDate: d.standing ? on : d.on, path: base + '->' + quote, sources: [d.source] };
      const inv = this.lookup(quote, base, on);
      if (inv) return { rate: Dec.of(1).div(inv.rate), rateDate: inv.standing ? on : inv.on, path: '1/(' + quote + '->' + base + ')', sources: [inv.source] };
      if (via && via !== base && via !== quote) {
        try {
          const a = this.rate(base, via, on, ''), b = this.rate(via, quote, on, '');
          return { rate: a.rate.mul(b.rate), rateDate: a.rateDate < b.rateDate ? a.rateDate : b.rateDate, path: a.path + ' x ' + b.path, sources: a.sources.concat(b.sources) };
        } catch (e) { if (!(e instanceof FxRateUnavailable)) throw e; }
      }
      throw new FxRateUnavailable('No ' + base + '/' + quote + ' rate on or before ' + on);
    }
    convert(amount, from, to, on) { return Dec.of(amount).mul(this.rate(from, to, on).rate); }
  }

  const CBJ_PEG = { base: 'USD', quote: 'JOD', on: '1995-10-23', rate: '0.709', source: 'Central Bank of Jordan USD peg', standing: true };

  // ------------------------------------------------------------------ Ledger
  class AccountingError extends Error {}

  class Ledger {
    /** methods: {assetKey: 'FIFO'|'AVERAGE'} ; defaultMethod */
    constructor(fx, methods = {}, defaultMethod = 'FIFO') {
      this.fx = fx; this.methods = methods; this.defaultMethod = defaultMethod;
      this.positions = {}; this.realized = []; this.income = [];
      this.expensesJod = ZERO; this.netContribJod = ZERO; this.cashFlowsJod = [];
    }
    jod(amount, ccy, on) { return this.fx.convert(amount, ccy, 'JOD', on); }

    applyAll(txs) {
      const sorted = txs.map((t, i) => [t, i]).sort((a, b) => (a[0].on < b[0].on ? -1 : a[0].on > b[0].on ? 1 : a[1] - b[1]));
      for (const [t] of sorted) this.apply(t);
      return this;
    }
    apply(tx) {
      const h = this['on_' + tx.type];
      if (!h) throw new AccountingError('Unknown transaction type ' + tx.type);
      h.call(this, tx);
    }
    position(tx) {
      const ccy = tx.currency.toUpperCase();
      let p = this.positions[tx.asset];
      if (!p) p = this.positions[tx.asset] = { asset: tx.asset, currency: ccy, method: this.methods[tx.asset] || this.defaultMethod, lots: [] };
      else if (p.currency !== ccy) throw new AccountingError(tx.asset + ': currency ' + ccy + ' differs from position currency ' + p.currency);
      return p;
    }
    static qty(p, account) { return sum(p.lots.filter((l) => account === undefined || l.account === account).map((l) => l.quantity)); }
    static cost(p) { return sum(p.lots.map((l) => l.cost)); }
    static costJod(p) { return sum(p.lots.map((l) => l.costJod)); }

    mergeAverage(p, lot) {
      const pool = p.lots.find((l) => l.account === lot.account);
      if (!pool) { p.lots.push(lot); return; }
      pool.quantity = pool.quantity.add(lot.quantity);
      pool.cost = pool.cost.add(lot.cost);
      pool.costJod = pool.costJod.add(lot.costJod);
      if (lot.acquired < pool.acquired) pool.acquired = lot.acquired;
    }
    take(p, account, qty) {
      const avail = Ledger.qty(p, account);
      if (qty.gt(avail)) throw new AccountingError(p.asset + ': cannot remove ' + qty + ' from "' + account + '", only ' + avail + ' held');
      const out = []; let rem = qty;
      const lots = p.lots.filter((l) => l.account === account).sort((a, b) => (a.acquired < b.acquired ? -1 : 1));
      for (const lot of lots) {
        if (!rem.gt(0)) break;
        const use = lot.quantity.min(rem);
        let part;
        if (use.eq(lot.quantity)) {
          part = { ...lot };
          lot.quantity = ZERO; lot.cost = ZERO; lot.costJod = ZERO;
        } else {
          const c = lot.cost.mulDiv(use, lot.quantity), cj = lot.costJod.mulDiv(use, lot.quantity);
          lot.quantity = lot.quantity.sub(use); lot.cost = lot.cost.sub(c); lot.costJod = lot.costJod.sub(cj);
          part = { account: lot.account, acquired: lot.acquired, quantity: use, cost: c, costJod: cj };
        }
        out.push(part); rem = rem.sub(use);
      }
      p.lots = p.lots.filter((l) => l.quantity.gt(0));
      return out;
    }
    on_BUY(tx) {
      const q = Dec.of(tx.quantity), pr = Dec.of(tx.price), f = Dec.of(tx.fees || 0);
      if (!q.gt(0) || pr.lt(0) || f.lt(0)) throw new AccountingError('Invalid BUY values');
      const p = this.position(tx);
      const total = q.mul(pr).add(f);
      const lot = { account: tx.account || 'default', acquired: tx.on, quantity: q, cost: total, costJod: this.jod(total, tx.currency, tx.on) };
      if (p.method === 'AVERAGE') this.mergeAverage(p, lot); else p.lots.push(lot);
    }
    on_SELL(tx) {
      const q = Dec.of(tx.quantity), pr = Dec.of(tx.price), f = Dec.of(tx.fees || 0);
      if (!q.gt(0) || pr.lt(0) || f.lt(0)) throw new AccountingError('Invalid SELL values');
      const p = this.positions[tx.asset];
      if (!p) throw new AccountingError('SELL of ' + tx.asset + ' with no position');
      if (tx.currency.toUpperCase() !== p.currency) throw new AccountingError(tx.asset + ': sell currency differs from position currency');
      const slices = this.take(p, tx.account || 'default', q);
      const proceeds = q.mul(pr).sub(f), proceedsJod = this.jod(proceeds, tx.currency, tx.on);
      let remP = proceeds, remPJ = proceedsJod;
      slices.forEach((s, i) => {
        const last = i === slices.length - 1;
        const pp = last ? remP : proceeds.mulDiv(s.quantity, q), pj = last ? remPJ : proceedsJod.mulDiv(s.quantity, q);
        remP = remP.sub(pp); remPJ = remPJ.sub(pj);
        this.realized.push({ on: tx.on, asset: tx.asset, quantity: s.quantity, proceeds: pp, cost: s.cost, gain: pp.sub(s.cost),
          proceedsJod: pj, costJod: s.costJod, gainJod: pj.sub(s.costJod), currency: p.currency, holdingDays: daysBetween(s.acquired, tx.on) });
      });
    }
    on_TRANSFER(tx) {
      if (!tx.toAccount || tx.toAccount === tx.account) throw new AccountingError('TRANSFER needs a different destination account');
      const p = this.positions[tx.asset];
      if (!p) throw new AccountingError('TRANSFER of ' + tx.asset + ' with no position');
      for (const lot of this.take(p, tx.account || 'default', Dec.of(tx.quantity))) {
        lot.account = tx.toAccount;
        if (p.method === 'AVERAGE') this.mergeAverage(p, lot); else p.lots.push(lot);
      }
      const f = Dec.of(tx.fees || 0);
      if (f.gt(0)) this.expensesJod = this.expensesJod.add(this.jod(f, tx.currency, tx.on));
    }
    on_SPLIT(tx) {
      const r = Dec.of(tx.ratio);
      if (!r.gt(0)) throw new AccountingError('SPLIT needs a positive ratio');
      const p = this.positions[tx.asset];
      if (p) for (const l of p.lots) l.quantity = l.quantity.mul(r);
    }
    incomeTx(tx) {
      const a = Dec.of(tx.amount);
      this.income.push({ on: tx.on, asset: tx.asset, amount: a, currency: tx.currency, amountJod: this.jod(a, tx.currency, tx.on), type: tx.type });
    }
    on_DIVIDEND(tx) { this.incomeTx(tx); }
    on_INTEREST(tx) { this.incomeTx(tx); }
    on_DISTRIBUTION(tx) { this.incomeTx(tx); }
    on_FEE(tx) { this.expensesJod = this.expensesJod.add(this.jod(Dec.of(tx.amount), tx.currency, tx.on)); }
    on_DEPOSIT(tx) { const j = this.jod(Dec.of(tx.amount), tx.currency, tx.on); this.netContribJod = this.netContribJod.add(j); this.cashFlowsJod.push([tx.on, j.neg()]); }
    on_WITHDRAWAL(tx) { const j = this.jod(Dec.of(tx.amount), tx.currency, tx.on); this.netContribJod = this.netContribJod.sub(j); this.cashFlowsJod.push([tx.on, j]); }

    realizedJod() { return sum(this.realized.map((e) => e.gainJod)); }
    incomeJod() { return sum(this.income.map((i) => i.amountJod)); }

    /** prices: {asset: {price, currency}} — assets without a price are reported unpriced, never valued at cost */
    valuation(prices, on) {
      on = iso(on);
      const rows = []; let totV = ZERO, totC = ZERO;
      for (const asset of Object.keys(this.positions).sort()) {
        const p = this.positions[asset], q = Ledger.qty(p);
        if (q.isZero()) continue;
        const cost = Ledger.cost(p), costJod = Ledger.costJod(p);
        const row = { asset, quantity: q, currency: p.currency, cost, costJod, avgCost: cost.div(q), price: null, value: null, valueJod: null,
          unrealized: null, unrealizedJod: null, retNative: null, retJod: null };
        const pq = prices[asset];
        if (pq && pq.price !== null && pq.price !== undefined) {
          let price = Dec.of(pq.price);
          if (pq.currency.toUpperCase() !== p.currency) price = this.fx.convert(price, pq.currency, p.currency, on);
          const value = q.mul(price), valueJod = this.jod(value, p.currency, on);
          Object.assign(row, { price, value, valueJod, unrealized: value.sub(cost), unrealizedJod: valueJod.sub(costJod),
            retNative: cost.gt(0) ? value.div(cost).sub(1).mul(100) : null, retJod: costJod.gt(0) ? valueJod.div(costJod).sub(1).mul(100) : null });
          totV = totV.add(valueJod); totC = totC.add(costJod);
        }
        rows.push(row);
      }
      for (const r of rows) r.allocation = r.valueJod && totV.gt(0) ? r.valueJod.div(totV).mul(100) : null;
      return { rows, totalValueJod: totV, totalCostJodPriced: totC, unrealizedJod: totV.sub(totC), realizedJod: this.realizedJod(),
        incomeJod: this.incomeJod(), expensesJod: this.expensesJod, unpriced: rows.filter((r) => r.value === null).map((r) => r.asset) };
    }
  }

  // ------------------------------------------------------------------ returns
  function xirr(flows) {
    const f = flows.map(([d, a]) => [iso(d), Number(a.toString ? a.toString() : a)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!f.some(([, a]) => a > 0) || !f.some(([, a]) => a < 0)) throw new Error('XIRR needs positive and negative flows');
    const t0 = Date.parse(f[0][0]);
    const ts = f.map(([d, a]) => [(Date.parse(d) - t0) / 86400000 / 365, a]);
    const npv = (r) => ts.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
    const dnpv = (r) => ts.reduce((s, [t, a]) => s - (t * a) / Math.pow(1 + r, t + 1), 0);
    let r = 0.1;
    for (let i = 0; i < 200; i++) {
      const fv = npv(r), d = dnpv(r);
      if (!d) break;
      const nr = r - fv / d;
      if (nr <= -0.999999 || !Number.isFinite(nr)) break;
      if (Math.abs(nr - r) < 1e-10) return nr;
      r = nr;
    }
    let lo = -0.9999, hi = 100, flo = npv(lo);
    for (let i = 0; i < 500; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-9) return mid;
      if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  }

  root.Core = { Dec, ZERO, sum, iso, daysBetween, FxService, FxRateUnavailable, CBJ_PEG, Ledger, AccountingError, xirr };
})(typeof window !== 'undefined' ? window : globalThis);
