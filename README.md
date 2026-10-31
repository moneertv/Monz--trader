# Monz Trader

Personal Android app tracking a JOD-based portfolio across Jordan gold, the Amman Stock
Exchange, US stocks/ETFs and crypto. Everything runs on the phone; data stays on the phone.

## Get the APK
Every push to `main` builds the app on GitHub. Open the repo's **Releases** page on your phone
→ latest "Monz Trader build" → tap **MonzTrader.apk** → allow installing from your browser.

## What it does
- **Gold:** live Jordanian Jewelers Syndicate prices via Roya News (24K, 21K, 18K, 14K, liras;
  shop-sells and shop-buys). Each bulletin is saved on the phone to build a 21K history chart.
- **Amman SE:** official end-of-day file from exchange.jo (close, change, volume, no-trade flag).
- **Crypto:** CoinGecko. **Stocks/ETFs:** Finnhub (free key in Settings).
- **Portfolio:** buys, sells, transfers between your accounts, dividends, splits, deposits.
  FIFO or average cost per market. Value and profit in JOD and in each asset's own currency.
  Gold valued at the shop-buys price. Money-weighted return (XIRR).
- Every price shows its source and age; old prices are marked *stale*, missing prices are
  never replaced with your purchase cost.
- Backup/restore through Android's share sheet.

## Project layout
- `app/src/main/java/.../MainActivity.java` — WebView host + network/Excel bridge
- `app/src/main/assets/www/` — app (`core.js` engine, `sources.js` data, `app.js` screens)
- `tests/core.test.js` — engine tests (`node --test tests/core.test.js`)
- `docs/technical-plan.md` — data-source research and roadmap

Not yet included: recommendations engine, risk analytics, optimizer, alerts (see roadmap).
Data is for personal use; this app does not give investment advice or place trades.
