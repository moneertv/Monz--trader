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
  // Verified 31 Oct 2026 by reading the official files:
  //  * closing_prices_YYYY.xlsx (history_category=65): one sheet, header row
  //    "Symbol | Code | Name | 2026-01-04 | 2026-01-05 | ..." and one row per company with the
  //    closing price for each trading day. This is the per-stock price source (end of day).
  //  * "Daily Trading Data" (history_category=63): market-wide totals, rows newest first:
  //    Date (Excel serial) | Market Capitalization (JD) | Value Traded (JD) | No. of Shares Traded |
  //    No. of Transactions | Free Float Index ASEGI | Percentage Change % | ASE20 | ASETR | P/E.
  //    An Arabic header row sits above the English one.
  const ASE_SITE = 'https://exchange.jo';
  const ASE_CLOSING_PAGE = ASE_SITE + '/en/history?history_category=65';
  const ASE_DAILY_PAGE = ASE_SITE + '/en/history?history_category=63';
  const SOURCE_ASE = 'Amman Stock Exchange (exchange.jo)';

  function xlDate(v) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');   // d/m/Y (Jordan)
    const n = Number(s);
    if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
    return null;
  }
  const norm = (c) => String(c || '').replace(/\s+/g, ' ').trim().toLowerCase();

  /** Wide closing-prices workbook -> {symbol: {code, name, series: [[date, Dec], ...]}} */
  function parseClosingPrices(book) {
    for (const sh of book.sheets) {
      for (let h = 0; h < Math.min(sh.rows.length, 15); h++) {
        const head = sh.rows[h];
        const sIdx = head.findIndex((c) => ['symbol', 'الرمز', 'رمز'].includes(norm(c)));
        if (sIdx < 0) continue;
        const codeIdx = head.findIndex((c) => ['code', 'الرقم', 'رقم'].includes(norm(c)));
        const nameIdx = head.findIndex((c) => ['name', 'الاسم', 'اسم الشركة'].includes(norm(c)));
        const dateCols = [];
        head.forEach((c, i) => { const d = i !== sIdx && i !== codeIdx && i !== nameIdx ? xlDate(c) : null; if (d) dateCols.push([i, d]); });
        if (dateCols.length < 1) continue;
        dateCols.sort((a, b) => (a[1] < b[1] ? -1 : 1));
        const out = {};
        for (const row of sh.rows.slice(h + 1)) {
          const sym = String(row[sIdx] || '').trim().toUpperCase();
          if (!sym) continue;
          const series = [];
          for (const [i, d] of dateCols) { const v = Dec.tryOf(row[i]); if (v && v.gt(0)) series.push([d, v]); }
          out[sym] = { code: codeIdx >= 0 ? String(row[codeIdx] || '').trim() : null, name: nameIdx >= 0 ? String(row[nameIdx] || '').trim() : null, series };
        }
        if (!Object.keys(out).length) throw new SchemaChanged('ASE closing prices: header found but no company rows');
        return { latestDate: dateCols[dateCols.length - 1][1], companies: out };
      }
    }
    throw new SchemaChanged('ASE closing prices: no header row with Symbol and trading-day dates');
  }

  function closingQuotes(parsed, retrievedAt = now()) {
    const { latestDate, companies } = parsed;
    return Object.keys(companies).sort().filter((s) => companies[s].series.length).map((sym) => {
      const c = companies[sym], ser = c.series, last = ser[ser.length - 1], prev = ser.length > 1 ? ser[ser.length - 2] : null;
      const change = prev ? last[1].sub(prev[1]) : null;
      return { symbol: sym, price: last[1], currency: 'JOD', source: SOURCE_ASE, retrievedAt,
        marketTs: last[0] + 'T00:00:00+03:00', status: 'end_of_day',
        extra: { name: c.name, code: c.code, tradingDate: last[0], fileDate: latestDate, prevClose: prev ? prev[1] : null, prevDate: prev ? prev[0] : null,
          change, changePct: prev && prev[1].gt(0) ? change.div(prev[1]).mul(100) : null,
          // the file carries a price only on days with a closing price; an older last date means no recent trade
          notTradedSinceFileDate: last[0] < latestDate } };
    });
  }

  /** Market-wide row from the Daily Trading Data workbook (newest row). */
  function parseMarketSummary(book) {
    const fields = [['date', ['date']], ['marketCap', ['market capitalization']], ['valueTraded', ['value traded']], ['shares', ['shares traded']],
      ['trades', ['transactions']], ['asegi', ['asegi', 'free float index asegi']], ['changePct', ['percentage change']], ['ase20', ['ase20']], ['asetr', ['asetr']], ['pe', ['p/e']]];
    for (const sh of book.sheets) {
      for (let h = 0; h < Math.min(sh.rows.length, 15); h++) {
        const head = sh.rows[h].map(norm);
        if (!head.includes('date') || !head.some((c) => c.includes('asegi') || c.includes('market capitalization'))) continue;
        const idx = {};
        for (const [f, kws] of fields) { const i = head.findIndex((c) => kws.some((k) => c === k || c.includes(k))); if (i >= 0) idx[f] = i; }
        const rows = [];
        for (const r of sh.rows.slice(h + 1)) { const d = xlDate(r[idx.date]); if (d) rows.push([d, r]); }
        if (!rows.length) break;
        rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
        const [d, r] = rows[0], g = (f) => (f in idx ? Dec.tryOf(r[idx[f]]) : null);
        return { date: d, marketCap: g('marketCap'), valueTraded: g('valueTraded'), shares: g('shares'), trades: g('trades'), asegi: g('asegi'),
          changePct: g('changePct'), ase20: g('ase20'), asetr: g('asetr'), pe: g('pe'), source: SOURCE_ASE,
          asegiHistory: rows.slice(0, 260).reverse().map(([dd, rr]) => [dd, idx.asegi !== undefined ? Number(rr[idx.asegi]) : null]).filter((x) => Number.isFinite(x[1])) };
      }
    }
    throw new SchemaChanged('ASE daily trading data: no header row with Date and ASEGI');
  }

  // Per-company history page (covers every listed company, 20 trading days per page, newest first):
  //   https://www.exchange.jo/en/company_historical/{SYMBOL}?page=N
  //   columns: Date (dd/mm/yyyy) | High | Low | Closing | Value Traded | No. of Trans | No. of Shares
  const stripTags = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  function parseCompanyHistorical(html) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const name = h1 ? stripTags(h1[1]).replace(/\s*Historical\s*$/i, '') : null;
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    const t = tables.find((x) => /Closing/i.test(x) && /No\. of Shares/i.test(x));
    if (!t) return { name, rows: [] };
    const head = (t.match(/<tr[\s\S]*?<\/tr>/i) || [''])[0];
    const cols = (head.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map((c) => stripTags(c).toLowerCase());
    const idx = (k) => cols.findIndex((c) => c.startsWith(k));
    const I = { date: idx('date'), high: idx('high'), low: idx('low'), close: idx('closing'), value: idx('value'), trades: idx('no. of trans'), shares: idx('no. of shares') };
    if (I.date < 0 || I.close < 0) throw new SchemaChanged('ASE company page: Date/Closing columns not found');
    const rows = [];
    for (const tr of (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).slice(1)) {
      const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(stripTags);
      const on = xlDate(cells[I.date]), close = Dec.tryOf(cells[I.close]);
      if (!on || !close || !close.gt(0)) continue;
      const g = (k) => (I[k] >= 0 ? Dec.tryOf(cells[I[k]]) : null);
      rows.push({ on, close, high: g('high'), low: g('low'), value: g('value'), trades: g('trades'), shares: g('shares') });
    }
    return { name, rows };
  }
  function companyQuote(symbol, name, rows, retrievedAt = now()) {
    const sorted = rows.slice().sort((a, b) => (a.on < b.on ? -1 : 1));
    const last = sorted[sorted.length - 1], prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    const change = prev ? last.close.sub(prev.close) : null;
    return { symbol, price: last.close, currency: 'JOD', source: SOURCE_ASE + ' company page', retrievedAt,
      marketTs: last.on + 'T00:00:00+03:00', status: 'end_of_day',
      extra: { name, tradingDate: last.on, fileDate: last.on, prevClose: prev ? prev.close : null, prevDate: prev ? prev.on : null, change,
        changePct: prev && prev.close.gt(0) ? change.div(prev.close).mul(100) : null, high: last.high, low: last.low,
        volume: last.shares, value: last.value, trades: last.trades, notTradedSinceFileDate: false, fromCompanyPage: true } };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchCompanyHistory(symbol, pages = 4) {
    const sym = String(symbol).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(sym)) throw new Error('Not a valid ASE symbol: ' + symbol);
    let name = null; const rows = [];
    for (let p = 0; p < pages; p++) {
      const parsed = parseCompanyHistorical(await getText('https://www.exchange.jo/en/company_historical/' + sym + '?page=' + p));
      name = name || parsed.name;
      if (!parsed.rows.length) break;
      rows.push(...parsed.rows);
      if (parsed.rows.length < 20) break;
      await sleep(700);   // be gentle with exchange.jo
    }
    if (!rows.length) throw new Error(sym + ' was not found on exchange.jo, or has no trading history');
    return { symbol: sym, name, rows, quote: companyQuote(sym, name, rows) };
  }

  function discoverXlsx(html) {
    const out = [], re = /href="([^"]+\.xlsx)"/gi;
    let m;
    while ((m = re.exec(html))) out.push(m[1].startsWith('http') ? m[1] : ASE_SITE + m[1]);
    return [...new Set(out)];
  }
  async function fetchAse() {
    const html = await getText(ASE_CLOSING_PAGE);
    const links = discoverXlsx(html);
    const year = new Date().getFullYear();
    const link = links.find((u) => u.includes('closing_prices_' + year)) || links.find((u) => u.includes('closing_prices_' + (year - 1)));
    if (!link) throw new SchemaChanged('ASE: no closing-prices file for ' + year + ' linked on exchange.jo');
    const parsed = parseClosingPrices(JSON.parse(await nativeCall('xlsx', link)));
    let market = null, marketError = null;
    try {
      const dl = discoverXlsx(await getText(ASE_DAILY_PAGE));
      if (dl.length) market = parseMarketSummary(JSON.parse(await nativeCall('xlsx', dl[0])));
    } catch (e) { marketError = e.message; }
    return { quotes: closingQuotes(parsed), parsed, file: link, market, marketError };
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

  /** Daily closes for one coin (CoinGecko market_chart, one point per UTC day). */
  function parseCoinHistory(payload) {
    if (!payload || !Array.isArray(payload.prices)) throw new SchemaChanged('CoinGecko market_chart: prices missing');
    const byDay = {};
    for (const [ms, p] of payload.prices) if (Number.isFinite(ms) && Number.isFinite(p)) byDay[new Date(ms).toISOString().slice(0, 10)] = p;
    return Object.keys(byDay).sort().map((d) => [d, byDay[d]]);
  }
  async function fetchCryptoHistory(id, apiKey) {
    const url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(id) + '/market_chart?vs_currency=usd&days=365&interval=daily';
    return parseCoinHistory(await getJson(url, apiKey ? { 'x-cg-demo-api-key': apiKey } : {}));
  }

  // ------------------------------------------------------------------ Finnhub (US stocks/ETFs)
  async function fetchStock(symbol, token) {
    if (!token) throw new Error('Add a free Finnhub API key in Settings to load stock prices');
    let r;
    try { r = await getJson('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(symbol) + '&token=' + encodeURIComponent(token)); }
    catch (e) {
      if (/HTTP 401|HTTP 403/.test(e.message)) throw new Error('Finnhub rejected the API key. Check it in Settings (paste it once, no spaces).');
      if (/HTTP 429/.test(e.message)) throw new Error('Finnhub rate limit reached; try again in a minute.');
      throw e;
    }
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

  /** Clean a pasted API key: trim, drop spaces, and undo an accidental double paste ("abcabc" -> "abc"). */
  function cleanKey(k) {
    let s = String(k || '').replace(/\s+/g, '');
    if (s.length >= 16 && s.length % 2 === 0 && s.slice(0, s.length / 2) === s.slice(s.length / 2)) s = s.slice(0, s.length / 2);
    return s;
  }

  const RESEARCH_URL = 'https://raw.githubusercontent.com/moneertv/Monz--trader/main/data/research/latest.json';
  async function fetchResearch() {
    const doc = await getJson(RESEARCH_URL + '?t=' + Date.now(), { 'Cache-Control': 'no-cache' });
    if (!doc || doc.schema !== 1 || !Array.isArray(doc.assets)) throw new SchemaChanged('Research file has an unexpected format');
    return doc;
  }

  root.Sources = { cleanKey, fetchResearch, RESEARCH_URL, SchemaChanged, parseRoya, fetchGold, goldSymbol, xlDate, parseClosingPrices, closingQuotes, parseMarketSummary, discoverXlsx, fetchAse, parseCompanyHistorical, companyQuote, fetchCompanyHistory,
    parseCoinGecko, fetchCrypto, parseCoinHistory, fetchCryptoHistory, fetchStock, parseFrankfurter, fetchFxSeries, checked, nativeAvailable: () => !!root.NativeBridge };
})(typeof window !== 'undefined' ? window : globalThis);
