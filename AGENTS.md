# TidyUp: Product Data Cleanup

A Shopify embedded app (React Router 7 framework mode, `@shopify/shopify-app-react-router`, Polaris web components, Prisma with SQLite) that scans a product catalog with 66 checks and fixes what it finds in place. The README describes what it does, the plans, how to run, test and deploy it; `AUDIT.md` records the last full audit and its open questions.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts); do not add tooling to this repo.

## How the app is put together

- Checks live in `app/lib/rules.server.js` (product rules run per product, catalog rules once over all products). The list of 66, their labels, severities and areas are a product decision: do not add, remove or reword a check without asking. A new check needs an entry in `checkGroups.js` (family) and `checkLabels.js` (pass label) and a fixture in `test/fixtures.mjs`.
- Every Admin API call goes through `app/lib/graphql.server.js` (pacing, throttle retries, plain error messages). Every write goes through `app/lib/writes.server.js`, reads the value it replaces first, and is logged to `FixLog` so it can be undone. The browser never sends an edit descriptor: the issue page posts a finding key and the server looks the finding up in the stored scan.
- Plans and features are in `app/lib/plans.js`. Gate every feature and area on the server (loader and action) as well as in the page. A plan check that fails means Dust Off plus `planUnknown`: pages warn, scans and writes wait.
- The stored scan is a `Scan` row per save (pruned to the last twenty); `rescan.server.js` refreshes it after actions without re-reading the catalog. Catalogs over 250 products scan through a bulk operation finished in the background.
- Pages use Polaris web components only, sentence-case headings, verbs on buttons, no exclamation marks, no custom colors or typography (the app is to pass Shopify's review).

## Working in this repo

- Run `npm run test:rules` and `npm run lint` before committing; both must pass.
- Schema changes need a migration under `prisma/migrations/` (see the README); stop the dev server first.
- The dev config `shopify.app.toml` has no webhook subscriptions on purpose; production ones live in `shopify.app.production.toml`. Keep the API version in `app/shopify.server.js` and both tomls the same.
- Copy: American English, sentence case, "compare-at price", "weekly email", "Fix all".
- Versions: the number lives in `package.json` only (the Support page reads it); note user-visible changes under Unreleased in `CHANGELOG.md`. Cut a version as the README describes: commit the changelog first, then `npm version`, then push with tags.
