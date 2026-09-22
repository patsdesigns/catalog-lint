# TidyUp: Product Data Cleanup

TidyUp scans a Shopify product catalog for missing, inconsistent and broken product data and fixes it in place, one product page section at a time.

## What it does

- **80 checks** across every section of the product page: title and description, spelling, SEO, images and alt text, SKUs and barcodes, stock, prices and margins, weight, variants, product category, vendor and type, tags and collections, status, sales channels and metafields.
- **One page per check** listing the products it flagged, each with the current value and a correction field. Bulk fixes for the mechanical ones (vendor spelling, alt text, sale prices), all logged and undoable per product.
- **Scans any catalog size**: small catalogs inline, large ones through a Shopify bulk operation in the background.
- **Plans** through Shopify billing: Dust Off (free, 20 products), Quick Clean and Deep Clean (every 30 days, USD, any number of products).

## Running locally

Requirements: Node 20 or newer, the Shopify CLI, a Partner organization and a development store.

```bash
npm install
npm run dev
```

`npm run dev` runs `shopify app dev`, which starts the app, keeps the app URLs in Shopify pointed at it and prints a Preview URL to open the app in the store. The `.claude/launch.json` in this repo starts it with `--use-localhost`, which needs no tunnel but cannot receive webhooks.

The database is SQLite at `prisma/dev.sqlite`. Migrations run with `npm run setup` (also run by `npm run dev` on first start).

## Deploying

1. Host the app as a Node server: `npm run build`, then `npm run setup` (migrations) and `npm run start`. A `Dockerfile` is included. SQLite needs a persistent disk; switch `prisma/schema.prisma` to Postgres for anything larger.
2. Set the environment:
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` (the CLI provides these in development).
   - `NODE_ENV=production`.
   - `BILLING_TEST`: `false` for real charges. Unset, production means real charges and anything else means test charges, which are the only kind a development store accepts.
   - `SUPPORT_WEBHOOK_URL` (optional): support form messages are also posted here as JSON with a `text` field, which suits a Slack incoming webhook, Zapier or Make.
3. Put the hosted URL in `shopify.app.toml` (`application_url` and `redirect_urls`), then `npm run deploy` to push the config, the app name and the webhook subscriptions to Shopify.

## Billing and plans

Plans are defined once in `app/lib/plans.js`: name, price, product limit and feature flags. The billing config in `app/shopify.server.js` is built from that list, so plan names always match. The Plans page requests or cancels subscriptions; every page reads the current plan through `app/lib/billing.server.js` and gates features on both the server and the page. Shopify only allows the Billing API for apps with public distribution.

## Webhooks

`shopify.app.toml` subscribes to `app/uninstalled`, `app/scopes_update` and the three privacy topics (`customers/data_request`, `customers/redact`, `shop/redact`). The handlers are in `app/routes/webhooks.*.jsx`; `shop/redact` deletes everything stored for the shop. Webhooks reach the app only when it is hosted at a public URL.

## Layout

- `app/routes/` the pages: home (`app._index.jsx`), issue pages (`app.issues.$ruleId.jsx`), Settings, Dictionary, Plans, Support, recent fixes and webhooks.
- `app/lib/rules.server.js` the checks; `checkGroups.js` and `checkLabels.js` their families, tiers and wording.
- `app/lib/scan.server.js` reads the catalog (inline or bulk) and runs the checks; `rescan.server.js` keeps the stored scan current after each action.
- `app/lib/fixes.server.js`, `edits.server.js` and `writes.server.js` apply and undo changes; every change is logged.
- `prisma/` the schema and migrations.
