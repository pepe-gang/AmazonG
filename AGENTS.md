# Web Automation App — Build Spec

## Stack
- **Shell:** Electron
- **Frontend:** React + Vite (scaffold with `electron-vite`)
- **Automation:** Playwright (in main process, never renderer)
- **Language:** TypeScript, strict mode
- **Unit tests:** Vitest
- **E2E tests:** Playwright Test
- **DOM parsing in tests:** jsdom

## Project Structure
/src
/renderer          # React UI, pure web code, no Node APIs
/main              # Electron main process entry
/preload           # Typed IPC bridge
/browser
driver.ts        # Thin Playwright wrapper (only file that imports playwright)
/actions           # Domain verbs: login.ts, scrapeProduct.ts, etc.
/workflows         # Business logic stringing actions together
/parsers           # Pure functions: Document -> YourType
/fixtures            # Saved HTML for parser tests
/scripts             # Fixture-saving utilities
/tests
/unit              # Vitest
/e2e               # Playwright Test

## Architecture — Three Layers

Strict rule: higher layers import from lower, never reverse.

1. **Browser driver** — wraps Playwright. Only file importing `playwright`.
2. **Domain actions** — `login()`, `scrapeProduct()`. Uses driver, doesn't know it's Playwright.
3. **Workflows** — reads like pseudocode. Strings actions together. No selectors, no `page.click`.

Renderer talks to main over typed IPC. Automation runs in main process or a worker.

## Scraper Pattern

Every scraper splits into two halves:
- `fetch` — Playwright navigates and returns `page.content()`
- `parse` — pure function: `Document -> YourType`

Tests target `parse` only. No browser needed.

## Selectors

- Use `getByRole`, `getByLabel`, `getByText`, or `data-testid`
- Never deep CSS chains or XPath
- Centralize in a Page Object Model — one file per site

## Waiting

- Rely on Playwright's auto-waiting in locators
- When explicit waits needed, wait on a specific signal: element, response, app flag
- Never `waitForTimeout`. Never `networkidle` as a crutch.

## Error Handling

- Typed errors: `NavigationError`, `SelectorNotFoundError`, `ParseError`
- Retries at the **task** level with exponential backoff, never at the action level
- On every failure: screenshot, Playwright trace, structured log (URL, timestamp, selector)

## Testing

- **Unit** — pure functions (parsers, formatters, business rules). Run on every save.
- **Fixture** — save real HTML via a script, run `parse` through jsdom, assert output. Grow library per edge case.
- **E2E** — small suite against live sites, scheduled (not every commit).
- Rule: every production bug gets a fixture + test before it's fixed.

## Observability

- Structured JSON logs, correlation ID per task
- Track success rate per site/selector
- Alert on patterns (site X down 20%), not individual failures

## Principles

- Sites will change, networks fail, elements vanish. Code defensively.
- Fix root causes, not symptoms. Retries hide bugs.
- Tasks must be idempotent — running twice produces same result or safely no-ops.
- Build vertically. Get one scrape working end-to-end before adding breadth.

## Build Order

1. Scaffold Electron + React + Vite + TypeScript (strict)
2. Typed IPC bridge between renderer and main
3. Browser driver wrapper around Playwright in main process
4. First domain action: one working end-to-end scrape
5. Split scrape into `fetch` + `parse`
6. First fixture test against `parse`
7. Second and third actions → extract Page Object Model
8. First workflow stringing actions together
9. Structured logging → retries → metrics
10. Scheduled E2E tests against live sites
