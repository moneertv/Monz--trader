/* Background strong-signal check (runs in an invisible WebView every ~15 minutes, and in tests).
 * Reads the app's saved state read-only (localStorage "monz.v1"), writes only its own key
 * ("monz.alerts"), so it never overwrites anything the open app is doing.
 *
 * For each holding: latest price (live where the source has it) is added to the saved daily
 * history as a provisional close for today, the signal is recomputed with the strategy the app
 * uses for that market, and a notification is posted when the action newly becomes STRONG BUY or
 * STRONG SELL. Research recommendations (★) that are STRONG are alerted once per research run. */
(function (root) {
  'use strict';
  const MAIN_KEY = 'monz.v1', ALERT_KEY = 'monz.alerts';
  const STRONG = new Set(['STRONG BUY', 'STRONG SELL']);
  const OUNCE_G = 31.1034768, USD_JOD = 0.709;

  const load = (k, dflt) => { try { return JSON.parse(root.localStorage.getItem(k) || 'null') || dflt; } catch (e) { return dflt; } };
  const ammanToday = (ms = Date.now()) => new Date(ms + 3 * 3600000).toISOString().slice(0, 10);

  function strategyFor(st, market) {
    const choice = ((st.settings || {}).strategy || {})[market] || 'auto';
    if (choice !== 'auto') return choice;
    const bt = st.backtest && st.backtest.markets && st.backtest.markets[market];
    return bt ? bt.chosen : 'trend';
  }

  /** Holdings with quantity > 0, from the saved transactions. */
  function heldKeys(st) {
    const C = root.Core;
    try {
      const fx = new C.FxService(); fx.add(C.CBJ_PEG); for (const r of st.fx || []) fx.add(r);
      const L = new C.Ledger(fx).applyAll(st.txs || []);
      return Object.keys(L.positions).filter((k) => C.Ledger.qty(L.positions[k]).gt(0));
    } catch (e) {
      const q = {};
      for (const t of st.txs || []) if (t.asset && (t.type === 'BUY' || t.type === 'SELL')) q[t.asset] = (q[t.asset] || 0) + (t.type === 'BUY' ? 1 : -1) * Number(t.quantity);
      return Object.keys(q).filter((k) => q[k] > 1e-12);
    }
  }

  /** Saved daily history + a provisional point for `liveDate` (replaces the same day if present). */
  function withLive(series, liveDate, livePrice) {
    const s = (series || []).filter((p) => Number.isFinite(p[1]));
    if (!liveDate || !Number.isFinite(livePrice) || livePrice <= 0) return { series: s, provisional: false };
    const last = s.length ? s[s.length - 1][0] : null;
    if (last && liveDate < last) return { series: s, provisional: false };
    const out = last === liveDate ? s.slice(0, -1) : s.slice();
    out.push([liveDate, livePrice]);
    return { series: out, provisional: true };
  }

  /** Decide whether an action is a new alert, updating `last` in place. */
  function decide(last, key, action) {
    const prev = last[key];
    last[key] = action;
    return STRONG.has(action) && prev !== action;
  }

  async function seriesFor(st, key, research) {
    const S = root.Sources, [m, ...rest] = key.split(':'), sym = rest.join(':');
    const name = (k) => { const q = (st.quotes || {})[k]; return sym + (q && q.extra && q.extra.name ? ' · ' + q.extra.name : ''); };
    if (m === 'ASE') {
      const r = await S.fetchCompanyHistory(sym, 1);
      const merged = {};
      for (const [d, v] of (st.aseHistory || {})[sym] || []) merged[d] = Number(v);
      for (const row of r.rows) merged[row.on] = Number(row.close.toString());
      const series = Object.keys(merged).sort().map((d) => [d, merged[d]]);
      return { key, name: sym + (r.name ? ' · ' + r.name : ''), market: 'ASE', currency: 'JOD', series, provisional: false, price: series.length ? series[series.length - 1][1] : null };
    }
    if (m === 'US') {
      const ra = research && (research.assets || []).find((x) => x.key === key);
      const base = (ra && ra.series) || [];
      let live = null, date = null;
      if (st.settings && st.settings.finnhubKey) {
        try { const q = await S.fetchStock(sym, st.settings.finnhubKey); live = Number(q.price.toString()); date = (q.marketTs || '').slice(0, 10) || ammanToday(); } catch (e) { /* keep history only */ }
      }
      const w = withLive(base, date, live);
      return { key, name: sym + (ra ? ' · ' + ra.name : ''), market: 'US', currency: 'USD', ...w, price: w.series.length ? w.series[w.series.length - 1][1] : null };
    }
    if (m === 'GOLD') {
      const base = ((st.goldGlobal && st.goldGlobal.series) || []).map(([d, v]) => [d, (v * USD_JOD) / OUNCE_G]);
      let live = null;
      try { const q = await S.fetchCrypto(['pax-gold'], (st.settings || {}).coingeckoKey); live = (Number(q[0].price.toString()) * USD_JOD) / OUNCE_G; } catch (e) { /* history only */ }
      const w = withLive(base, ammanToday(), live);
      return { key: 'GOLD:GLOBAL', name: 'Gold (global, per gram 24K)', market: 'GOLD', currency: 'JOD', ...w, price: w.series.length ? w.series[w.series.length - 1][1] : null };
    }
    if (m === 'CRYPTO') {
      const base = ((st.cryptoHistory || {})[sym] || {}).series || [];
      let live = null;
      try { const q = await S.fetchCrypto([sym], (st.settings || {}).coingeckoKey); live = Number(q[0].price.toString()); } catch (e) { /* history only */ }
      const w = withLive(base, new Date().toISOString().slice(0, 10), live);
      return { key, name: name(key), market: 'CRYPTO', currency: 'USD', ...w, price: w.series.length ? w.series[w.series.length - 1][1] : null };
    }
    return null;
  }

  const fmtPx = (x) => (x >= 1000 ? x.toFixed(0) : x >= 10 ? x.toFixed(2) : x.toFixed(3));
  function message(a, provisional, viaResearch) {
    const L = a.levels || {};
    const lvl = a.action === 'STRONG BUY' ? (Number.isFinite(L.stop) ? 'stop ' + fmtPx(L.stop) : '') + (Number.isFinite(L.target) ? ', target ' + fmtPx(L.target) : '')
      : Number.isFinite(L.stop) ? 'invalid above ' + fmtPx(L.stop) : '';
    const why = (a.thesis || '').split('. ')[0].replace(/\.$/, '');
    return {
      title: a.action + ' · ' + a.name,
      body: fmtPx(a.price) + ' ' + a.currency + (provisional ? ' (intraday, provisional)' : '') + (viaResearch ? ' · daily research' : '') + ' — ' + why + (lvl ? '. ' + lvl : '') + '. Not financial advice.',
    };
  }

  async function run(opts = {}) {
    const st = load(MAIN_KEY, null);
    const al = load(ALERT_KEY, { last: {}, research: {}, log: [] });
    al.last = al.last || {}; al.research = al.research || {}; al.log = al.log || [];
    const out = [];
    const finish = (err) => { al.lastCheck = new Date().toISOString(); al.lastError = err || null; try { root.localStorage.setItem(ALERT_KEY, JSON.stringify(al)); } catch (e) { /* ignore */ } return out; };
    if (!st || !(st.settings && st.settings.alerts && st.settings.alerts.on) && !opts.force) return finish('alerts are off');
    const held = heldKeys(st);
    if (!held.length) return finish('no holdings');
    let research = st.research || null;
    try { research = await root.Sources.fetchResearch(); } catch (e) { /* use the saved copy */ }
    const seen = new Set(), errors = [], prices = {};
    for (const k of held) {
      const key = k.startsWith('GOLD:') ? 'GOLD:GLOBAL' : k;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const s = await seriesFor(st, k, research);
        if (s && Number.isFinite(s.price) && !k.startsWith('GOLD:')) prices[k] = { price: String(s.price), currency: s.currency };
        if (!s || s.series.length < root.Signals.MIN_POINTS) continue;
        const a = root.Signals.analyze({ key: s.key, name: s.name, market: s.market, currency: s.currency, series: s.series, strategy: strategyFor(st, s.market) });
        if (a.insufficient) continue;
        if (decide(al.last, s.key, a.action)) {
          const msg = message(a, s.provisional, false);
          out.push({ key: s.key, ...msg });
          al.log.unshift({ at: new Date().toISOString(), key: s.key, name: a.name, action: a.action, price: a.price, currency: a.currency, provisional: s.provisional, source: 'live check', text: msg.body });
          if (root.NativeBridge) root.NativeBridge.notify(msg.title, msg.body, s.key);
        }
      } catch (e) { errors.push(k + ': ' + e.message); }
    }
    // Daily research (★): alert once per research run for a STRONG recommendation on a holding
    if (research && research.assets) {
      for (const r of research.assets) {
        if (!seen.has(r.key) || !r.recommendation || !STRONG.has(r.recommendation.action)) continue;
        const stamp = research.generated_at + '|' + r.recommendation.action;
        if (al.research[r.key] === stamp) continue;
        al.research[r.key] = stamp;
        const a = { action: r.recommendation.action, name: r.name, price: r.price ? r.price.value : NaN, currency: r.currency || '', levels: r.recommendation.levels, thesis: r.recommendation.thesis };
        const msg = message(a, false, true);
        out.push({ key: r.key, ...msg });
        al.log.unshift({ at: new Date().toISOString(), key: r.key, name: r.name, action: a.action, price: a.price, currency: a.currency, provisional: false, source: 'daily research', text: msg.body });
        if (root.NativeBridge) root.NativeBridge.notify(msg.title + ' ★', msg.body, r.key);
      }
    }
    // Profit target: notify once when a holding's gain in JOD reaches the threshold (default +20%)
    const pa = (st.settings && st.settings.profitAlert) || { on: true, pct: 20 };
    if (pa.on !== false) {
      try {
        if (held.some((k) => k.startsWith('GOLD:'))) {
          try {   // physical gold is valued at today's shop-buy (bid) price, like the app
            const g = await root.Sources.fetchGold(ammanToday());
            for (const q of g.quotes) if (q.extra && q.extra.bid) prices['GOLD:' + q.symbol] = { price: q.extra.bid.toString(), currency: 'JOD' };
          } catch (e) { errors.push('gold price: ' + e.message); }
        }
        al.profit = al.profit || {};
        for (const hit of profitHits(st, prices, pa.pct || 20, al.profit)) {
          out.push(hit);
          al.log.unshift({ at: new Date().toISOString(), key: hit.key, name: hit.name, action: '+' + (pa.pct || 20) + '% PROFIT', price: hit.price, currency: hit.currency, provisional: false, source: 'profit target', text: hit.body });
          if (root.NativeBridge) root.NativeBridge.notify(hit.title, hit.body, hit.openKey);
        }
      } catch (e) { errors.push('profit check: ' + e.message); }
    }
    al.log = al.log.slice(0, 100);
    return finish(errors.length ? errors.join('; ') : null);
  }

  /** Holdings whose JOD gain newly reached `pct`. State per asset: 'above' until it falls 5 points below. */
  function profitHits(st, prices, pct, state) {
    const C = root.Core;
    const fx = new C.FxService(); fx.add(C.CBJ_PEG); for (const r of st.fx || []) fx.add(r);
    const L = new C.Ledger(fx).applyAll(st.txs || []);
    const v = L.valuation(prices, ammanToday());
    const hits = [];
    for (const r of v.rows) {
      if (r.retJod === null || r.retJod === undefined) continue;
      const ret = r.retJod.toNumber();
      if (ret >= pct && state[r.asset] !== 'above') {
        state[r.asset] = 'above';
        const sym = r.asset.split(':').slice(1).join(':');
        const name = r.asset.startsWith('GOLD:') ? 'Gold ' + sym.replace('GOLD_', '').replace('LIRA_', 'lira ').toLowerCase().replace('k', 'K') : sym;
        hits.push({ key: r.asset, openKey: r.asset.startsWith('GOLD:') ? 'GOLD:GLOBAL' : r.asset, name, price: r.price ? r.price.toNumber() : null, currency: r.currency,
          title: '+' + pct + '% profit · ' + name,
          body: 'Up ' + ret.toFixed(1) + '% (' + r.unrealizedJod.toFixed(3) + ' JOD gain). Value ' + r.valueJod.toFixed(3) + ' JOD. Decide your plan: take some profit, set a stop, or keep holding. Not financial advice.' });
      } else if (ret < pct - 5) state[r.asset] = 'below';
    }
    return hits;
  }

  root.MonzAlerts = { run, decide, profitHits, withLive, heldKeys, strategyFor, message, ALERT_KEY };
})(typeof window !== 'undefined' ? window : globalThis);
