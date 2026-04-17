# AutoG (rebuild)

Electron + Playwright desktop worker for BetterBG. Slice 1: claim a job, scrape a product, report status.

## Stack

- Electron 33 + electron-vite
- React 19 renderer (Vite)
- Playwright 1.49 in the **main process only** (persistent context per Amazon email)
- TypeScript strict, Vitest + jsdom for parser unit tests

## Architecture (per AGENTS.md)

```
src/
  renderer/              React UI — no Node APIs
  preload/               Typed IPC bridge (contextBridge)
  main/                  Electron main entry + IPC handlers + identity/settings
  browser/driver.ts      ONLY file that imports `playwright`
  actions/               Domain verbs (scrapeProduct)
  workflows/             Business logic (pollAndScrape loop)
  parsers/               Pure Document -> type functions
  bg/                    BetterBG HTTP client
  shared/                Types, logger, errors, IPC channel names
tests/unit/              Vitest + jsdom tests of parsers
fixtures/                Saved HTML for parser fixture tests
```

Higher layers import from lower. Never reverse.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start electron-vite dev (HMR renderer + main) |
| `npm run build` | Build all three targets into `out/` |
| `npm test` | Run parser unit tests |
| `npm run typecheck` | TS check both node + web configs |
| `npm run save-fixture -- <url> [name]` | Launch headless browser and save product HTML under `fixtures/` |

## Slice 1 flow

1. User pastes AutoG API key → main calls `GET /api/autog/me` to verify.
2. User hits **Start** → worker polls `POST /api/autog/jobs/claim` every 5s (exp backoff on error).
3. For each claimed job, open/reuse a Playwright persistent context keyed on `amazonEmail`, `goto(productUrl)`, return `page.content()`.
4. `parseAmazonProduct(document, url)` → `ProductInfo` (title/price/cashback%/inStock).
5. `POST /api/autog/jobs/[id]/status` with `{ status: 'completed', scraped }` or `{ status: 'failed', error }`.

## What's NOT in slice 1

- Buy Now / Place Order (scrape only)
- Filler-items rebuy
- Cashback name-toggle workaround
- Verify phase
- Login UI per Amazon profile
- Auto-update

These come after slice 1 is proven end-to-end against a live BetterBG instance.
