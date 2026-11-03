/* Backtester for the signal strategies.
 * - Long-only, one position per asset, all-in / all-out (a fair way to compare strategies).
 * - No look-ahead: the signal on day t uses closes up to t only, and the trade fills at the
 *   close of day t+1.
 * - Costs per side by market (commission + fees + bid/ask spread).
 * - Exits on a REDUCE/SELL/STRONG SELL signal or when a close falls below the stop set at entry.
 * - Train/test: the first 60% of the tradable days choose the strategy; the last 40% (unseen)
 *   report how that choice actually did. Buy-and-hold over the same days is the benchmark.
 * Results describe the past only. */
(function (root) {
  'use strict';
  const G = root.Signals;
  const COST_PER_SIDE = { ASE: 0.006, US: 0.0015, GOLD: 0.02, CRYPTO: 0.0025 };
  const COST_NOTE = { ASE: '0.6% per trade (broker, ASE/SDC fees, spread on thin stocks)', US: '0.15% per trade', GOLD: '2% per trade (shop buy/sell gap on physical gold)', CRYPTO: '0.25% per trade' };
  const BULL = new Set(['STRONG BUY', 'BUY', 'ACCUMULATE']), BEAR = new Set(['REDUCE', 'SELL', 'STRONG SELL']);
  const STRATS = ['trend', 'balanced', 'dip'];
  const TRAIN_FRACTION = 0.6;

  /** Run one strategy on one price series. series: [[date, close], ...] ascending. */
  function runOne(series, market, strategy, opts = {}) {
    const warm = opts.warmup || G.MIN_POINTS, cost = opts.cost !== undefined ? opts.cost : COST_PER_SIDE[market] || 0.003;
    const n = series.length;
    if (n < warm + 20) return null;
    const px = series.map((p) => p[1]);
    let inPos = false, units = 0, cash = 1, stop = null, entryEq = null, pending = null;
    const equity = new Array(n).fill(null), trades = [];
    let daysIn = 0;
    for (let t = warm - 1; t < n; t++) {
      // 1) execute yesterday's decision at today's close
      if (pending === 'buy' && !inPos) { units = (cash * (1 - cost)) / px[t]; cash = 0; inPos = true; entryEq = units * px[t] / (1 - cost); trades.push({ in: series[t][0], inPx: px[t] }); }
      else if (pending === 'sell' && inPos) { cash = units * px[t] * (1 - cost); units = 0; inPos = false; const tr = trades[trades.length - 1]; tr.out = series[t][0]; tr.outPx = px[t]; tr.ret = cash / entryEq - 1; stop = null; }
      pending = null;
      equity[t] = inPos ? units * px[t] : cash;
      if (inPos) daysIn++;
      if (t === n - 1) break;
      // 2) decide using data up to today only
      if (inPos && stop !== null && px[t] < stop) { pending = 'sell'; continue; }
      const a = G.analyze({ key: 'bt', market, series: series.slice(0, t + 1), strategy });
      if (a.insufficient) continue;
      if (!inPos && BULL.has(a.action)) { pending = 'buy'; stop = a.levels && Number.isFinite(a.levels.stop) && a.levels.stop < px[t] ? a.levels.stop : null; }
      else if (inPos && BEAR.has(a.action)) pending = 'sell';
    }
    const open = trades.length && !trades[trades.length - 1].out;
    if (open) { const tr = trades[trades.length - 1]; tr.ret = (units * px[n - 1] * (1 - cost)) / entryEq - 1; tr.open = true; }
    const start = warm - 1, split = start + Math.floor((n - 1 - start) * TRAIN_FRACTION);
    const r = (a, b) => (equity[a] ? equity[b] / equity[a] - 1 : null);
    const bh = (a, b) => px[b] / px[a] - 1;
    let peak = -Infinity, dd = 0;
    for (let t = start; t < n; t++) { peak = Math.max(peak, equity[t]); dd = Math.min(dd, equity[t] / peak - 1); }
    const closed = trades.filter((x) => x.ret !== undefined);
    return {
      strategy, from: series[start][0], splitDate: series[split][0], to: series[n - 1][0],
      total: r(start, n - 1), train: r(start, split), test: r(split, n - 1),
      buyHold: { total: bh(start, n - 1), train: bh(start, split), test: bh(split, n - 1) },
      maxDrawdown: dd, trades: closed.length, winRate: closed.length ? closed.filter((x) => x.ret > 0).length / closed.length : null,
      exposure: daysIn / (n - start), inPositionNow: inPos,
    };
  }

  const avg = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

  /** Summarise many runOne results for one market and choose a strategy on the train period. */
  function summarise(market, perAsset) {
    const by = {};
    for (const s of STRATS) {
      const rs = perAsset.map((a) => a.results[s]).filter(Boolean);
      by[s] = { strategy: s, label: G.STRATEGIES[s].label, assets: rs.length, train: avg(rs.map((x) => x.train)), test: avg(rs.map((x) => x.test)), total: avg(rs.map((x) => x.total)),
        maxDrawdown: avg(rs.map((x) => x.maxDrawdown)), trades: rs.reduce((s2, x) => s2 + x.trades, 0), winRate: avg(rs.map((x) => x.winRate)), exposure: avg(rs.map((x) => x.exposure)) };
    }
    const anyRes = perAsset.map((a) => a.results.trend || a.results.balanced || a.results.dip).filter(Boolean);
    const buyHold = { train: avg(anyRes.map((x) => x.buyHold.train)), test: avg(anyRes.map((x) => x.buyHold.test)), total: avg(anyRes.map((x) => x.buyHold.total)) };
    const ranked = STRATS.filter((s) => by[s].train !== null).sort((a, b) => by[b].train - by[a].train);
    const chosen = ranked[0] || 'trend';
    const beatBH = by[chosen].test !== null && buyHold.test !== null && by[chosen].test > buyHold.test;
    return { market, assets: perAsset.length, by, buyHold, chosen, chosenTest: by[chosen].test, beatsBuyHoldOnTest: beatBH,
      period: anyRes.length ? { from: anyRes[0].from, split: anyRes[0].splitDate, to: anyRes[0].to } : null, costNote: COST_NOTE[market] };
  }

  /** Async runner that yields to the UI between assets. assets: [{key, name, market, series}] */
  async function runAll(assets, onProgress) {
    const perMarket = {};
    let done = 0;
    for (const a of assets) {
      const results = {};
      for (const s of STRATS) results[s] = runOne(a.series, a.market, s);
      if (results.trend) (perMarket[a.market] = perMarket[a.market] || []).push({ key: a.key, name: a.name, results });
      done++;
      if (onProgress) onProgress(done, assets.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    const markets = {};
    for (const [m, list] of Object.entries(perMarket)) markets[m] = { ...summarise(m, list), perAsset: list };
    return { ranAt: new Date().toISOString(), markets };
  }

  root.Backtest = { runOne, summarise, runAll, COST_PER_SIDE, COST_NOTE, STRATS, TRAIN_FRACTION };
})(typeof window !== 'undefined' ? window : globalThis);
