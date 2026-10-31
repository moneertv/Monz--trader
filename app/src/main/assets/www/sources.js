/* Market data connectors. Every quote carries: symbol, price, currency, source, retrievedAt,
 * marketTs, status (real_time | delayed | end_of_day | stale), extra. Nothing is invented:
 * if a source changes shape, the connector throws SchemaChanged and the UI shows the error. */
(function (root) {
  'use strict';
  const { Dec } = root.Core;

  class SchemaChanged extends Error {}

  // ------------------------------------------------------------------ native bridge
  const pending = {};
  let seq = 0;
  root.__nativeResolve = function (id, ok, payload) {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    ok ? p.resolve(payload) : p.reject(new Error(payload || 'Native request failed'));
  };
  function nativeCall(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!root.NativeBridge) return reject(new Error('Native bridge unavailable (open inside the app)'));
      const id = 'r' + ++seq;
      pending[id] = { resolve, reject };
      root.NativeBridge[method](id, ...args);
      setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('Timed out')); } }, 60000);
    });
  }
  async function getText(url, headers) {
    if (root.NativeBridge) return nativeCall('httpGet', url, JSON.stringify(headers || {}));
    const r = await fetch(url, { headers: headers || {} });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  const getJson = async (url, headers) => JSON.parse(await getText(url, headers));
  const now = () => new Date().toISOString();

  // ------------------------------------------------------------------ Roya gold
  // Endpoint observed on en.royanews.tv/goldprice (31 Oct 2026). Response envelope and key
  // suffixes are discovered at runtime: any object holding sell_<k>/buy_<k> fields.
  const ROYA = 'https://api.royanews.tv/api/v2/gold-prices';
  const KEY_RE = /^(sell|buy)_(.+)$/;

  function goldSymbol(suffix) {
    const s = String(suffix).toLowerCase();
    const m = s.match(/(24|22|21|18|14)/);
    if (m) return 'GOLD_' + m[1] + 'K';
    if (s.includes('rash')) return 'GOLD_LIRA_RASHADI';
    if (s.includes('eng')) return 'GOLD_LIRA_ENGLISH';
    return 'GOLD_' + s.toUpperCase();
  }
  function findRecords(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => findRecords(n, out));
    else if (node && typeof node === 'object') {
      if (Object.keys(node).some((k) => KEY_RE.test(k))) out.push(node);
      Object.values(node).forEach((v) => findRecords(v, out));
    }
    return out;
  }
  function recordTime(r) {
    for (const k of ['updated_at', 'created_at', 'date', 'updatedAt']) {
      if (typeof r[k] === 'string') {
        let s = r[k].replace(' ', 'T');
        if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += '+03:00';   // Amman
        const t = Date.parse(s);
        if (!isNaN(t)) return new Date(t).toISOString();
      }
    }
    return null;
  }
  function parseRoya(payload, retrievedAt = now()) {
    const recs = findRecords(payload);
    if (!recs.length) throw new SchemaChanged('Roya: no sell_*/buy_* fields in response');
    recs.sort((a, b) => ((recordTime(a) || '') < (recordTime(b) || '') ? -1 : 1));
    const latest = recs[recs.length - 1];
    const q = {};
    for (const [k, cell] of Object.entries(latest)) {
      const m = k.match(KEY_RE);
      if (!m) continue;
      const raw = cell && typeof cell === 'object' ? cell.price : cell;
      const inc = cell && typeof cell === 'object' ? cell.increase : null;
      const v = Dec.tryOf(raw);
      if (!v || !v.gt(0)) continue;          // 0.000 means "not quoted"
      const sym = goldSymbol(m[2]);
      q[sym] = q[sym] || { suffix: m[2] };
      q[sym][m[1] === 'sell' ? 'ask' : 'bid'] = v;
      q[sym][m[1] === 'sell' ? 'askUp' : 'bidUp'] = inc;
    }
    const marketTs = recordTime(latest);
    const out = Object.keys(q).sort().map((sym) => ({
      symbol: sym, price: q[sym].bid || q[sym].ask, currency: 'JOD', source: 'Roya News / Jordanian Jewelers Syndicate',
      retrievedAt, marketTs, status: 'delayed',
      extra: { bid: q[sym].bid || null, ask: q[sym].ask || null, bidUp: q[sym].bidUp, askUp: q[sym].askUp,
        unit: sym.includes('LIRA') ? 'piece' : 'gram', valuationSide: q[sym].bid ? 'bid' : 'ask' },
    }));
    if (!out.length) throw new SchemaChanged('Roya: response had no non-zero prices');
    return out;
  }
  async function fetchGold(day) {
    const raw = await getJson(ROYA + '?type=1&date_from=' + day + '&date_to=' + day,
      { Accept: 'application/json', Referer: 'https://en.royanews.tv/goldprice' });
    return { quotes: parseRoya(raw), raw };
  }

  // ------------------------------------------------------------------ ASE (exchange.jo)
  const ASE_SITE = 'https://exchange.jo';
  const ASE_DAILY_PAGE = ASE_SITE + '/en/history?history_category=63';
  const HEADERS = [
    ['symbol', ['symbol', 'ticker', 'رمز', 'الرمز']],
    ['code', ['code', 'رقم', 'الرقم']],
    ['name', ['name', 'company', 'اسم', 'الشركة']],
    ['date', ['date', 'تاريخ', 'التاريخ']],
    ['open', ['open', 'افتتاح']],
    ['high', ['high', 'اعلى', 'أعلى']],
    ['low', ['low', 'ادنى', 'أدنى']],
    ['prevClose', ['previous', 'prev', 'سابق']],
    ['close', ['close', 'closing', 'اغلاق', 'إغلاق']],
    ['volume', ['volume', 'shares', 'عدد الاسهم', 'الاسهم']],
    ['value', ['value', 'turnover', 'قيمة', 'حجم التداول']],
    ['trades', ['trades', 'transactions', 'contracts', 'عقود', 'صفقات']],
    ['sector', ['sector', 'قطاع', 'القطاع']],
  ];
  function mapHeader(row) {
    const m = {};
    row.forEach((cell, i) => {
      const h = String(cell || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!h) return;
      for (const [field, kws] of HEADERS) {
        if (field in m) continue;
        if (kws.some((k) => h.includes(k))) {
          if (field === 'close' && /(previous|prev|سابق)/.test(h)) continue;
          m[field] = i; break;
        }
      }
    });
    return m;
  }
  function xlDate(v) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');   // d/m/Y (Jordan)
    const n = Number(s);
    if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
    return null;
  }
  function parseAseWorkbook(book) {
    const bars = []; let saw = false;
    for (const sh of book.sheets) {
      let map = null, sheetDate = xlDate(sh.name);
      sh.rows.forEach((row, i) => {
        if (!map) {
          if (i > 15) return;
          const m = mapHeader(row);
          if ('close' in m && ('symbol' in m || 'code' in m)) { map = m; saw = true; }
          return;
        }
        const g = (f) => (f in map ? row[map[f]] : undefined);
        const sym = g('symbol') !== undefined ? g('symbol') : g('code');
        const close = Dec.tryOf(g('close'));
        const on = 'date' in map ? xlDate(g('date')) : sheetDate;
        if (!sym || !close || !on) return;
        const n = (f) => Dec.tryOf(g(f));
        bars.push({ symbol: String(sym).trim().toUpperCase(), on, close, open: n('open'), high: n('high'), low: n('low'),
          volume: n('volume'), value: n('value'), trades: n('trades'), name: g('name') ? String(g('name')).trim() : null,
          sector: g('sector') ? String(g('sector')).trim() : null });
      });
    }
    if (!saw) throw new SchemaChanged('ASE workbook: no header row with symbol/code and close');
    if (!bars.length) throw new SchemaChanged('ASE workbook: no rows with symbol, date and close');
    return bars;
  }
  function aseQuotes(bars, retrievedAt = now()) {
    const latest = {}, prev = {};
    for (const b of bars) if (!latest[b.symbol] || b.on > latest[b.symbol].on) latest[b.symbol] = b;
    for (const b of bars.slice().sort((a, c) => (a.on < c.on ? -1 : 1))) if (b.on < latest[b.symbol].on) prev[b.symbol] = b;
    return Object.keys(latest).sort().map((sym) => {
      const b = latest[sym], p = prev[sym];
      const change = p ? b.close.sub(p.close) : null;
      const noTrades = (!b.volume || b.volume.isZero()) && (!b.trades || b.trades.isZero());
      return { symbol: sym, price: b.close, currency: 'JOD', source: 'Amman Stock Exchange (exchange.jo)', retrievedAt,
        marketTs: b.on + 'T00:00:00+03:00', status: 'end_of_day',
        extra: { name: b.name, sector: b.sector, prevClose: p ? p.close : null, change,
          changePct: p && p.close.gt(0) ? change.div(p.close).mul(100) : null, volume: b.volume, value: b.value,
          trades: b.trades, tradingDate: b.on, noTrades } };
    });
  }
  function discoverXlsx(html) {
    const out = [], re = /href="([^"]+\.xlsx)"/gi;
    let m;
    while ((m = re.exec(html))) out.push(m[1].startsWith('http') ? m[1] : ASE_SITE + m[1]);
    return [...new Set(out)];
  }
  async function fetchAse() {
    const html = await getText(ASE_DAILY_PAGE);
    const links = discoverXlsx(html);
    if (!links.length) throw new SchemaChanged('ASE: no Daily Trading Data file linked on exchange.jo');
    const book = JSON.parse(await nativeCall('xlsx', links[0]));
    return { quotes: aseQuotes(parseAseWorkbook(book)), file: links[0] };
  }

  // ------------------------------------------------------------------ CoinGecko
  function parseCoinGecko(payload, retrievedAt = now()) {
    if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) throw new SchemaChanged('CoinGecko: empty response');
    return Object.keys(payload).sort().map((id) => {
      const r = payload[id];
      if (r.usd === undefined) throw new SchemaChanged('CoinGecko: usd missing for ' + id);
      return { symbol: id, price: Dec.of(r.usd), currency: 'USD', source: 'CoinGecko', retrievedAt,
        marketTs: r.last_updated_at ? new Date(r.last_updated_at * 1000).toISOString() : null, status: 'delayed',
        extra: { marketCap: r.usd_market_cap, volume24h: r.usd_24h_vol, change24h: r.usd_24h_change } };
    });
  }
  async function fetchCrypto(ids, apiKey) {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(ids.join(',')) +
      '&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true';
    return parseCoinGecko(await getJson(url, apiKey ? { 'x-cg-demo-api-key': apiKey } : {}));
  }

  // ------------------------------------------------------------------ Finnhub (US stocks/ETFs)
  async function fetchStock(symbol, token) {
    if (!token) throw new Error('Add a free Finnhub API key in Settings to load stock prices');
    const r = await getJson('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(symbol) + '&token=' + encodeURIComponent(token));
    if (!r || typeof r.c !== 'number' || (r.c === 0 && !r.t)) throw new SchemaChanged('Finnhub: no quote for ' + symbol);
    return { symbol, price: Dec.of(r.c), currency: 'USD', source: 'Finnhub', retrievedAt: now(),
      marketTs: r.t ? new Date(r.t * 1000).toISOString() : null, status: 'delayed',
      extra: { prevClose: r.pc, change: r.d, changePct: r.dp, high: r.h, low: r.l, open: r.o } };
  }

  // ------------------------------------------------------------------ FX (ECB via Frankfurter)
  function parseFrankfurter(p) {
    if (!p || !p.base || !p.rates) throw new SchemaChanged('Frankfurter: missing base/rates');
    const out = [];
    if (p.date) for (const [q, r] of Object.entries(p.rates)) out.push({ base: p.base, quote: q, on: p.date, rate: String(r), source: 'ECB via Frankfurter' });
    else for (const [d, row] of Object.entries(p.rates)) for (const [q, r] of Object.entries(row)) out.push({ base: p.base, quote: q, on: d, rate: String(r), source: 'ECB via Frankfurter' });
    return out;
  }
  async function fetchFxSeries(from, to) {
    return parseFrankfurter(await getJson('https://api.frankfurter.dev/v1/' + from + '..' + to + '?base=USD&symbols=EUR,GBP'));
  }

  // ------------------------------------------------------------------ staleness
  const MAX_AGE_MIN = { delayed: 26 * 60, end_of_day: 4 * 24 * 60, real_time: 15 };
  function checked(q, at = Date.now()) {
    const ts = Date.parse(q.marketTs || q.retrievedAt);
    const limit = q.source === 'CoinGecko' || q.source === 'Finnhub' ? 30 : MAX_AGE_MIN[q.status] || 1440;
    if (!isNaN(ts) && (at - ts) / 60000 > limit && q.status !== 'stale') return { ...q, status: 'stale', staleFrom: q.status };
    return q;
  }

  root.Sources = { SchemaChanged, parseRoya, fetchGold, goldSymbol, mapHeader, xlDate, parseAseWorkbook, aseQuotes, discoverXlsx, fetchAse,
    parseCoinGecko, fetchCrypto, fetchStock, parseFrankfurter, fetchFxSeries, checked, nativeAvailable: () => !!root.NativeBridge };
})(typeof window !== 'undefined' ? window : globalThis);
