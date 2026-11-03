/* Monz Trader UI. State lives in localStorage on the phone; nothing is sent anywhere except
 * requests to the market-data sources. All values shown come from those sources or from the
 * user's own transactions — prices are never invented or hardcoded. */
(function () {
  'use strict';
  const { Dec, FxService, CBJ_PEG, Ledger, iso, xirr } = window.Core;
  const S = window.Sources;
  const KEY = 'monz.v1';
  const MARKETS = { GOLD: 'Jordan gold', ASE: 'Amman SE', US: 'Stocks/ETFs', CRYPTO: 'Crypto' };
  const MARKET_CCY = { GOLD: 'JOD', ASE: 'JOD', US: 'USD', CRYPTO: 'USD' };
  const COLORS = { GOLD: '#d4a93c', ASE: '#3cc48a', US: '#5b8def', CRYPTO: '#b36bef' };
  // Coins always analysed in Signals, in addition to your watch list and holdings (CoinGecko ids)
  const CRYPTO_UNIVERSE = ['bitcoin', 'ethereum', 'solana', 'binancecoin', 'ripple', 'cardano', 'dogecoin', 'tron', 'chainlink', 'avalanche-2', 'toncoin', 'polkadot'];
  const OUNCE_G = 31.1034768;
  const GOLD_GLOBAL_KEY = 'GOLD:GLOBAL';
  const GOLD_SYMBOLS = ['GOLD_24K', 'GOLD_21K', 'GOLD_18K', 'GOLD_14K', 'GOLD_LIRA_RASHADI', 'GOLD_LIRA_ENGLISH'];
  const GOLD_LABEL = { GOLD_24K: '24K', GOLD_22K: '22K', GOLD_21K: '21K', GOLD_18K: '18K', GOLD_14K: '14K', GOLD_LIRA_RASHADI: 'Rashadi lira', GOLD_LIRA_ENGLISH: 'English lira' };

  // ------------------------------------------------------------------ state
  const blank = () => ({
    txs: [], settings: { finnhubKey: '', coingeckoKey: '', methods: { GOLD: 'AVERAGE', ASE: 'AVERAGE', US: 'FIFO', CRYPTO: 'FIFO' } },
    watch: { crypto: ['bitcoin', 'ethereum', 'solana'], us: ['HLAL', 'SPUS'] },
    quotes: {}, goldHistory: [], fx: [], errors: {}, lastRefresh: null, aseFile: null,
  });
  let st;
  try { st = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { st = blank(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { toast('Could not save: ' + e.message); } };

  // Quotes are stored as plain JSON; Dec values become strings.
  const plain = (q) => JSON.parse(JSON.stringify(q, (k, v) => (v instanceof Dec ? v.toString() : v)));

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const d = (x) => (x === null || x === undefined || x === '' ? null : Dec.tryOf(x));
  const fmt = (x, dp = 3) => { const v = d(x); return v === null ? '—' : v.toFixed(dp); };
  const jod = (x) => fmt(x, 3) + ' JOD';
  const signCls = (x) => { const v = d(x); return !v || v.isZero() ? '' : v.gt(0) ? 'up' : 'down'; };
  const signed = (x, dp = 2, suf = '') => { const v = d(x); return v === null ? '—' : (v.gt(0) ? '+' : '') + v.toFixed(dp) + suf; };
  const today = () => { const t = new Date(Date.now() + 3 * 3600000); return t.toISOString().slice(0, 10); };   // Amman date
  const ago = (ts) => {
    if (!ts) return 'time unknown';
    const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  };
  const localTime = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Amman', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const statusTag = (q) => {
    const c = S.checked(q);
    const label = { real_time: 'live', delayed: 'delayed', end_of_day: 'end of day', stale: 'stale' }[c.status] || c.status;
    return '<span class="tag ' + (c.status === 'stale' ? 'stale' : c.status === 'real_time' ? 'live' : '') + '">' + esc(label) + '</span>';
  };
  let toastTimer;
  function toast(msg) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500);
  }

  // ------------------------------------------------------------------ FX + ledger
  function fxService() {
    const fx = new FxService(); fx.add(CBJ_PEG);
    for (const r of st.fx) fx.add(r);
    return fx;
  }
  const assetKey = (market, symbol) => market + ':' + symbol;
  function buildLedger() {
    const methods = {};
    for (const t of st.txs) if (t.asset) methods[t.asset] = st.settings.methods[t.asset.split(':')[0]] || 'FIFO';
    const L = new Ledger(fxService(), methods);
    L.applyAll(st.txs);
    return L;
  }
  function priceFor(key) {
    const q = st.quotes[key];
    return q ? { price: q.price, currency: q.currency, quote: q } : null;
  }
  function portfolio() {
    try {
      const L = buildLedger();
      const prices = {};
      for (const k of Object.keys(L.positions)) { const p = priceFor(k); if (p) prices[k] = p; }
      const v = L.valuation(prices, today());
      return { L, v, error: null };
    } catch (e) { return { L: null, v: null, error: e.message }; }
  }

  // ------------------------------------------------------------------ refresh
  let busy = false, pendingRefresh = null;
  async function refresh(which = 'all') {
    if (busy) { pendingRefresh = which; return; } busy = true;
    const btn = $('#refreshBtn'); btn.innerHTML = '<span class="spin" style="display:inline-block">↻</span> Loading';
    const held = (m) => [...new Set(st.txs.filter((t) => t.asset && t.asset.startsWith(m + ':')).map((t) => t.asset.split(':').slice(1).join(':')))];
    const jobs = [];
    if (which === 'all' || which === 'gold') jobs.push(['gold', async () => {
      const { quotes } = await S.fetchGold(today());
      for (const q of quotes) st.quotes[assetKey('GOLD', q.symbol)] = plain(q);
      const g = quotes.find((q) => q.symbol === 'GOLD_21K') || quotes[0];
      const snapTs = g.marketTs || g.retrievedAt;
      if (!st.goldHistory.some((h) => h.ts === snapTs)) {
        st.goldHistory.push({ ts: snapTs, prices: Object.fromEntries(quotes.map((q) => [q.symbol, { bid: q.extra.bid && q.extra.bid.toString(), ask: q.extra.ask && q.extra.ask.toString() }])) });
        if (st.goldHistory.length > 3000) st.goldHistory = st.goldHistory.slice(-3000);
      }
    }]);
    if (which === 'all' || which === 'ase') jobs.push(['ase', async () => {
      const { quotes, parsed, file, market, marketError } = await S.fetchAse();
      for (const q of quotes) st.quotes[assetKey('ASE', q.symbol)] = plain(q);
      st.aseFile = file;
      st.aseHistory = {};
      for (const [sym, c] of Object.entries(parsed.companies)) st.aseHistory[sym] = c.series.slice(-260).map(([d, v]) => [d, v.toString()]);
      // Companies not in the yearly file (it covers ~160): use each company's own history page
      st.aseExtra = st.aseExtra || [];
      const needed = [...new Set(held('ASE').concat(st.aseExtra))].filter((sym) => !parsed.companies[sym]);
      const extraErrs = [];
      for (const sym of needed) {
        try { await loadCompany(sym); } catch (e) { extraErrs.push(e.message); }
      }
      if (extraErrs.length) st.errors.aseCompany = { msg: extraErrs.join('; '), at: new Date().toISOString() }; else delete st.errors.aseCompany;
      if (market) st.aseMarket = plain(market);
      if (marketError) st.errors.aseMarket = { msg: marketError, at: new Date().toISOString() }; else delete st.errors.aseMarket;
    }]);
    if (which === 'all' || which === 'crypto') jobs.push(['crypto', async () => {
      const ids = [...new Set(st.watch.crypto.concat(held('CRYPTO')))];
      if (!ids.length) return;
      for (const q of await S.fetchCrypto(ids, st.settings.coingeckoKey)) st.quotes[assetKey('CRYPTO', q.symbol)] = plain(q);
      // daily history for signals, at most once a day per coin
      st.cryptoHistory = st.cryptoHistory || {};
      const universe = [...new Set(ids.concat(CRYPTO_UNIVERSE))].slice(0, 16);
      const failed = [];
      for (const id of universe) {
        const h = st.cryptoHistory[id];
        if (h && h.fetched === today()) continue;
        try { st.cryptoHistory[id] = { fetched: today(), series: await S.fetchCryptoHistory(id, st.settings.coingeckoKey) }; }
        catch (e) { if (!h) failed.push(id); }
        await new Promise((r) => setTimeout(r, st.settings.coingeckoKey ? 300 : 2500));   // stay under CoinGecko's free rate limit
      }
      // Global gold: PAX Gold (PAXG) — each token is backed by one fine troy ounce of London gold, so it tracks spot gold.
      if (!st.goldGlobal || st.goldGlobal.fetched !== today()) {
        try { st.goldGlobal = { fetched: today(), series: await S.fetchCryptoHistory('pax-gold', st.settings.coingeckoKey) }; }
        catch (e) { if (!st.goldGlobal) failed.push('global gold'); }
      }
      if (failed.length) throw new Error('could not load history for ' + failed.join(', ') + ' (CoinGecko rate limit; it retries on the next refresh — a free CoinGecko key in Settings helps)');
    }]);
    if (which === 'all' || which === 'us') jobs.push(['us', async () => {
      const syms = [...new Set(st.watch.us.concat(held('US')))];
      if (!syms.length) return;
      if (!st.settings.finnhubKey) { if (held('US').length) throw new Error('Add a free Finnhub API key in Settings to price your stocks'); return; }
      const errs = [];
      for (const s of syms) {
        try { st.quotes[assetKey('US', s)] = plain(await S.fetchStock(s, st.settings.finnhubKey)); } catch (e) { errs.push(s + ': ' + e.message); }
      }
      if (errs.length) throw new Error(errs.join('; '));
    }]);
    if (which === 'all') jobs.push(['research', async () => {
      try { st.research = await S.fetchResearch(); }
      catch (e) { if (/HTTP 404/.test(e.message)) { st.research = null; return; } throw e; }   // no research published yet
    }]);
    jobs.push(['fx', async () => {
      const first = st.txs.reduce((m, t) => (t.on < m ? t.on : m), today());
      const from = new Date(Date.parse(first) - 10 * 86400000).toISOString().slice(0, 10);
      const have = st.fx.length ? st.fx.reduce((m, r) => (r.on < m ? r.on : m), '9999') : null;
      const start = have && have <= from ? st.fx.reduce((m, r) => (r.on > m ? r.on : m), '0000') : from;
      const rows = await S.fetchFxSeries(start, today());
      const seen = new Set(st.fx.map((r) => r.quote + r.on));
      for (const r of rows) if (!seen.has(r.quote + r.on)) st.fx.push(r);
    }]);
    await Promise.all(jobs.map(async ([name, fn]) => {
      try { await fn(); delete st.errors[name]; } catch (e) { st.errors[name] = { msg: e.message, at: new Date().toISOString() }; }
    }));
    st.lastRefresh = new Date().toISOString();
    signalsCache = null; try { recordSignals(computeSignals()); } catch (e) { st.errors.signals = { msg: e.message, at: st.lastRefresh }; }
    save(); busy = false; btn.textContent = '↻ Refresh';
    if (pendingRefresh) { const w = pendingRefresh; pendingRefresh = null; setTimeout(() => refresh(w), 0); }
    else if (which === 'all' && (!st.backtest || Date.now() - Date.parse(st.backtest.ranAt) > 30 * 86400000)) setTimeout(runStrategyTest, 500);
    if (route !== 'add' && route !== 'settings') render();
  }

  async function loadCompany(sym) {
    const r = await S.fetchCompanyHistory(sym, 4);
    st.quotes[assetKey('ASE', r.symbol)] = plain(r.quote);
    st.aseHistory = st.aseHistory || {};
    const merged = {};
    for (const [d, v] of st.aseHistory[r.symbol] || []) merged[d] = v;
    for (const row of r.rows) merged[row.on] = row.close.toString();
    st.aseHistory[r.symbol] = Object.keys(merged).sort().slice(-260).map((d) => [d, merged[d]]);
    return r;
  }

  function saveKeys(announce) {
    const f = $('#s_finnhub'), c = $('#s_cg');
    if (!f || !c) return;
    const fk = S.cleanKey(f.value), ck = S.cleanKey(c.value);
    const fixed = fk !== f.value.trim() && f.value.trim() !== '';
    const changed = fk !== st.settings.finnhubKey || ck !== st.settings.coingeckoKey;
    f.value = fk; c.value = ck;
    st.settings.finnhubKey = fk; st.settings.coingeckoKey = ck; save();
    if (announce || changed) toast(fixed ? 'Key cleaned up (it was pasted twice) and saved — loading prices…' : 'Keys saved — loading prices…');
    if (changed || announce) { delete st.errors.us; refresh(fk ? 'us' : 'crypto'); }
  }

  // ------------------------------------------------------------------ views
  const routes = {};
  let route = 'home', stack = [];
  function go(r, push = true) { if (push && r !== route) stack.push(route); route = r; render(); window.scrollTo(0, 0); }
  window.appBack = () => { if (stack.length) { route = stack.pop(); render(); return true; } return false; };

  function errorBlock(names) {
    return names.filter((n) => st.errors[n]).map((n) => '<div class="err"><b>' + esc(n.toUpperCase()) + ' source failed</b> (' + esc(ago(st.errors[n].at)) + '): ' + esc(st.errors[n].msg) +
      '<br><span class="muted">Showing the last valid prices, marked with their age.</span></div>').join('');
  }

  routes.home = () => {
    const { v, error } = portfolio();
    if (error) return '<div class="err">Portfolio error: ' + esc(error) + '</div>' + txListCard();
    const byMarket = {};
    for (const r of v.rows) if (r.valueJod) { const m = r.asset.split(':')[0]; byMarket[m] = (byMarket[m] || Dec.of(0)).add(r.valueJod); }
    const total = v.totalValueJod;
    const unrealPct = v.totalCostJodPriced.gt(0) ? v.unrealizedJod.div(v.totalCostJodPriced).mul(100) : null;
    let html = errorBlock(['gold', 'ase', 'crypto', 'us', 'fx']);
    if (st.txs.length && (!st.lastBackup || Date.now() - Date.parse(st.lastBackup) > 7 * 86400000))
      html += '<div class="note">Your transactions are stored only on this phone. <b>Settings → Share backup</b> keeps a copy safe (for example, send it to yourself on WhatsApp or email).</div>';
    if (!st.lastRefresh) html += '<div class="note">Tap <b>Refresh</b> to load prices from Roya, the Amman Stock Exchange, CoinGecko and the ECB.</div>';
    html += '<div class="card"><h2>Portfolio value</h2><div class="big">' + jod(total) + '</div>' +
      '<div class="sub">Priced holdings only · prices ' + esc(st.lastRefresh ? 'refreshed ' + ago(st.lastRefresh) : 'not loaded yet') + '</div>' +
      '<div class="grid2" style="margin-top:12px">' +
      '<div class="kv"><div class="k">Unrealized P/L</div><div class="v ' + signCls(v.unrealizedJod) + '">' + signed(v.unrealizedJod, 3) + ' <span class="sub">' + (unrealPct ? signed(unrealPct, 2, '%') : '') + '</span></div></div>' +
      '<div class="kv"><div class="k">Realized P/L</div><div class="v ' + signCls(v.realizedJod) + '">' + signed(v.realizedJod, 3) + '</div></div>' +
      '<div class="kv"><div class="k">Dividends & income</div><div class="v">' + fmt(v.incomeJod) + '</div></div>' +
      '<div class="kv"><div class="k">Fees (standalone)</div><div class="v">' + fmt(v.expensesJod) + '</div></div></div>';
    if (v.unpriced.length) html += '<div class="note" style="margin:12px 0 0">No current price for: ' + esc(v.unpriced.map(label).join(', ')) + '. These are excluded from the total, not valued at cost.</div>';
    html += '</div>';
    if (total.gt(0)) {
      html += '<div class="card"><h2>Allocation by market</h2><div class="bar">' +
        Object.entries(byMarket).map(([m, x]) => '<div style="width:' + x.div(total).mul(100).toFixed(2) + '%;background:' + COLORS[m] + '"></div>').join('') + '</div><div class="legend">' +
        Object.entries(byMarket).map(([m, x]) => '<span><i class="dot" style="background:' + COLORS[m] + '"></i>' + esc(MARKETS[m]) + ' ' + x.div(total).mul(100).toFixed(1) + '%</span>').join('') + '</div></div>';
    }
    html += '<div class="card"><h2>Holdings</h2>' + (v.rows.length ? v.rows.map(holdingRow).join('') : '<div class="empty">No holdings yet.<br><br><button class="btn gold" data-go="add">Add your first purchase</button></div>') + '</div>';
    return html;
  };
  function label(key) {
    const [m, ...rest] = key.split(':'); const s = rest.join(':');
    if (m === 'GOLD') return 'Gold ' + (GOLD_LABEL[s] || s);
    if (m === 'ASE') { const q = st.quotes[key]; return s + (q && q.extra && q.extra.name ? ' · ' + q.extra.name : ''); }
    return s;
  }
  function signalFor(assetKeyStr) {
    let list; try { list = computeSignals(); } catch (e) { return null; }
    const key = assetKeyStr.startsWith('GOLD:') ? GOLD_GLOBAL_KEY : assetKeyStr;
    return list.find((x) => x.key === key) || null;
  }
  /** Research entry for an asset if the published research is recent (≤ 4 days). */
  function researchFor(assetKeyStr) {
    const doc = st.research;
    if (!doc || !doc.assets) return null;
    const key = assetKeyStr.startsWith('GOLD:') ? GOLD_GLOBAL_KEY : assetKeyStr;
    const r = doc.assets.find((x) => x.key === key);
    if (!r) return null;
    const ageDays = (Date.now() - Date.parse(doc.generated_at)) / 86400000;
    return { ...r, generatedAt: doc.generated_at, ageDays, stale: ageDays > 4 };
  }
  function signalBadge(assetKeyStr) {
    const m = assetKeyStr.split(':')[0];
    const rr = researchFor(assetKeyStr);
    if (rr && rr.recommendation && !rr.stale)
      return '<span class="pill ' + pillCls(rr.recommendation.action) + '" data-research="' + esc(rr.key) + '" style="margin-top:4px;display:inline-block">' + esc(rr.recommendation.action) + ' ★</span>';
    const a = signalFor(assetKeyStr);
    if (a && !a.insufficient) return '<span class="pill ' + pillCls(a.action) + '" data-sig="' + esc(a.key) + '" style="margin-top:4px;display:inline-block">' + esc(a.action) + '</span>';
    const why = m === 'US' && !a ? 'waits for daily research' : a && a.insufficient ? 'not enough history' : 'refresh for signal';
    return '<span class="pill hold" style="margin-top:4px;display:inline-block;font-weight:500">' + esc(why) + '</span>';
  }
  function holdingRow(r) {
    const m = r.asset.split(':')[0], q = st.quotes[r.asset];
    const unit = m === 'GOLD' ? (r.asset.includes('LIRA') ? ' pcs' : ' g') : '';
    return '<div class="list-item"><div class="row"><i class="dot" style="background:' + COLORS[m] + '"></i><div class="grow"><b>' + esc(label(r.asset)) + '</b>' +
      '<div class="sub">' + esc(r.quantity.toString()) + unit + ' · avg ' + fmt(r.avgCost, m === 'CRYPTO' ? 4 : 3) + ' ' + esc(r.currency) + (q ? ' · ' + statusTag(q) : '') + '</div></div>' +
      '<div style="text-align:right"><div>' + (r.valueJod ? jod(r.valueJod) : '<span class="muted">no price</span>') + '</div>' +
      '<div class="sub ' + signCls(r.unrealizedJod) + '">' + (r.retJod ? signed(r.unrealizedJod, 3) + ' (' + signed(r.retJod, 2, '%') + ')' : '') + '</div>' +
      (r.currency !== 'JOD' && r.retNative ? '<div class="sub">in ' + esc(r.currency) + ': ' + signed(r.retNative, 2, '%') + '</div>' : '') + signalBadge(r.asset) + '</div></div></div>';
  }

  routes.gold = () => {
    let html = errorBlock(['gold']);
    const qs = GOLD_SYMBOLS.map((s) => st.quotes[assetKey('GOLD', s)]).filter(Boolean);
    html += '<div class="card"><h2>Jordan gold prices (JOD)</h2>';
    if (!qs.length) html += '<div class="empty">Tap Refresh to load today\'s prices.</div>';
    else {
      html += '<table><tr><th>Item</th><th class="n">Shop sells</th><th class="n">Shop buys</th></tr>' + qs.map((q) =>
        '<tr><td>' + esc(GOLD_LABEL[q.symbol] || q.symbol) + '<div class="sub">per ' + esc(q.extra.unit) + '</div></td>' +
        '<td class="n">' + fmt(q.extra.ask) + arrow(q.extra.askUp) + '</td><td class="n"><b>' + fmt(q.extra.bid) + '</b>' + arrow(q.extra.bidUp) + '</td></tr>').join('') +
        '<tr><td>22K</td><td class="n muted" colspan="2">Not published by the syndicate</td></tr></table>' +
        '<div class="sub" style="margin-top:8px">' + statusTag(qs[0]) + ' Bulletin ' + esc(localTime(qs[0].marketTs)) + ' · fetched ' + esc(ago(qs[0].retrievedAt)) +
        '<br>Source: Roya News / Jordanian Jewelers Syndicate. Your gold is valued at the <b>shop buys</b> price.</div>';
    }
    html += '</div>';
    const hist = st.goldHistory.filter((h) => h.prices.GOLD_21K && h.prices.GOLD_21K.bid);
    html += '<div class="card"><h2>21K history (shop buys)</h2>' + (hist.length > 1 ? lineChart(hist.map((h) => [h.ts, Number(h.prices.GOLD_21K.bid)])) +
      '<div class="sub">' + hist.length + ' bulletins collected on this phone since ' + esc(localTime(hist[0].ts)) + '</div>' :
      '<div class="sub">History builds up as you refresh. Each new bulletin is saved on this phone.</div>') + '</div>';
    html += '<button class="btn gold" data-go="add" data-market="GOLD" style="width:100%">Add gold purchase</button>';
    return html;
  };
  const arrow = (up) => (up === true ? ' <span class="up">▲</span>' : up === false ? ' <span class="down">▼</span>' : '');

  function lineChart(points, color = '#d4a93c') {
    const W = 340, H = 150, P = 6;
    const ys = points.map((p) => p[1]), xs = points.map((p) => Date.parse(p[0]));
    const minY = Math.min(...ys), maxY = Math.max(...ys), minX = Math.min(...xs), maxX = Math.max(...xs);
    const sx = (x) => P + ((x - minX) / (maxX - minX || 1)) * (W - 2 * P), sy = (y) => H - P - ((y - minY) / (maxY - minY || 1)) * (H - 2 * P);
    const path = points.map((p, i) => (i ? 'L' : 'M') + sx(xs[i]).toFixed(1) + ',' + sy(p[1]).toFixed(1)).join(' ');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="row sub"><span class="grow">low ' + minY.toFixed(minY > 100 ? 2 : 3) + '</span><span>high ' + maxY.toFixed(maxY > 100 ? 2 : 3) + '</span></div>';
  }

  let aseFilter = '', aseSymbol = null;
  routes.ase = () => {
    let html = errorBlock(['ase', 'aseMarket', 'aseCompany']);
    const mk = st.aseMarket;
    if (mk) {
      html += '<div class="card"><h2>ASE General Index · ' + esc(mk.date) + '</h2><div class="row"><div class="big grow">' + fmt(mk.asegi, 2) + '</div>' +
        '<div class="' + signCls(mk.changePct) + '" style="font-weight:600">' + signed(mk.changePct, 2, '%') + '</div></div>' +
        (mk.asegiHistory && mk.asegiHistory.length > 2 ? lineChart(mk.asegiHistory, '#3cc48a') : '') +
        '<div class="grid2" style="margin-top:10px"><div class="kv"><div class="k">Value traded</div><div class="v">' + fmt(mk.valueTraded, 0) + ' JOD</div></div>' +
        '<div class="kv"><div class="k">Transactions</div><div class="v">' + fmt(mk.trades, 0) + '</div></div>' +
        '<div class="kv"><div class="k">Market cap</div><div class="v">' + (d(mk.marketCap) ? d(mk.marketCap).div(1000000000).toFixed(2) + ' bn JOD' : '—') + '</div></div>' +
        '<div class="kv"><div class="k">ASE20 · P/E</div><div class="v">' + fmt(mk.ase20, 2) + ' · ' + fmt(mk.pe, 1) + '</div></div></div>' +
        '<div class="sub" style="margin-top:8px">Source: Amman Stock Exchange daily trading data (end of day)</div></div>';
    }
    const all = Object.keys(st.quotes).filter((k) => k.startsWith('ASE:')).map((k) => st.quotes[k]).filter((q) => q.extra && q.extra.fileDate);
    html += '<input id="aseSearch" placeholder="Search symbol or company" value="' + esc(aseFilter) + '">';
    if (!all.length) return html + '<div class="card empty" style="margin-top:12px">Tap Refresh to load the latest ASE closing prices.</div>';
    const f = aseFilter.trim().toUpperCase();
    const rows = all.filter((q) => !f || q.symbol.includes(f) || (q.extra.name || '').toUpperCase().includes(f));
    const exact = all.some((q) => q.symbol === f);
    if (f && !exact && /^[A-Z0-9]{2,8}$/.test(f)) {
      html += '<div class="card" style="margin-top:12px"><div class="sub">The yearly price file covers ' + all.filter((q) => !q.extra.fromCompanyPage).length + ' companies. If ' + esc(f) + ' is listed on the ASE, its own page on exchange.jo has its prices.</div>' +
        '<button class="btn" style="margin-top:10px;width:100%" data-aselookup="' + esc(f) + '">Look up ' + esc(f) + ' on exchange.jo</button><div id="lookupMsg"></div></div>';
    }
    html += '<div class="card" style="margin-top:12px"><h2>Closing prices · ' + esc(all[0].extra.fileDate) + ' · ' + all.length + ' companies</h2><table><tr><th>Symbol</th><th class="n">Close</th><th class="n">Chg %</th></tr>' +
      rows.map((q) => '<tr data-asestock="' + esc(q.symbol) + '"><td><b>' + esc(q.symbol) + '</b><div class="sub">' + esc(q.extra.name || '') +
        (q.extra.notTradedSinceFileDate ? ' · <span class="warn">last close ' + esc(q.extra.tradingDate) + '</span>' : '') + '</div></td>' +
        '<td class="n">' + fmt(q.price) + '</td><td class="n ' + signCls(q.extra.changePct) + '">' + signed(q.extra.changePct, 2) + '</td></tr>').join('') +
      '</table><div class="sub" style="margin-top:8px">Source: Amman Stock Exchange closing prices file (end of day, not live). Tap a company for its chart.</div></div>';
    return html;
  };

  routes.aseStock = () => {
    const q = st.quotes[assetKey('ASE', aseSymbol)];
    if (!q) return '<div class="empty">Not found.</div>';
    const hist = (st.aseHistory && st.aseHistory[aseSymbol]) || [];
    const first = hist.length ? Number(hist[0][1]) : null, lastV = Number(q.price);
    const ytd = first ? ((lastV / first - 1) * 100) : null;
    return '<div class="card"><h2>' + esc(q.symbol) + ' · ' + esc(q.extra.name || '') + '</h2><div class="row"><div class="big grow">' + fmt(q.price) + ' <span class="sub">JOD</span></div>' +
      '<div class="' + signCls(q.extra.changePct) + '" style="font-weight:600">' + signed(q.extra.changePct, 2, '%') + '</div></div>' +
      (q.extra.fromCompanyPage ? '<div class="sub">High ' + fmt(q.extra.high) + ' · Low ' + fmt(q.extra.low) + ' · ' + fmt(q.extra.volume, 0) + ' shares · ' + fmt(q.extra.trades, 0) + ' trades · ' + fmt(q.extra.value, 0) + ' JOD</div>' : '') +
      '<div class="sub">Close on ' + esc(q.extra.tradingDate) + (q.extra.prevDate ? ' · previous ' + fmt(q.extra.prevClose) + ' on ' + esc(q.extra.prevDate) : '') + '</div>' +
      (hist.length > 2 ? lineChart(hist.map(([dd, v]) => [dd, Number(v)]), '#3cc48a') + '<div class="sub">' + hist.length + ' trading days since ' + esc(hist[0][0]) + (ytd !== null ? ' · change ' + (ytd >= 0 ? '+' : '') + ytd.toFixed(2) + '%' : '') + '</div>' : '') +
      (q.extra.notTradedSinceFileDate ? '<div class="note" style="margin-top:10px">No closing price since ' + esc(q.extra.tradingDate) + '. This stock trades rarely; the price may not reflect what you could sell for.</div>' : '') +
      '</div><button class="btn gold" data-addase="' + esc(q.symbol) + '" style="width:100%">Record a purchase</button>';
  };

  routes.markets = () => {
    let html = errorBlock(['crypto', 'us']);
    const cq = st.watch.crypto.map((id) => st.quotes[assetKey('CRYPTO', id)]).filter(Boolean);
    const fx = fxService();
    const toJod = (q) => { try { return fx.convert(q.price, q.currency, 'JOD', today()); } catch (e) { return null; } };
    html += '<div class="card"><h2>Crypto</h2>' + (cq.length ? '<table><tr><th>Coin</th><th class="n">USD</th><th class="n">JOD</th><th class="n">24h</th></tr>' + cq.map((q) =>
      '<tr><td><b>' + esc(q.symbol) + '</b></td><td class="n">' + fmt(q.price, 2) + '</td><td class="n">' + fmt(toJod(q), 2) + '</td><td class="n ' + signCls(q.extra.change24h) + '">' + signed(q.extra.change24h, 2, '%') + '</td></tr>').join('') +
      '</table><div class="sub" style="margin-top:8px">' + statusTag(cq[0]) + ' Source: CoinGecko · ' + esc(ago(cq[0].marketTs || cq[0].retrievedAt)) + '</div>' : '<div class="empty">Tap Refresh to load prices.</div>') +
      '<label>Coins to watch (CoinGecko ids, comma separated)</label><input id="watchCrypto" value="' + esc(st.watch.crypto.join(', ')) + '"></div>';
    const uq = st.watch.us.map((s) => st.quotes[assetKey('US', s)]).filter(Boolean);
    html += '<div class="card"><h2>Stocks & ETFs</h2>' + (uq.length ? '<table><tr><th>Symbol</th><th class="n">USD</th><th class="n">JOD</th><th class="n">Day</th></tr>' + uq.map((q) =>
      '<tr><td><b>' + esc(q.symbol) + '</b></td><td class="n">' + fmt(q.price, 2) + '</td><td class="n">' + fmt(toJod(q), 2) + '</td><td class="n ' + signCls(q.extra.changePct) + '">' + signed(q.extra.changePct, 2, '%') + '</td></tr>').join('') +
      '</table><div class="sub" style="margin-top:8px">' + statusTag(uq[0]) + ' Source: Finnhub</div>' : '<div class="empty">' + (st.settings.finnhubKey ? 'Tap Refresh to load prices.' : 'Add a free Finnhub API key in Settings to load stock prices.') + '</div>') +
      '<label>Symbols to watch (comma separated)</label><input id="watchUs" value="' + esc(st.watch.us.join(', ')) + '"></div>';
    return html;
  };

  function txListCard() {
    const txs = st.txs.map((t, i) => [t, i]).sort((a, b) => (a[0].on < b[0].on ? 1 : -1));
    return '<div class="card"><div class="row"><h2 class="grow" style="margin:0">Transactions</h2><button class="btn gold small" data-go="add">+ Add</button></div>' +
      (txs.length ? txs.map(([t, i]) => '<div class="list-item"><div class="row"><div class="grow"><b>' + esc(t.type) + '</b> ' + esc(t.asset ? label(t.asset) : '') +
        '<div class="sub">' + esc(t.on) + ' · ' + esc(t.account || 'default') + (t.toAccount ? ' → ' + esc(t.toAccount) : '') + ' · ' + txSummary(t) + '</div></div>' +
        '<button class="btn danger small" data-del="' + i + '">Delete</button></div></div>').join('') : '<div class="empty">No transactions yet.</div>') + '</div>';
  }
  function txSummary(t) {
    if (['BUY', 'SELL', 'TRANSFER'].includes(t.type)) return esc(t.quantity) + (t.type !== 'TRANSFER' ? ' @ ' + esc(t.price) : '') + ' ' + esc(t.currency) + (Number(t.fees) ? ' + fees ' + esc(t.fees) : '');
    if (t.type === 'SPLIT') return 'ratio ' + esc(t.ratio);
    return esc(t.amount) + ' ' + esc(t.currency);
  }
  routes.portfolio = () => {
    const { L, v, error } = portfolio();
    let html = error ? '<div class="err">' + esc(error) + '</div>' : '';
    if (L && L.realized.length) {
      html += '<div class="card"><h2>Realized sales</h2>' + L.realized.slice().reverse().map((e) => '<div class="list-item"><div class="row"><div class="grow"><b>' + esc(label(e.asset)) + '</b><div class="sub">' + esc(e.on) + ' · ' + esc(e.quantity.toString()) + ' units · held ' + e.holdingDays + ' days</div></div>' +
        '<div class="' + signCls(e.gainJod) + '">' + signed(e.gainJod, 3) + ' JOD</div></div></div>').join('') + '</div>';
    }
    if (L && L.cashFlowsJod.length && v) {
      try {
        const r = xirr(L.cashFlowsJod.concat([[today(), v.totalValueJod]]));
        html += '<div class="card"><h2>Money-weighted return (XIRR)</h2><div class="big ' + (r >= 0 ? 'up' : 'down') + '">' + (r * 100).toFixed(2) + '%</div><div class="sub">Annualised, in JOD, from your deposits/withdrawals and today\'s priced value.</div></div>';
      } catch (e) { /* needs both deposits and a positive value */ }
    }
    return html + txListCard();
  };

  let draft = null;
  routes.add = () => {
    draft = draft || { type: 'BUY', market: 'GOLD', symbol: 'GOLD_21K', on: today(), account: 'default', quantity: '', price: '', fees: '0', amount: '', currency: 'JOD', toAccount: '', ratio: '' };
    const t = draft, needsAsset = !['DEPOSIT', 'WITHDRAWAL', 'FEE'].includes(t.type);
    const opt = (v, cur, lbl) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(lbl || v) + '</option>';
    let symbolInput;
    if (t.market === 'GOLD') symbolInput = '<select id="f_symbol">' + Object.keys(GOLD_LABEL).map((s) => opt(s, t.symbol, 'Gold ' + GOLD_LABEL[s])).join('') + '</select>';
    else symbolInput = '<input id="f_symbol" value="' + esc(t.symbol) + '" placeholder="' + (t.market === 'CRYPTO' ? 'CoinGecko id, e.g. bitcoin' : t.market === 'ASE' ? 'ASE symbol, e.g. ARBK' : 'e.g. HLAL') + '" autocapitalize="' + (t.market === 'CRYPTO' ? 'none' : 'characters') + '">';
    const qtyLabel = t.market === 'GOLD' ? (t.symbol.includes('LIRA') ? 'Pieces' : 'Weight (grams)') : 'Quantity';
    const priceLabel = t.market === 'GOLD' ? (t.symbol.includes('LIRA') ? 'Price per piece' : 'Price per gram') : 'Price per unit';
    let html = '<div class="card"><h2>New transaction</h2>' +
      '<label>Type</label><select id="f_type">' + ['BUY', 'SELL', 'TRANSFER', 'DIVIDEND', 'INTEREST', 'DISTRIBUTION', 'SPLIT', 'DEPOSIT', 'WITHDRAWAL', 'FEE'].map((x) => opt(x, t.type)).join('') + '</select>';
    if (needsAsset) html += '<label>Market</label><select id="f_market">' + Object.keys(MARKETS).map((m) => opt(m, t.market, MARKETS[m])).join('') + '</select><label>Asset</label>' + symbolInput;
    html += '<label>Date</label><input id="f_on" type="date" value="' + esc(t.on) + '">' +
      '<label>Account / wallet / place</label><input id="f_account" value="' + esc(t.account) + '" placeholder="e.g. Binance, home safe, broker">';
    if (t.type === 'TRANSFER') html += '<label>To account</label><input id="f_toAccount" value="' + esc(t.toAccount) + '">';
    if (['BUY', 'SELL', 'TRANSFER'].includes(t.type)) html += '<label>' + esc(qtyLabel) + '</label><input id="f_quantity" inputmode="decimal" value="' + esc(t.quantity) + '">';
    if (['BUY', 'SELL'].includes(t.type)) html += '<label>' + esc(priceLabel) + '</label><input id="f_price" inputmode="decimal" value="' + esc(t.price) + '">';
    if (['BUY', 'SELL', 'TRANSFER'].includes(t.type)) html += '<label>' + (t.market === 'GOLD' ? 'Fees incl. workmanship (total)' : 'Fees (total)') + '</label><input id="f_fees" inputmode="decimal" value="' + esc(t.fees) + '">';
    if (['DIVIDEND', 'INTEREST', 'DISTRIBUTION', 'DEPOSIT', 'WITHDRAWAL', 'FEE'].includes(t.type)) html += '<label>Amount</label><input id="f_amount" inputmode="decimal" value="' + esc(t.amount) + '">';
    if (t.type === 'SPLIT') html += '<label>New shares per old share (2 for a 2:1 split, 0.1 for 1:10 reverse)</label><input id="f_ratio" inputmode="decimal" value="' + esc(t.ratio) + '">';
    if (t.type !== 'SPLIT') html += '<label>Currency</label><select id="f_currency">' + ['JOD', 'USD', 'EUR', 'GBP'].map((c) => opt(c, t.currency)).join('') + '</select>';
    html += '<div class="sub" id="totalLine" style="margin-top:10px">' + totalLine(t) + '</div>';
    html += '<div id="formErr"></div><div class="row" style="margin-top:14px"><button class="btn ghost grow" data-cancel>Cancel</button><button class="btn gold grow" data-savetx>Save</button></div></div>';
    if (t.market === 'GOLD' && needsAsset) html += '<div class="note">Gold is valued at the price shops pay when buying from you. Workmanship fees are part of your cost but are usually not paid back when you sell, so new jewellery starts with a loss.</div>';
    return html;
  };
  function totalLine(t) {
    if (!['BUY', 'SELL'].includes(t.type) || !Dec.tryOf(t.quantity) || !Dec.tryOf(t.price)) return '';
    const fees = Dec.tryOf(t.fees) || Dec.of(0), gross = Dec.of(t.quantity).mul(t.price);
    return t.type === 'BUY' ? 'Total acquisition cost: <b>' + gross.add(fees).toFixed(3) + ' ' + esc(t.currency) + '</b>'
      : 'Net proceeds: <b>' + gross.sub(fees).toFixed(3) + ' ' + esc(t.currency) + '</b>';
  }
  function readDraft() {
    for (const f of ['type', 'market', 'symbol', 'on', 'account', 'toAccount', 'quantity', 'price', 'fees', 'amount', 'ratio', 'currency']) {
      const el = $('#f_' + f); if (el) draft[f] = el.value.trim();
    }
  }
  function saveDraft() {
    readDraft();
    const t = draft, errEl = $('#formErr');
    const needsAsset = !['DEPOSIT', 'WITHDRAWAL', 'FEE'].includes(t.type);
    let sym = t.symbol; if (t.market !== 'CRYPTO') sym = sym.toUpperCase(); else sym = sym.toLowerCase();
    const tx = { type: t.type, on: t.on, account: t.account || 'default', currency: t.type === 'SPLIT' ? MARKET_CCY[t.market] : t.currency, id: 't' + Date.now() };
    if (needsAsset) { if (!sym) return (errEl.innerHTML = '<div class="err">Enter the asset symbol.</div>'); tx.asset = assetKey(t.market, sym); }
    const num = (k, req) => { const v = Dec.tryOf(t[k]); if (req && (!v || !v.gt(0))) throw new Error('Enter a valid ' + k); return v ? v.toString() : '0'; };
    try {
      if (['BUY', 'SELL', 'TRANSFER'].includes(t.type)) { tx.quantity = num('quantity', true); tx.fees = num('fees', false); }
      if (['BUY', 'SELL'].includes(t.type)) tx.price = num('price', true);
      if (t.type === 'TRANSFER') { if (!t.toAccount) throw new Error('Enter the destination account'); tx.toAccount = t.toAccount; }
      if (['DIVIDEND', 'INTEREST', 'DISTRIBUTION', 'DEPOSIT', 'WITHDRAWAL', 'FEE'].includes(t.type)) tx.amount = num('amount', true);
      if (t.type === 'SPLIT') tx.ratio = num('ratio', true);
      if (tx.asset) {   // asset currency must stay consistent
        const prev = st.txs.find((x) => x.asset === tx.asset && x.type !== 'SPLIT' && !['DIVIDEND', 'INTEREST', 'DISTRIBUTION'].includes(x.type));
        if (prev && t.type !== 'SPLIT' && !['DIVIDEND', 'INTEREST', 'DISTRIBUTION'].includes(t.type) && prev.currency !== tx.currency) throw new Error(label(tx.asset) + ' was recorded in ' + prev.currency + '; use the same currency');
        if (t.type === 'SPLIT' && prev) tx.currency = prev.currency;
      }
      buildLedgerWith(st.txs.concat([tx]));   // validate before saving (e.g. selling more than held)
    } catch (e) { errEl.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    st.txs.push(tx); save(); draft = null; signalsCache = null; toast('Saved'); stack = []; go('portfolio', false);
    if (tx.asset && tx.asset.startsWith('ASE:') && !st.quotes[tx.asset]) {
      const sym = tx.asset.slice(4);
      loadCompany(sym).then(() => { st.aseExtra = [...new Set((st.aseExtra || []).concat([sym]))]; save(); signalsCache = null; render(); }).catch((err) => toast(err.message));
    } else if (tx.asset && !st.quotes[tx.asset]) refresh(tx.asset.split(':')[0] === 'GOLD' ? 'gold' : tx.asset.split(':')[0] === 'ASE' ? 'ase' : tx.asset.split(':')[0] === 'CRYPTO' ? 'crypto' : 'us');
  }
  function buildLedgerWith(txs) {
    const saved = st.txs; st.txs = txs;
    try { buildLedger(); } finally { st.txs = saved; }
  }

  // ------------------------------------------------------------------ signals
  let signalsCache = null, sigFilter = 'all', sigKey = null;
  /** Every price history the app has, as [{key, name, market, currency, series, staleDays}]. */
  function allSeries() {
    const out = [];
    const fileDays = new Set();
    for (const h of Object.values(st.aseHistory || {})) for (const [d] of h) fileDays.add(d);
    const allDays = [...fileDays].sort();
    for (const [sym, h] of Object.entries(st.aseHistory || {})) {
      const key = assetKey('ASE', sym), q = st.quotes[key];
      const lastDay = h.length ? h[h.length - 1][0] : null;
      out.push({ key, name: sym + (q && q.extra && q.extra.name ? ' · ' + q.extra.name : ''), market: 'ASE', currency: 'JOD',
        series: h.map(([d, v]) => [d, Number(v)]), staleDays: lastDay ? allDays.filter((d) => d > lastDay).length : 0 });
    }
    for (const [id, h] of Object.entries(st.cryptoHistory || {})) out.push({ key: assetKey('CRYPTO', id), name: id, market: 'CRYPTO', currency: 'USD', series: h.series });
    const gs = (st.goldGlobal && st.goldGlobal.series) || [];
    out.push({ key: GOLD_GLOBAL_KEY, name: 'Gold (global price, per gram 24K)', market: 'GOLD', currency: 'JOD', series: gs.map(([dd, v]) => [dd, (v * 0.709) / OUNCE_G]) });
    // US stocks/ETFs: histories published by the scheduled research run
    for (const r of (st.research && st.research.assets) || []) {
      if (r.market === 'US' && Array.isArray(r.series) && r.series.length) out.push({ key: r.key, name: r.key.slice(3) + ' · ' + r.name, market: 'US', currency: r.currency || 'USD', series: r.series });
    }
    return out;
  }
  const STRAT_LABEL = { trend: 'Trend', balanced: 'Balanced', dip: 'Dip-buying' };
  /** Strategy in use for a market: the user's choice, or the strategy test's pick when set to Auto. */
  function strategyFor(market) {
    const choice = (st.settings.strategy || {})[market] || 'auto';
    if (choice !== 'auto') return { strategy: choice, how: 'chosen in Settings' };
    const bt = st.backtest && st.backtest.markets && st.backtest.markets[market];
    if (bt) return { strategy: bt.chosen, how: 'picked by the strategy test (' + localTime(st.backtest.ranAt) + ')' };
    return { strategy: 'trend', how: 'default until the strategy test has run' };
  }
  function computeSignals() {
    if (signalsCache) return signalsCache;
    const G = window.Signals, out = [];
    let alloc = {};
    try { const { v } = portfolio(); if (v) for (const r of v.rows) if (r.allocation) alloc[r.asset] = r.allocation.toNumber(); } catch (e) { alloc = {}; }
    let goldWeight = 0; for (const [k, w] of Object.entries(alloc)) if (k.startsWith('GOLD:')) goldWeight += w;
    for (const a of allSeries()) {
      const sf = strategyFor(a.market);
      const res = G.analyze({ ...a, strategy: sf.strategy, portfolioWeightPct: a.key === GOLD_GLOBAL_KEY ? goldWeight : alloc[a.key] || 0 });
      res.strategyHow = sf.how;
      out.push(res);
    }
    signalsCache = out;
    return out;
  }

  // ------------------------------------------------------------------ strategy test (backtest)
  let btRunning = false, btProgress = '';
  async function runStrategyTest() {
    if (btRunning) return;
    btRunning = true; btProgress = 'Preparing…'; if (route === 'strategy') render();
    try {
      const held = new Set(st.txs.filter((t) => t.asset).map((t) => t.asset));
      let list = allSeries().filter((a) => a.series.length >= 90);
      // Amman SE: the 80 most actively priced companies plus anything you hold (keeps the test quick on a phone)
      const ase = list.filter((a) => a.market === 'ASE').map((a) => {
        const s = a.series.slice(-60); let flat = 0; for (let i = 1; i < s.length; i++) if (s[i][1] === s[i - 1][1]) flat++;
        return { a, flat };
      }).sort((x, y) => x.flat - y.flat);
      const aseKeep = new Set(ase.slice(0, 80).map((x) => x.a.key));
      list = list.filter((a) => a.market !== 'ASE' || aseKeep.has(a.key) || held.has(a.key));
      if (!list.length) throw new Error('Not enough price history yet. Tap Refresh first.');
      const res = await window.Backtest.runAll(list, (d, n) => { btProgress = 'Testing ' + d + ' of ' + n + ' assets…'; const el = $('#btProgress'); if (el) el.textContent = btProgress; });
      st.backtest = res; save(); signalsCache = null; delete st.errors.strategy;
    } catch (e) { st.errors.strategy = { msg: e.message, at: new Date().toISOString() }; save(); }
    btRunning = false; btProgress = '';
    if (route === 'strategy' || route === 'signals' || route === 'home') render();
  }
  const pct = (x, dp = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(dp) + '%');
  routes.strategy = () => {
    let html = errorBlock(['strategy']);
    html += '<div class="card"><h2>Strategy test</h2><div class="sub">Each strategy is replayed day by day on real prices: it only sees prices up to that day, trades at the next close, and pays trading costs. ' +
      'The strategy is chosen on the first 60% of the period, then judged on the last 40%, which it has not seen. Past results do not guarantee future profit.</div>' +
      '<button class="btn gold" style="margin-top:12px;width:100%" data-runbt ' + (btRunning ? 'disabled' : '') + '>' + (btRunning ? 'Running…' : st.backtest ? 'Run the test again' : 'Run the strategy test') + '</button>' +
      '<div class="sub" id="btProgress" style="margin-top:8px">' + esc(btProgress || (st.backtest ? 'Last run ' + localTime(st.backtest.ranAt) + '. It reruns automatically every 30 days.' : 'Takes about 10–30 seconds.')) + '</div></div>';
    const bt = st.backtest;
    if (!bt) return html;
    for (const m of ['ASE', 'GOLD', 'US', 'CRYPTO']) {
      const r = bt.markets[m];
      if (!r) continue;
      const rows = window.Backtest.STRATS.map((k) => r.by[k]);
      const best = r.chosen, sf = strategyFor(m);
      html += '<div class="card"><h2>' + esc(MARKETS[m]) + ' · ' + r.assets + ' asset' + (r.assets > 1 ? 's' : '') + '</h2>' +
        (r.period ? '<div class="sub">' + esc(r.period.from) + ' → ' + esc(r.period.to) + ' · test period from ' + esc(r.period.split) + '</div>' : '') +
        '<table style="margin-top:8px"><tr><th>Method</th><th class="n">Learn</th><th class="n">Test</th><th class="n">Worst drop</th><th class="n">Trades</th></tr>' +
        rows.map((x) => '<tr><td>' + (x.strategy === best ? '<b>' + esc(x.label) + ' ✓</b>' : esc(x.label)) + '</td><td class="n">' + pct(x.train) + '</td><td class="n ' + signCls(x.test) + '">' + pct(x.test) + '</td><td class="n">' + pct(x.maxDrawdown, 0) + '</td><td class="n">' + x.trades + '</td></tr>').join('') +
        '<tr><td class="muted">Buy & hold</td><td class="n muted">' + pct(r.buyHold.train) + '</td><td class="n muted">' + pct(r.buyHold.test) + '</td><td></td><td></td></tr></table>' +
        '<div class="sub" style="margin-top:8px">Average return per asset. Costs: ' + esc(r.costNote) + '. ✓ = best on the learning period.</div>' +
        '<div class="' + (r.beatsBuyHoldOnTest ? 'note' : 'err') + '" style="margin-top:10px">' + (Math.abs((r.chosenTest || 0) - (r.buyHold.test || 0)) < 0.002
          ? '<b>' + esc(STRAT_LABEL[best]) + '</b> roughly matched simply holding on the unseen test period (' + pct(r.chosenTest) + ' vs ' + pct(r.buyHold.test) + '): the signals added little here.'
          : r.beatsBuyHoldOnTest
          ? '<b>' + esc(STRAT_LABEL[best]) + '</b> beat simply holding on the unseen test period (' + pct(r.chosenTest) + ' vs ' + pct(r.buyHold.test) + ').'
          : '<b>Buying and holding did better</b> than ' + esc(STRAT_LABEL[best]) + ' on the unseen test period (' + pct(r.buyHold.test) + ' vs ' + pct(r.chosenTest) + '). For this market, signals may cost you more in fees and missed gains than they save.') + '</div>' +
        '<div class="sub" style="margin-top:6px">Signals now use: <b>' + esc(STRAT_LABEL[sf.strategy]) + '</b> (' + esc(sf.how) + ').</div></div>';
    }
    if (!bt.markets.US) html += '<div class="sub" style="margin:0 4px 12px">US stocks are tested once the daily research has published their price history.</div>';
    return html;
  }
  function recordSignals(list) {
    st.sigHistory = st.sigHistory || [];
    const lastFor = {};
    for (const h of st.sigHistory) lastFor[h.key] = h;
    for (const a of list) {
      if (a.insufficient) continue;
      const prev = lastFor[a.key];
      if (prev && prev.asOf === a.asOf) continue;          // one record per trading day
      st.sigHistory.push({ key: a.key, action: a.action, score: a.score, price: a.price, asOf: a.asOf, at: new Date().toISOString() });
    }
    if (st.sigHistory.length > 5000) st.sigHistory = st.sigHistory.slice(-5000);
  }
  const pillCls = (act) => (/BUY|ACCUM/.test(act) ? 'buy' : /SELL|REDUCE/.test(act) ? 'sell' : 'hold');
  const pdp = (x) => (Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 10 ? 2 : 3);
  const num = (x, dpx) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(dpx === undefined ? pdp(x) : dpx));

  routes.signals = () => {
    const all = computeSignals();
    const stratCard = '<div class="card" data-go="strategy"><div class="row"><div class="grow"><b>Strategy test</b><div class="sub">' +
      ['ASE', 'GOLD', 'US', 'CRYPTO'].filter((m) => st.backtest && st.backtest.markets[m]).map((m) => esc(MARKETS[m]) + ': ' + esc(STRAT_LABEL[strategyFor(m).strategy])).join(' · ') +
      (st.backtest ? '' : (btRunning ? 'Running…' : 'Find which method would have made the most money')) + '</div></div><span class="sub">›</span></div></div>';
    const ok = all.filter((a) => !a.insufficient);
    const heldKeys = new Set(st.txs.filter((t) => t.asset).map((t) => t.asset));
    const filters = [['all', 'All'], ['held', 'My holdings'], ['ASE', 'Amman SE'], ['CRYPTO', 'Crypto'], ['GOLD', 'Gold']];
    if ([...heldKeys].some((k) => k.startsWith('GOLD:'))) heldKeys.add(GOLD_GLOBAL_KEY);
    let list = ok.filter((a) => sigFilter === 'all' || (sigFilter === 'held' ? heldKeys.has(a.key) : a.market === sigFilter));
    list.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
    let html = errorBlock(['signals']);
    html += '<div class="note">Rules-based signals from price history only (trend, momentum, RSI, volatility, liquidity). Company financials and news are not included. This is a screening tool, not financial advice — check before you trade.</div>';
    const rs = st.research && st.research.assets ? st.research.assets.filter((x) => x.recommendation) : [];
    if (rs.length && (sigFilter === 'all' || sigFilter === 'held')) {
      const age = (Date.now() - Date.parse(st.research.generated_at)) / 86400000;
      html += '<div class="card"><h2>Researched recommendations · ' + esc(localTime(st.research.generated_at)) + (age > 4 ? ' · <span class="warn">old</span>' : '') + '</h2>' +
        rs.filter((x) => sigFilter === 'all' || x.held).map((x) => '<div class="list-item" data-research="' + esc(x.key) + '"><div class="row"><div class="grow"><b>' + esc(x.name) + '</b><div class="sub">' +
          (x.held ? '<span class="up">held</span> · ' : '') + (x.price ? num(x.price.value) + ' ' + esc(x.currency) + ' · ' : '') + (x.news ? x.news.length : 0) + ' news · ' + (x.fundamentals ? x.fundamentals.length : 0) + ' facts</div></div>' +
          '<span class="pill ' + pillCls(x.recommendation.action) + '">' + esc(x.recommendation.action) + ' ★</span></div></div>').join('') +
        '<div class="sub" style="margin-top:6px">★ = from the scheduled research run (price model + cited news and fundamentals).</div></div>';
    }
    html += stratCard;
    html += '<div class="seg">' + filters.map(([k, l]) => '<button data-sigf="' + k + '" class="' + (sigFilter === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
    if (!ok.length) html += '<div class="card empty">No signals yet. Tap Refresh to load price history.</div>';
    else {
      const counts = {}; for (const a of ok) counts[pillCls(a.action)] = (counts[pillCls(a.action)] || 0) + 1;
      html += '<div class="card"><h2>' + list.length + ' signals · sorted by score</h2>' + (list.length ? list.map((a) =>
        '<div class="list-item" data-sig="' + esc(a.key) + '"><div class="row"><div class="grow"><b>' + esc(a.name) + '</b>' +
        '<div class="sub">' + esc(MARKETS[a.market]) + ' · ' + num(a.price) + ' ' + esc(a.currency) + ' · ' + esc(a.asOf) + (heldKeys.has(a.key) ? ' · <span class="up">held</span>' : '') + '</div></div>' +
        '<div style="text-align:right"><span class="pill ' + pillCls(a.action) + '">' + esc(a.action) + '</span><div class="sub">score ' + a.score + ' · conf. ' + a.confidence + '%</div></div></div></div>').join('')
        : '<div class="empty">Nothing in this group.</div>') + '</div>';
    }
    const waiting = all.filter((a) => a.insufficient && (sigFilter === 'all' || a.market === sigFilter));
    if (waiting.length) html += '<div class="card"><h2>Not enough history yet</h2>' + waiting.slice(0, 20).map((a) => '<div class="list-item"><b>' + esc(a.name || a.key) + '</b><div class="sub">' + esc(a.insufficient) + (a.market === 'GOLD' ? ' Tap Refresh to load a year of global gold prices.' : '') + '</div></div>').join('') + '</div>';
    if (!ok.some((a) => a.market === 'US') && (sigFilter === 'all' || sigFilter === 'held')) html += '<div class="sub" style="margin:0 4px 12px">US stocks get signals from the price history published by the daily research run (tap Refresh after it runs).</div>';
    html += trackRecordCard();
    return html;
  };

  function trackRecordCard() {
    const hist = st.sigHistory || [];
    if (!hist.length) return '';
    const now = {}; for (const [k, q] of Object.entries(st.quotes)) now[k] = Number(q.price);
    const cutoff = Date.now() - 20 * 86400000;
    const old = hist.filter((h) => Date.parse(h.at) < cutoff);
    const ev = window.Signals.evaluate(old, now).filter((x) => x.correct !== null && x.correct !== undefined);
    const hit = ev.filter((x) => x.correct).length;
    return '<div class="card"><h2>Track record</h2><div class="sub">' + hist.length + ' signals saved since ' + esc(hist[0].asOf) + '. ' +
      (ev.length ? 'Of ' + ev.length + ' buy/sell signals older than 20 days, ' + hit + ' (' + (hit / ev.length * 100).toFixed(0) + '%) moved in the signalled direction so far.' :
        'Results appear once signals are at least 20 days old.') + '</div></div>';
  }

  routes.signal = () => {
    const a = computeSignals().find((x) => x.key === sigKey);
    if (!a || a.insufficient) return '<div class="empty">No signal for this asset.</div>';
    const L = a.levels, c = a.currency, I = a.indicators;
    const fname = { trend: 'Trend', momentum: 'Momentum', meanReversion: 'Overbought / oversold', risk: 'Risk (volatility)', liquidity: 'Liquidity', portfolio: 'Portfolio fit' };
    let html = '<div class="card"><div class="row"><div class="grow"><h2 style="margin:0">' + esc(MARKETS[a.market]) + ' · ' + esc(a.asOf) + '</h2><div style="font-size:18px;font-weight:700;margin-top:4px">' + esc(a.name) + '</div></div>' +
      '<span class="pill ' + pillCls(a.action) + '" style="font-size:13px">' + esc(a.action) + '</span></div>' +
      '<div class="grid2" style="margin-top:12px"><div class="kv"><div class="k">Price</div><div class="v">' + num(a.price) + ' ' + esc(c) + '</div></div>' +
      '<div class="kv"><div class="k">Score · confidence</div><div class="v">' + a.score + ' · ' + a.confidence + '%</div></div></div>' +
      '<p style="margin:12px 0 0">' + esc(a.thesis) + '</p><div class="sub" style="margin-top:8px">Strategy: <b>' + esc(a.strategyLabel) + '</b> (' + esc(a.strategyHow || '') + ')</div></div>';
    // levels
    html += '<div class="card"><h2>Levels (' + esc(L.horizon) + ')</h2><table>' +
      (L.entryLow !== null ? '<tr><td>Entry range</td><td class="n">' + num(L.entryLow) + ' – ' + num(L.entryHigh) + '</td></tr>' : '') +
      '<tr><td>' + (/SELL|REDUCE/.test(a.action) ? 'Downside target' : /BUY|ACCUM/.test(a.action) ? 'Target' : 'Resistance') + '</td><td class="n">' + num(L.target) + '</td></tr>' +
      '<tr><td>' + (/SELL|REDUCE/.test(a.action) ? 'Invalidation level' : /BUY|ACCUM/.test(a.action) ? 'Stop-loss' : 'Support') + '</td><td class="n">' + num(L.stop) + '</td></tr>' +
      (L.riskReward !== null ? '<tr><td>Reward / risk</td><td class="n">' + num(L.riskReward, 2) + '</td></tr>' : '') +
      '</table><div class="sub" style="margin-top:6px">Prices in ' + esc(c) + '. Levels come from recent volatility and the 60-day range of daily closes.</div></div>';
    // factors
    html += '<div class="card"><h2>How the score is built</h2>' + Object.keys(a.factors).map((k) => {
      const v = a.factors[k], w = a.weights[k], ctb = a.contributions[k];
      const left = v >= 0 ? 50 : 50 + v / 2, width = Math.abs(v) / 2;
      return '<div class="list-item"><div class="row"><b class="grow">' + esc(fname[k] || k) + '</b><span class="sub">score ' + Math.round(v) + ' × weight ' + w + ' → ' + (ctb >= 0 ? '+' : '') + ctb.toFixed(1) + '</span></div>' +
        '<div class="fbar"><i style="left:' + left + '%;width:' + width + '%;background:' + (v >= 0 ? 'var(--up)' : 'var(--down)') + '"></i></div>' +
        '<div class="sub" style="margin-top:4px">' + esc((a.why[k] || []).join(' · ')) + '</div></div>';
    }).join('') + Object.entries(a.unavailable).map(([k, why]) => '<div class="list-item"><div class="row"><b class="grow muted">' + esc({ fundamental: 'Fundamentals', valuation: 'Valuation', macro: 'Macro environment' }[k]) + '</b><span class="sub">not used</span></div><div class="sub">' + esc(why) + '</div></div>').join('') + '</div>';
    // indicators
    const rows = [['RSI (14)', num(I.rsi14, 1)], ['20 / 50 / 200-day average', [I.sma20, I.sma50, I.sma200].map((x) => num(x)).join(' / ')], ['MACD / signal', num(I.macd, 4) + ' / ' + num(I.macdSignal, 4)],
      ['Bollinger band (20, 2)', num(I.bbLower) + ' – ' + num(I.bbUpper)], ['60-day low / high', num(I.support) + ' / ' + num(I.resistance)], ['Change 20 / 60 days', num(I.change20, 1) + '% / ' + num(I.change60, 1) + '%'],
      ['Volatility (annualised)', num(I.volAnnualPct, 0) + '%'], ['Max drawdown', num(I.maxDrawdownPct, 0) + '%'], ['Days with no price change (60)', num(I.flatDaysPct, 0) + '%'], ['History used', I.points + ' daily closes']];
    html += '<div class="card"><h2>Indicators</h2><table>' + rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="n">' + esc(v) + '</td></tr>').join('') + '</table></div>';
    html += '<div class="card"><h2>Key risks</h2>' + a.risks.map((r) => '<div class="list-item">' + esc(r) + '</div>').join('') + '</div>';
    html += '<div class="card"><h2>What would change this view</h2>' + a.invalidation.map((r) => '<div class="list-item">' + esc(r) + '</div>').join('') + '</div>';
    html += '<div class="card"><h2>News & catalysts</h2><div class="sub">No news source is connected yet, so news is not part of this signal.</div></div>';
    const past = (st.sigHistory || []).filter((h) => h.key === a.key).slice(-8).reverse();
    if (past.length) html += '<div class="card"><h2>Signal history</h2><table>' + past.map((h) => '<tr><td>' + esc(h.asOf) + '</td><td><span class="pill ' + pillCls(h.action) + '">' + esc(h.action) + '</span></td><td class="n">' + num(h.price) + '</td></tr>').join('') + '</table></div>';
    if (a.market === 'GOLD') {
      const g21 = st.quotes['GOLD:GOLD_21K'];
      html += '<div class="note">Based on the <b>global</b> gold price: PAX Gold (PAXG, each token backed by one troy ounce of London gold) in USD per ounce, converted to JOD per gram of 24K at 0.709 JOD/USD. ' +
        'Jordanian shop prices follow it but add a premium, and 21K is about 87.5% of 24K (≈ ' + num(a.price * 0.875) + ' JOD per gram at this price)' +
        (g21 && g21.extra ? '; today shops buy 21K at ' + fmt(g21.extra.bid) + ' and sell at ' + fmt(g21.extra.ask) + ' JOD' : '') + '. Source: CoinGecko.</div>';
      html += '<button class="btn gold" style="width:100%" data-go="add" data-market="GOLD">Record a gold transaction</button>';
    } else html += '<button class="btn gold" style="width:100%" data-sigbuy="' + esc(a.key) + '">Record a transaction</button>';
    return html;
  };

  let researchKey = null;
  const link = (it) => (it.url ? '<a href="' + esc(it.url) + '" style="color:var(--accent)">' + esc(it.source || 'source') + '</a>' : esc(it.source || ''));
  routes.research = () => {
    const r = researchFor(researchKey);
    if (!r) return '<div class="empty">No research for this asset yet.</div>';
    const rec = r.recommendation, L = rec && rec.levels, c = r.currency || '';
    let html = '<div class="card"><div class="row"><div class="grow"><h2 style="margin:0">Research · ' + esc(localTime(r.generatedAt)) + '</h2><div style="font-size:18px;font-weight:700;margin-top:4px">' + esc(r.name) + '</div></div>' +
      (rec ? '<span class="pill ' + pillCls(rec.action) + '" style="font-size:13px">' + esc(rec.action) + '</span>' : '') + '</div>';
    if (r.stale) html += '<div class="note" style="margin-top:10px">This research is ' + Math.round(r.ageDays) + ' days old. The scheduled run may have failed; check the task.</div>';
    if (r.price) html += '<div class="sub" style="margin-top:8px">Price ' + num(r.price.value) + ' ' + esc(c) + ' on ' + esc(r.price.as_of) + ' · ' + link(r.price) + ' · ' + r.price.points + ' daily closes</div>';
    if (rec) {
      html += '<p style="margin:12px 0 0">' + esc(rec.thesis) + '</p>';
      if (rec.changed_reason) html += '<div class="note" style="margin-top:10px">The price model said <b>' + esc(rec.technical_action) + '</b>; the review moved it one step to <b>' + esc(rec.action) + '</b>: ' + esc(rec.changed_reason) + '</div>';
      html += '<div class="grid2" style="margin-top:12px"><div class="kv"><div class="k">Confidence</div><div class="v">' + rec.confidence + '%</div></div><div class="kv"><div class="k">Horizon</div><div class="v">' + esc(L.horizon) + '</div></div></div>';
    }
    html += '</div>';
    if (L) html += '<div class="card"><h2>Levels</h2><table>' + (L.entryLow !== null && L.entryLow !== undefined ? '<tr><td>Entry range</td><td class="n">' + num(L.entryLow) + ' – ' + num(L.entryHigh) + '</td></tr>' : '') +
      '<tr><td>Target</td><td class="n">' + num(L.target) + '</td></tr><tr><td>Stop / invalidation</td><td class="n">' + num(L.stop) + '</td></tr>' +
      (L.riskReward !== null && L.riskReward !== undefined ? '<tr><td>Reward / risk</td><td class="n">' + num(L.riskReward, 2) + '</td></tr>' : '') + '</table><div class="sub" style="margin-top:6px">Levels come from the rules-based price model, not from the review.</div></div>';
    const facts = (title, items, fmtItem) => (items && items.length ? '<div class="card"><h2>' + title + '</h2>' + items.map((it) => '<div class="list-item">' + fmtItem(it) + '</div>').join('') + '</div>' : '');
    html += facts('Fundamentals', r.fundamentals, (it) => '<div class="row"><span class="grow">' + esc(it.label) + '</span><b>' + esc(it.value) + '</b></div><div class="sub">' + esc(it.as_of || '') + ' · ' + link(it) + '</div>');
    html += facts('Analyst views', r.analysts, (it) => '<div class="row"><span class="grow">' + esc(it.label) + '</span><b>' + esc(it.value) + '</b></div><div class="sub">' + esc(it.as_of || '') + ' · ' + link(it) + '</div>');
    html += facts('News & catalysts', r.news, (it) => '<b>' + esc(it.headline) + '</b><div class="sub">' + esc(it.date || '') + ' · ' + link(it) + (it.impact ? ' · <span class="' + (it.impact === 'positive' ? 'up' : it.impact === 'negative' ? 'down' : '') + '">' + esc(it.impact) + '</span>' : '') + '</div>');
    if (rec) {
      html += '<div class="card"><h2>Key risks</h2>' + rec.risks.map((x) => '<div class="list-item">' + esc(x) + '</div>').join('') + '</div>';
      html += '<div class="card"><h2>What would change this view</h2>' + rec.invalidation.map((x) => '<div class="list-item">' + esc(x) + '</div>').join('') + '</div>';
    }
    if (r.data_gaps && r.data_gaps.length) html += '<div class="card"><h2>Data not available</h2>' + r.data_gaps.map((x) => '<div class="list-item muted">' + esc(x) + '</div>').join('') + '</div>';
    html += '<div class="sub" style="margin:0 4px 12px">Built by the scheduled research run from the cited public sources plus the app\'s price model. Not financial advice.</div>';
    if (signalFor(r.key) && !signalFor(r.key).insufficient) html += '<button class="btn ghost" style="width:100%" data-sig="' + esc(r.key) + '">Open today\'s price-model signal</button>';
    return html;
  };

  routes.settings = () => {
    const m = st.settings.methods;
    const sel = (mk) => '<select data-method="' + mk + '">' + ['FIFO', 'AVERAGE'].map((x) => '<option' + (m[mk] === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>';
    return '<div class="card"><h2>API keys (stored only on this phone)</h2>' +
      '<label>Finnhub API key — free at finnhub.io, needed for stocks/ETFs</label><input id="s_finnhub" value="' + esc(st.settings.finnhubKey) + '" autocapitalize="none">' +
      '<label>CoinGecko Demo key — optional, free at coingecko.com</label><input id="s_cg" value="' + esc(st.settings.coingeckoKey) + '" autocapitalize="none">' +
      '<button class="btn" style="margin-top:12px" data-savekeys>Save keys</button></div>' +
      '<div class="card"><h2>Signal strategy</h2><div class="sub">Auto uses whichever method did best in the strategy test for that market.</div>' + ['ASE', 'GOLD', 'US', 'CRYPTO'].map((mk) => {
        const cur = (st.settings.strategy || {})[mk] || 'auto';
        return '<label>' + esc(MARKETS[mk]) + '</label><select data-strategy="' + mk + '">' + [['auto', 'Auto (strategy test)'], ['trend', 'Trend'], ['balanced', 'Balanced'], ['dip', 'Dip-buying']].map(([v, l]) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
      }).join('') + '</div>' +
      '<div class="card"><h2>Cost method</h2>' + Object.keys(MARKETS).map((mk) => '<label>' + esc(MARKETS[mk]) + '</label>' + sel(mk)).join('') + '</div>' +
      '<div class="card"><h2>Backup</h2><div class="sub">Your data lives only on this phone. Uninstalling the app deletes it, so keep a backup.</div>' +
      '<div class="row" style="margin-top:10px"><button class="btn grow" data-export>Share backup</button></div>' +
      '<label>Restore: paste a backup here</label><textarea id="s_import"></textarea><button class="btn ghost" style="margin-top:8px" data-import>Restore backup</button></div>' +
      '<div class="card"><h2>Data sources</h2><div class="sub">Gold: Roya News / Jordanian Jewelers Syndicate (bulletins during the day).<br>Amman Stock Exchange: official end-of-day file from exchange.jo.<br>Crypto: CoinGecko (about 1 minute delay).<br>Stocks: Finnhub (free plan, delayed).<br>Currencies: ECB rates via Frankfurter; JOD/USD at the Central Bank of Jordan peg (0.709).<br><br>For personal use only. This app shows data and does not give investment advice or place trades.</div></div>';
  };

  // ------------------------------------------------------------------ render + events
  const NAV = [['home', 'Home', 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z'], ['gold', 'Gold', 'M4 18h16l-3-8H7zM8 10l2-5h4l2 5'],
    ['ase', 'Amman SE', 'M4 19V9m5 10V5m5 14v-7m5 7V8'], ['markets', 'Markets', 'M3 17l6-6 4 4 8-8M15 7h6v6'], ['signals', 'Signals', 'M12 3v4M12 17v4M3 12h4M17 12h4M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0'], ['portfolio', 'Portfolio', 'M4 7h16v12H4zM9 7V5h6v2']];
  function render() {
    $('#view').innerHTML = (routes[route] || routes.home)();
    const navRoute = route === 'add' ? 'portfolio' : route === 'aseStock' ? 'ase' : (route === 'signal' || route === 'research' || route === 'strategy') ? 'signals' : route;
    $('#nav').innerHTML = NAV.map(([r, l, p]) => '<button data-nav="' + r + '" class="' + (r === navRoute ? 'on' : '') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + p + '"/></svg>' + l + '</button>').join('');
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-runbt],[data-research],[data-aselookup],[data-nav],[data-go],[data-del],[data-savetx],[data-cancel],[data-addase],[data-asestock],[data-sig],[data-sigf],[data-sigbuy],[data-savekeys],[data-export],[data-import]');
    if (!el) return;
    if (el.dataset.nav) { stack = []; go(el.dataset.nav, false); }
    else if (el.dataset.go) { draft = null; if (el.dataset.market) { draft = null; routes.add(); draft.market = el.dataset.market; } go(el.dataset.go); }
    if ('runbt' in el.dataset) { runStrategyTest(); return; }
    if (el.dataset.research) { researchKey = el.dataset.research; go('research'); return; }
    if (el.dataset.aselookup) {
      const sym = el.dataset.aselookup; el.disabled = true; el.textContent = 'Looking up ' + sym + '…';
      loadCompany(sym).then(() => {
        st.aseExtra = [...new Set((st.aseExtra || []).concat([sym]))]; save(); signalsCache = null;
        aseSymbol = sym; go('aseStock');
      }).catch((err) => { const m = $('#lookupMsg'); if (m) m.innerHTML = '<div class="err" style="margin-top:10px">' + esc(err.message) + '</div>'; el.disabled = false; el.textContent = 'Look up ' + sym + ' on exchange.jo'; });
    }
    else if (el.dataset.sigf) { sigFilter = el.dataset.sigf; render(); }
    else if (el.dataset.sig) { sigKey = el.dataset.sig; go('signal'); }
    else if (el.dataset.sigbuy) { const [m, ...rest] = el.dataset.sigbuy.split(':'); draft = null; routes.add(); Object.assign(draft, { market: m, symbol: rest.join(':'), currency: MARKET_CCY[m] }); go('add'); }
    else if (el.dataset.asestock) { aseSymbol = el.dataset.asestock; go('aseStock'); }
    else if (el.dataset.addase) { draft = null; routes.add(); Object.assign(draft, { market: 'ASE', symbol: el.dataset.addase, currency: 'JOD' }); go('add'); }
    else if (el.dataset.del !== undefined) {
      const i = Number(el.dataset.del);
      if (confirm('Delete this ' + st.txs[i].type + ' transaction?')) {
        const rest = st.txs.filter((_, j) => j !== i);
        try { buildLedgerWith(rest); } catch (err) { toast('Cannot delete: ' + err.message); return; }
        st.txs = rest; save(); render();
      }
    } else if ('savetx' in el.dataset) saveDraft();
    else if ('cancel' in el.dataset) { draft = null; window.appBack() || go('portfolio', false); }
    else if ('savekeys' in el.dataset) { saveKeys(true); }
    else if ('export' in el.dataset) {
      const data = JSON.stringify({ app: 'monz-trader', version: 1, exported: new Date().toISOString(), txs: st.txs, settings: { methods: st.settings.methods }, watch: st.watch, goldHistory: st.goldHistory });
      st.lastBackup = new Date().toISOString(); save();
      if (window.NativeBridge) window.NativeBridge.share('Monz Trader backup ' + today(), data);
      else { $('#s_import').value = data; toast('Backup placed in the box below'); }
    } else if ('import' in el.dataset) {
      try {
        const b = JSON.parse($('#s_import').value);
        if (b.app !== 'monz-trader' || !Array.isArray(b.txs)) throw new Error('Not a Monz Trader backup');
        buildLedgerWith(b.txs);
        if (!confirm('Replace your ' + st.txs.length + ' transactions with ' + b.txs.length + ' from the backup?')) return;
        st.txs = b.txs; if (b.settings && b.settings.methods) st.settings.methods = b.settings.methods; if (b.watch) st.watch = b.watch;
        if (Array.isArray(b.goldHistory)) st.goldHistory = b.goldHistory;
        save(); toast('Backup restored'); render();
      } catch (err) { toast('Restore failed: ' + err.message); }
    }
  });
  document.addEventListener('change', (e) => {
    const id = e.target.id;
    if (route === 'add' && ['f_quantity', 'f_price', 'f_fees', 'f_currency'].includes(id)) {
      readDraft();   // no re-render: it would swallow a tap on Save that caused this change
      const tl = $('#totalLine'); if (tl) tl.innerHTML = totalLine(draft);
    } else if (route === 'add' && ['f_type', 'f_market', 'f_symbol'].includes(id)) {
      readDraft();
      if (id === 'f_market') { draft.symbol = draft.market === 'GOLD' ? 'GOLD_21K' : ''; draft.currency = MARKET_CCY[draft.market]; }
      render();
    } else if (id === 's_finnhub' || id === 's_cg') { saveKeys(false);
    } else if (e.target.dataset.strategy) { st.settings.strategy = st.settings.strategy || {}; st.settings.strategy[e.target.dataset.strategy] = e.target.value; save(); signalsCache = null; toast('Strategy updated');
    } else if (e.target.dataset.method) { st.settings.methods[e.target.dataset.method] = e.target.value; save(); toast('Cost method updated'); }
    else if (id === 'watchCrypto' || id === 'watchUs') {
      const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (id === 'watchCrypto') st.watch.crypto = list.map((s) => s.toLowerCase()); else st.watch.us = list.map((s) => s.toUpperCase());
      save(); refresh(id === 'watchCrypto' ? 'crypto' : 'us');
    }
  });
  document.addEventListener('input', (e) => {
    if (route === 'add' && draft && e.target.id && e.target.id.startsWith('f_')) { readDraft(); const tl = $('#totalLine'); if (tl) tl.innerHTML = totalLine(draft); }
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'aseSearch') { aseFilter = e.target.value; const pos = e.target.selectionStart; render(); const s = $('#aseSearch'); s.focus(); s.setSelectionRange(pos, pos); } });
  $('#refreshBtn').addEventListener('click', () => refresh('all'));

  render();
  if (!st.lastRefresh || Date.now() - Date.parse(st.lastRefresh) > 30 * 60000) refresh('all');
})();
