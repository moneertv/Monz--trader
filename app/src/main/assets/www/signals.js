/* Signals engine: deterministic indicators -> factor scores -> action, levels and explanation.
 * Every number comes from the price history passed in. Nothing is estimated by an AI and no
 * factor is scored without data: factors without a data source are reported as unavailable
 * and carry zero weight. This is a rules-based screen, not financial advice. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ indicators (closes only)
  const last = (a) => a[a.length - 1];
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const stdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const sma = (a, n) => (a.length >= n ? mean(a.slice(-n)) : null);
  function emaSeries(a, n) {
    if (a.length < n) return [];
    const k = 2 / (n + 1), out = [mean(a.slice(0, n))];
    for (let i = n; i < a.length; i++) out.push(a[i] * k + out[out.length - 1] * (1 - k));
    return out;
  }
  function rsi(a, n = 14) {
    if (a.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  }
  function macd(a) {
    const e12 = emaSeries(a, 12), e26 = emaSeries(a, 26);
    if (!e26.length) return null;
    const line = e26.map((v, i) => e12[i + 14] - v);              // align: e12 starts 14 earlier
    const sig = emaSeries(line, 9);
    if (!sig.length) return null;
    const m = last(line), s = last(sig);
    const prevHist = line.length > 1 && sig.length > 1 ? line[line.length - 2] - sig[sig.length - 2] : null;
    return { macd: m, signal: s, hist: m - s, prevHist };
  }
  function bollinger(a, n = 20, k = 2) {
    if (a.length < n) return null;
    const w = a.slice(-n), m = mean(w), sd = stdev(w);
    return { mid: m, upper: m + k * sd, lower: m - k * sd, pctB: sd ? (last(a) - (m - k * sd)) / (2 * k * sd) : 0.5 };
  }
  function returns(a) { const r = []; for (let i = 1; i < a.length; i++) if (a[i - 1] > 0) r.push(a[i] / a[i - 1] - 1); return r; }
  const pctChange = (a, n) => (a.length > n && a[a.length - 1 - n] > 0 ? (last(a) / a[a.length - 1 - n] - 1) * 100 : null);
  function maxDrawdown(a) { let peak = -Infinity, dd = 0; for (const x of a) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); } return dd * 100; }

  const clamp = (x, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, x));

  // ------------------------------------------------------------------ configuration
  const DEFAULT_WEIGHTS = { trend: 30, momentum: 25, meanReversion: 15, risk: 15, liquidity: 10, portfolio: 5, fundamental: 0, valuation: 0, macro: 0 };
  // Three strategies. 'trend' follows the move; 'dip' buys weakness inside an intact long-term uptrend;
  // 'balanced' sits between. Weights must not be tuned per stock (that would overfit the backtest).
  const STRATEGIES = {
    trend: { label: 'Trend', weights: DEFAULT_WEIGHTS },
    balanced: { label: 'Balanced', weights: { ...DEFAULT_WEIGHTS, trend: 20, momentum: 15, meanReversion: 35 } },
    dip: { label: 'Dip-buying', weights: { ...DEFAULT_WEIGHTS, trend: 10, momentum: 5, meanReversion: 55 } },
  };
  const PERIODS_PER_YEAR = { ASE: 250, CRYPTO: 365, GOLD: 365, US: 252 };
  const MIN_POINTS = 60;
  const HORIZON = 20;   // trading periods (~1 month)

  const ACTIONS = [[55, 'STRONG BUY'], [30, 'BUY'], [12, 'ACCUMULATE'], [-12, 'HOLD'], [-30, 'REDUCE'], [-55, 'SELL'], [-Infinity, 'STRONG SELL']];
  const actionFor = (score) => ACTIONS.find(([t]) => score >= t)[1];

  /**
   * analyze({ key, name, market, series: [[isoDate, price], ...], currency,
   *           portfolioWeightPct, staleDays, weights })
   * Returns null-free object; if data is insufficient returns { insufficient: reason }.
   */
  function analyze(input) {
    const { key, name, market, currency = 'JOD' } = input;
    const strategy = STRATEGIES[input.strategy] ? input.strategy : 'trend';
    const series = (input.series || []).filter((p) => Number.isFinite(p[1]) && p[1] > 0);
    if (series.length < MIN_POINTS) {
      return { key, name, market, insufficient: 'Needs at least ' + MIN_POINTS + ' daily prices; has ' + series.length + '.' };
    }
    const px = series.map((p) => p[1]), price = last(px), asOf = last(series)[0];
    const ppy = PERIODS_PER_YEAR[market] || 252;
    const r = returns(px);
    const vol20 = stdev(r.slice(-20)), volAnn = stdev(r.slice(-Math.min(r.length, 120))) * Math.sqrt(ppy) * 100;
    const s20 = sma(px, 20), s50 = sma(px, 50), s200 = sma(px, 200);
    const s50prev = px.length >= 60 ? mean(px.slice(-60, -10)) : null;
    const rsi14 = rsi(px), md = macd(px), bb = bollinger(px);
    const ch20 = pctChange(px, 20), ch60 = pctChange(px, 60);
    const look = px.slice(-61, -1);
    const support = Math.min(...look), resistance = Math.max(...look);
    const breakout = price > resistance, breakdown = price < support;
    const unchanged = r.slice(-60).filter((x) => x === 0).length / Math.min(60, r.length);

    const ind = { price, sma20: s20, sma50: s50, sma200: s200, rsi14, macd: md && md.macd, macdSignal: md && md.signal, macdHist: md && md.hist,
      bbUpper: bb && bb.upper, bbLower: bb && bb.lower, bbPctB: bb && bb.pctB, change20: ch20, change60: ch60, volAnnualPct: volAnn,
      support, resistance, maxDrawdownPct: maxDrawdown(px.slice(-Math.min(px.length, 250))), flatDaysPct: unchanged * 100, points: px.length };

    // ---- factor scores (-100..100) with the reasons that produced them
    const F = {}, why = {};
    { // trend
      let s = 0; const w = [];
      if (s50) { const d = (price / s50 - 1) * 100; s += clamp(d * 8, -40, 40); w.push('price ' + (d >= 0 ? 'above' : 'below') + ' 50-day average by ' + Math.abs(d).toFixed(1) + '%'); }
      if (s200) { const d = (price / s200 - 1) * 100; s += clamp(d * 4, -30, 30); w.push((d >= 0 ? 'above' : 'below') + ' 200-day average'); }
      else if (s20 && s50) { s += s20 > s50 ? 15 : -15; w.push('20-day average ' + (s20 > s50 ? 'above' : 'below') + ' 50-day'); }
      if (s50 && s50prev) { const sl = (s50 / s50prev - 1) * 100; s += clamp(sl * 10, -30, 30); w.push('50-day average ' + (sl >= 0 ? 'rising' : 'falling')); }
      F.trend = clamp(s); why.trend = w;
    }
    { // momentum
      let s = 0; const w = [];
      if (ch20 !== null) { s += clamp(ch20 * 4, -40, 40); w.push('20-day change ' + (ch20 >= 0 ? '+' : '') + ch20.toFixed(1) + '%'); }
      if (ch60 !== null) { s += clamp(ch60 * 2, -30, 30); w.push('60-day change ' + (ch60 >= 0 ? '+' : '') + ch60.toFixed(1) + '%'); }
      if (md) { const up = md.hist > 0; s += up ? 15 : -15; w.push('MACD ' + (up ? 'above' : 'below') + ' its signal line'); if (md.prevHist !== null && (md.prevHist > 0) !== up) { s += up ? 10 : -10; w.push('MACD just crossed ' + (up ? 'up' : 'down')); } }
      if (breakout) { s += 15; w.push('closed above its 60-day high (breakout)'); }
      if (breakdown) { s -= 15; w.push('closed below its 60-day low (breakdown)'); }
      F.momentum = clamp(s); why.momentum = w;
    }
    if (strategy !== 'trend') { // continuous reading: any dip below the middle scores, not only RSI < 30
      let s = 0; const w = [];
      if (rsi14 !== null) { s += (50 - rsi14) * 2.5; w.push('RSI ' + rsi14.toFixed(0) + (rsi14 < 30 ? ': oversold' : rsi14 > 70 ? ': overbought' : rsi14 < 45 ? ': below the middle (a dip)' : rsi14 > 55 ? ': above the middle (stretched)' : ': neutral')); }
      if (bb) { s += (0.5 - bb.pctB) * 60; w.push('at ' + Math.round(bb.pctB * 100) + '% of its Bollinger band (0% = lower band)'); }
      F.meanReversion = clamp(s); why.meanReversion = w;
    } else { // mean reversion: oversold is positive, overbought negative
      let s = 0; const w = [];
      if (rsi14 !== null) {
        if (rsi14 < 30) { s += (30 - rsi14) * 3 + 20; w.push('RSI ' + rsi14.toFixed(0) + ': oversold'); }
        else if (rsi14 > 70) { s -= (rsi14 - 70) * 3 + 20; w.push('RSI ' + rsi14.toFixed(0) + ': overbought'); }
        else w.push('RSI ' + rsi14.toFixed(0) + ': neutral');
      }
      if (bb) { if (bb.pctB < 0) { s += 20; w.push('below lower Bollinger band'); } else if (bb.pctB > 1) { s -= 20; w.push('above upper Bollinger band'); } }
      F.meanReversion = clamp(s); why.meanReversion = w;
    }
    { // risk: lower volatility scores higher; scale differs by market
      const ref = market === 'CRYPTO' ? 60 : 25;
      F.risk = clamp((ref - volAnn) * (market === 'CRYPTO' ? 1.5 : 3));
      why.risk = ['annualised volatility ' + volAnn.toFixed(0) + '%', 'max drawdown ' + ind.maxDrawdownPct.toFixed(0) + '% over the period'];
    }
    { // liquidity: ASE stocks that rarely change price or have stale closes are penalised
      let s = market === 'CRYPTO' ? 60 : 30; const w = [];
      if (market === 'ASE') {
        s = clamp(60 - unchanged * 200);
        w.push(Math.round(unchanged * 100) + '% of the last 60 sessions closed unchanged');
        if (input.staleDays > 0) { s -= 40; w.push('no closing price for ' + input.staleDays + ' trading day(s)'); }
      } else w.push(market === 'CRYPTO' ? 'trades around the clock on many exchanges' : 'liquid market');
      F.liquidity = clamp(s); why.liquidity = w;
    }
    { // portfolio suitability: discourage adding to an already large position
      const wgt = input.portfolioWeightPct || 0;
      F.portfolio = wgt > 40 ? -80 : wgt > 25 ? -40 : wgt > 0 ? 10 : 30;
      why.portfolio = [wgt ? 'is ' + wgt.toFixed(1) + '% of your priced portfolio' : 'not in your portfolio yet (adds diversification)'];
    }
    const unavailable = { fundamental: 'no earnings/financial-statement source connected', valuation: 'no P/E or book-value source per company',
      macro: 'no macro data source connected' };

    const weights = Object.assign({}, STRATEGIES[strategy].weights, input.weights || {});
    for (const k of Object.keys(unavailable)) weights[k] = 0;
    const totalW = Object.keys(F).reduce((s, k) => s + (weights[k] || 0), 0);
    const contributions = {};
    let score = 0;
    for (const k of Object.keys(F)) { contributions[k] = (F[k] * (weights[k] || 0)) / totalW; score += contributions[k]; }
    // Don't let a risky asset reach the strongest buy band on momentum alone
    if (F.risk < -50 && score > 30) score = 30;
    // Dip-buying guard: a dip only counts as a buying chance while the long-term trend is intact.
    let guardNote = null;
    if (strategy !== 'trend' && score > 11) {
      const longAvg = s200 || s50;
      const longPrev = px.length > 70 ? mean(px.slice(-(s200 ? 220 : 70), -20)) : null;
      if (longAvg && price < longAvg * 0.9 && longPrev && longAvg < longPrev) {
        score = 11;
        guardNote = 'held at HOLD: the price is more than 10% below its ' + (s200 ? '200' : '50') + '-day average and that average is falling, so this looks like a downtrend, not a dip';
      }
    }

    // ---- confidence: data depth x agreement between the main directional factors
    const dir = [F.trend, F.momentum, F.meanReversion].filter((x) => Math.abs(x) > 5);
    // agreement only counts fully when at least two of the three directional factors have an opinion
    const agree = dir.length ? (Math.abs(dir.reduce((s, x) => s + Math.sign(x), 0)) / dir.length) * Math.min(1, dir.length / 2) : 0;
    const depth = Math.min(1, px.length / 200);
    const confidence = Math.round(Math.max(10, Math.min(85, 25 + 35 * agree + 25 * depth + Math.min(15, Math.abs(score) / 4) - (market === 'ASE' && unchanged > 0.5 ? 15 : 0))));

    // ---- levels from volatility (close-to-close; no intraday highs/lows are available)
    const move = price * vol20 * Math.sqrt(HORIZON);           // ~1 sigma over the horizon
    let action = actionFor(score);
    let bullish = score >= 12, bearish = score <= -12;
    let entryLow = null, entryHigh = null, target, stop;
    const levelNotes = [];
    if (bullish) {
      entryLow = Math.max(support, price - 0.5 * move); entryHigh = price;
      stop = Math.max(support * 0.99, price - 1.5 * move);          // nearer of: below the 60-day low, or 1.5 sigma
      if (stop >= price) stop = price - move;
      target = Math.max(resistance > price * 1.005 ? resistance : 0, price + 2 * move);
    } else if (bearish) {
      target = Math.max(0, Math.min(support, price - 1.5 * move));  // where the decline may run to
      stop = Math.min(resistance * 1.01, price + 1.5 * move);        // a close above this invalidates the bearish view
      if (stop <= price) stop = price + move;
    } else {
      target = resistance; stop = support;
    }
    let rr = bullish ? (target - price) / Math.max(1e-9, price - stop) : bearish ? (price - target) / Math.max(1e-9, stop - price) : null;
    // A buy whose upside is smaller than its risk is downgraded one step, and said so.
    if (bullish && rr < 1) {
      const order = ['STRONG BUY', 'BUY', 'ACCUMULATE', 'HOLD'];
      action = order[Math.min(order.length - 1, order.indexOf(action) + 1)];
      levelNotes.push('downgraded one step: potential gain is smaller than the distance to the stop (reward/risk ' + rr.toFixed(2) + ')');
      if (action === 'HOLD') { bullish = false; entryLow = entryHigh = null; target = resistance; stop = support; rr = null; }
    }

    const invalidation = bullish
      ? ['a close below ' + stop.toFixed(dp(price)) + ' ' + currency, s50 ? 'price falling back below the 50-day average (' + s50.toFixed(dp(price)) + ')' : null, 'RSI rising above 75']
      : bearish
        ? ['a close above ' + stop.toFixed(dp(price)) + ' ' + currency, s50 ? 'price recovering above the 50-day average (' + s50.toFixed(dp(price)) + ')' : null]
        : ['a close above ' + resistance.toFixed(dp(price)) + ' (breakout) or below ' + support.toFixed(dp(price)) + ' (breakdown)'];

    const risks = [];
    if (volAnn > (market === 'CRYPTO' ? 70 : 30)) risks.push('high volatility (' + volAnn.toFixed(0) + '% a year): position size accordingly');
    if (market === 'ASE' && unchanged > 0.4) risks.push('thin trading: the shown price may not be achievable for larger orders');
    if (input.staleDays > 0) risks.push('the last close is ' + input.staleDays + ' trading day(s) old');
    if ((input.portfolioWeightPct || 0) > 25) risks.push('already a large part of your portfolio (concentration)');
    if (market === 'CRYPTO') risks.push('crypto can fall sharply in hours; levels are based on daily closes');
    if (market === 'ASE') risks.push('no company financials are included in this score');
    risks.push('signals use past prices only; they do not predict the future');

    if (guardNote) levelNotes.unshift(guardNote);
    const thesis = buildThesis(action, F, why, ind, market, currency) + (levelNotes.length ? ' Note: ' + levelNotes.join('; ') + '.' : '');
    return {
      key, name, market, currency, asOf, price, action, strategy, strategyLabel: STRATEGIES[strategy].label, score: Math.round(score), confidence,
      factors: F, weights, contributions, why, unavailable, indicators: ind,
      levels: { entryLow, entryHigh, target, stop, riskReward: rr, horizon: market === 'CRYPTO' ? '2–4 weeks' : '3–6 weeks' },
      invalidation: invalidation.filter(Boolean), risks, thesis,
    };
  }
  const dp = (price) => (price >= 1000 ? 0 : price >= 10 ? 2 : 3);

  function buildThesis(action, F, why, ind, market, ccy) {
    const strongest = Object.entries(F).filter(([k]) => ['trend', 'momentum', 'meanReversion'].includes(k)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const lead = strongest[0];
    const label = { trend: 'trend', momentum: 'momentum', meanReversion: 'overbought/oversold reading' }[lead[0]];
    const tone = lead[1] >= 0 ? 'supportive' : 'negative';
    let t = 'The ' + label + ' is ' + tone + ': ' + (why[lead[0]][0] || '') + '. ';
    if (strongest[1] && Math.abs(strongest[1][1]) > 10) t += 'Also, ' + (why[strongest[1][0]][0] || '') + '. ';
    if (action === 'HOLD') t += 'Signals are mixed, so the rules suggest waiting for a clearer move. ';
    t += 'Volatility is ' + ind.volAnnualPct.toFixed(0) + '% a year; recent range ' + ind.support.toFixed(dp(ind.price)) + '–' + ind.resistance.toFixed(dp(ind.price)) + ' ' + ccy + '.';
    return t;
  }

  /** Score how past signals played out: return from signal price to current price, by direction. */
  function evaluate(history, priceNow) {
    return history.map((h) => {
      const p = priceNow[h.key];
      if (!p) return { ...h, outcome: null };
      const ret = (p / h.price - 1) * 100;
      const bullish = ['STRONG BUY', 'BUY', 'ACCUMULATE'].includes(h.action), bearish = ['REDUCE', 'SELL', 'STRONG SELL'].includes(h.action);
      return { ...h, priceNow: p, returnPct: ret, correct: bullish ? ret > 0 : bearish ? ret < 0 : null };
    });
  }

  root.Signals = { analyze, evaluate, rsi, macd, sma, emaSeries, bollinger, actionFor, DEFAULT_WEIGHTS, STRATEGIES, MIN_POINTS };
})(typeof window !== 'undefined' ? window : globalThis);
