#!/usr/bin/env node
/* Builds data/research/latest.json from two inputs gathered by the scheduled research run:
 *
 *   prices.json  { "<key>": { name, market, currency, source, url,
 *                             series: [["YYYY-MM-DD", close], ...] } }
 *   qual.json    { "<key>": { fundamentals: [{label, value, as_of, source, url}],
 *                             news:   [{date, headline, source, url, impact}],
 *                             analysts: [{label, value, as_of, source, url}],
 *                             review: { action, reason, thesis, risks: [], data_gaps: [] } } }
 *
 * Rules enforced here (the run fails loudly instead of publishing bad data):
 *  - every price series is validated (dates ascending, unique, positive closes, no jump > 60%)
 *  - indicators, score and levels come only from signals.js (deterministic, tested)
 *  - every fundamental/news/analyst item must carry a source and an http(s) url
 *  - the reviewed action may differ from the technical action by at most one step, with a reason
 * Usage: node scripts/research/build.mjs <prices.json> <qual.json> <watchlist.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, '../../app/src/main/assets/www/signals.js'));
const G = globalThis.Signals;
const ORDER = ['STRONG SELL', 'SELL', 'REDUCE', 'HOLD', 'ACCUMULATE', 'BUY', 'STRONG BUY'];

export function validateSeries(key, series) {
  const errs = [];
  if (!Array.isArray(series) || !series.length) return ['no prices'];
  let prev = null;
  for (const [d, v] of series) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push('bad date ' + d);
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) errs.push('bad price on ' + d);
    if (prev) {
      if (d <= prev[0]) errs.push('dates not ascending at ' + d);
      else if (Math.abs(v / prev[1] - 1) > 0.6) errs.push('suspicious jump ' + prev[1] + ' -> ' + v + ' on ' + d);
    }
    prev = [d, v];
  }
  return errs.slice(0, 5).map((e) => key + ': ' + e);
}

const sourced = (x) => x && typeof x.source === 'string' && x.source.trim() && /^https?:\/\//.test(x.url || '');

export function build(prices, qual, watchlist, now = new Date()) {
  const errors = [], assets = [];
  const entries = [...(watchlist.holdings || []).map((w) => ({ ...w, held: true })), ...(watchlist.watch || []).map((w) => ({ ...w, held: false }))];
  for (const w of entries) {
    const p = prices[w.key], q = qual[w.key] || {};
    const out = { key: w.key, name: (p && p.name) || w.name, market: w.market, held: w.held, data_gaps: [] };
    if (!p) { out.data_gaps.push('no price history collected'); assets.push(out); continue; }
    const verr = validateSeries(w.key, p.series);
    if (verr.length) { errors.push(...verr); out.data_gaps.push('price history failed validation'); assets.push(out); continue; }
    const last = p.series[p.series.length - 1];
    out.currency = p.currency;
    out.price = { value: last[1], as_of: last[0], source: p.source, url: p.url, points: p.series.length };
    const t = G.analyze({ key: w.key, name: out.name, market: w.market === 'US' ? 'US' : w.market, currency: p.currency, series: p.series });
    if (t.insufficient) { out.data_gaps.push(t.insufficient); }
    else {
      out.technical = { action: t.action, score: t.score, confidence: t.confidence, levels: t.levels, indicators: t.indicators,
        factors: t.factors, contributions: t.contributions, why: t.why, thesis: t.thesis, risks: t.risks, invalidation: t.invalidation };
    }
    for (const field of ['fundamentals', 'news', 'analysts']) {
      const items = Array.isArray(q[field]) ? q[field] : [];
      const bad = items.filter((x) => !sourced(x));
      if (bad.length) errors.push(w.key + ': ' + bad.length + ' ' + field + ' item(s) without source/url');
      out[field] = items.filter(sourced);
    }
    const r = q.review || {};
    if (out.technical) {
      let action = out.technical.action, reason = null;
      if (r.action && r.action !== action) {
        const d = Math.abs(ORDER.indexOf(r.action) - ORDER.indexOf(action));
        if (ORDER.indexOf(r.action) < 0) errors.push(w.key + ': unknown review action ' + r.action);
        else if (d > 1) errors.push(w.key + ': review action ' + r.action + ' is more than one step from technical ' + action);
        else if (!r.reason) errors.push(w.key + ': review changed the action without a reason');
        else { action = r.action; reason = r.reason; }
      }
      out.recommendation = {
        action, technical_action: out.technical.action, changed_reason: reason,
        confidence: out.technical.confidence,
        thesis: r.thesis || out.technical.thesis,
        levels: out.technical.levels,                     // numbers always from the deterministic engine
        risks: [...new Set([...(r.risks || []), ...out.technical.risks])],
        invalidation: out.technical.invalidation,
      };
    }
    out.data_gaps.push(...(r.data_gaps || []));
    assets.push(out);
  }
  return { errors, doc: { schema: 1, generated_at: now.toISOString(), generator: 'Monz Trader scheduled research (trader-skill)',
    disclaimer: 'Research summary built from cited public sources and a rules-based price model. Not financial advice.', assets } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pricesF, qualF, wlF, outF] = process.argv.slice(2);
  if (!outF) { console.error('usage: build.mjs prices.json qual.json watchlist.json out.json'); process.exit(2); }
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const { errors, doc } = build(read(pricesF), read(qualF), read(wlF));
  for (const a of doc.assets) console.log(a.key.padEnd(18), a.recommendation ? a.recommendation.action.padEnd(12) : 'no rec'.padEnd(12), a.price ? a.price.value + ' ' + a.currency + ' @' + a.price.as_of : '', a.data_gaps.length ? 'gaps: ' + a.data_gaps.join('; ') : '');
  if (errors.length) { console.error('\nVALIDATION ERRORS (fix the inputs, do not publish):\n- ' + errors.join('\n- ')); process.exit(1); }
  writeFileSync(outF, JSON.stringify(doc, null, 2) + '\n');
  console.log('\nwrote ' + outF);
}
