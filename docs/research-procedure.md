---
name: trader-skill
description: Daily research for the Monz Trader app: gather cited prices, fundamentals, analyst views and news for the watchlist, compute signals, and publish data/research/latest.json.
---

# Monz Trader research run

Produces `data/research/latest.json` in the GitHub repo **moneertv/Monz--trader**. The Android app downloads it on Refresh and shows a researched recommendation (★) for each holding.

## Non-negotiable rules
- **Never invent numbers.** Every price, ratio, figure and news item must come from a page you actually fetched in this run, with its URL. If you cannot find something, record it under `data_gaps` instead.
- **Prices are transcribed, not estimated.** Copy closes exactly as shown on the source page. Do not fill missing days.
- **Indicators, scores, entry, target and stop come only from `scripts/research/build.mjs`** (the app's tested signals engine). You never write levels yourself.
- **Your review may move the action by at most one step** from the price model's action (e.g. BUY -> ACCUMULATE), and only with a stated, sourced reason (e.g. a profit warning, a dividend cut, a suspension). The build script rejects anything else.
- **Privacy:** the repo is public. Never write quantities, purchase prices or any personal data. `data/watchlist.json` holds symbols only.
- Research only. Never place orders or contact anyone.

## Steps

### 1. Get the repo
Attach and clone `moneertv/Monz--trader` with push access (add_repo, then the clone command it gives). Work in the clone. Read `data/watchlist.json`: `holdings` (the user's assets) and `watch` (extra assets). Holdings are the priority; if time runs short, finish holdings first.

### 2. Collect price history -> `work/prices.json`
Use **WebFetch** (the shell usually cannot reach these sites; do not try curl). Aim for at least 80 daily closes; the model needs 60.

| Market | Source |
|---|---|
| `ASE:<SYM>` | `https://www.exchange.jo/en/company_historical/<SYM>?page=0..4` (20 trading days per page, newest first; columns Date dd/mm/yyyy, High, Low, Closing, Value Traded, No. of Trans, No. of Shares). Ask WebFetch to return the table rows verbatim as CSV. Currency JOD. |
| `US:<SYM>` | Try `https://stooq.com/q/d/l/?s=<sym>.us&i=d` (CSV). If unavailable, the Nasdaq historical page for the symbol. Currency USD. |
| `CRYPTO:<id>` | `https://api.coingecko.com/api/v3/coins/<id>/market_chart?vs_currency=usd&days=180&interval=daily`. One close per UTC day. Currency USD. |
| `GOLD:GLOBAL` | CoinGecko id `pax-gold` as above (USD per troy ounce), then convert each close to **JOD per gram of 24K** = usd x 0.709 / 31.1034768. Currency JOD. |

Format (dates ascending, one close per day, numbers not strings):
```json
{ "ASE:RJAL": { "name": "...", "market": "ASE", "currency": "JOD", "source": "Amman Stock Exchange",
               "url": "https://www.exchange.jo/en/company_historical/RJAL", "series": [["2026-07-01", 0.52], ...] } }
```
Spot-check: the latest close you transcribed must match the page; the build script also rejects unsorted dates and jumps over 60%.

### 3. Collect research -> `work/qual.json`
For each asset, using WebSearch and WebFetch (prefer primary sources):
- **fundamentals** (stocks/ETFs): latest reported revenue, net profit, EPS, P/E, P/B, dividend yield/last dividend, debt level, for ETFs expense ratio, holdings count and Sharia screening provider. Sources: exchange.jo company profile and disclosures (`https://www.exchange.jo/en/company/<id>`, disclosures pages), the company's investor-relations page, the ETF issuer's page.
- **analysts:** consensus rating or price targets only if a named public source shows them.
- **news:** at most 5 items from the last 30 days that could move the price (results, dividends, guidance, suspensions, major contracts, regulation). For gold and crypto, the main macro drivers (central-bank decisions, USD moves, ETF flows), each with a link. Mark each `impact` as positive, negative or neutral.
- **review:** a 2–4 sentence `thesis` in plain English that explains the price model's reading together with the news and fundamentals; optional `action` (one step at most from the model, see step 4) with `reason`; extra `risks`; and `data_gaps` listing what you could not find.

Every fundamentals/analysts/news item needs `source` and `url`:
```json
{ "ASE:RJAL": { "fundamentals": [{"label": "Net profit H1 2026", "value": "JOD 1.2m", "as_of": "2026-06-30", "source": "ASE disclosure", "url": "https://..."}],
               "analysts": [], "news": [{"date": "2026-10-28", "headline": "...", "source": "Petra", "url": "https://...", "impact": "neutral"}],
               "review": {"thesis": "...", "risks": ["..."], "data_gaps": ["no analyst coverage"]} } }
```

### 4. Build and validate
```bash
node scripts/research/build.mjs work/prices.json work/qual.json data/watchlist.json data/research/latest.json
```
It prints each asset's model action. If you want to adjust one, add `review.action` + `review.reason` and rerun. If it reports validation errors, fix the inputs (re-fetch, remove the unsourced item) and rerun. Never edit `latest.json` by hand. Also run `node --test tests/research.test.js`.

### 5. Publish
Commit only `data/research/latest.json` (do not commit `work/`). Message: `Research update YYYY-MM-DD`. Fetch and rebase on `origin/main` first, then push to `main`. Pushes under `data/` do not rebuild the APK.

### 6. Report
End with a short summary: date, each holding's action (and whether the review changed it, why), notable news, and data gaps. If anything failed (source down, validation errors you could not resolve), say what and keep yesterday's file untouched.
