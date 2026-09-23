# TidyUp: Product Data Cleanup

TidyUp is a Shopify embedded app that scans a product catalog for missing, inconsistent and broken product data and fixes it in place, one product page section at a time. The repository keeps its original name, catalog-lint.

## What it does

- **66 checks** across the eleven sections of the product page: title and description, media, pricing, inventory, product organization, shipping, variants, search engine listing, status, sales channels and metafields. The list, with each check's severity, is in `app/lib/rules.server.js`; `npm run test:rules` prints and verifies it.
- **One page per check** listing the products it flagged, each with its current value, a suggestion and a correction field. Quick apply saves the suggestion in one click. Three checks have a bulk fix (vendor spelling, alt text, sale prices). Every change is read before it is written, logged with its previous value, and can be undone from Recent fixes.
- **Scans any catalog size**: up to 250 products inline, paced on the API rate limit; larger catalogs through a Shopify bulk operation in the background.
- **Keeps the stored result current**: product webhooks re-check a product as it changes (paid plans) or queue it (free plan); ignoring a finding, learning a word or turning a check off updates the result at once.
- **Settings**: which checks run (by family or one by one), an approved vendor list, a spelling dictionary, ignored findings, tracked metafields (up to seven, each with a required flag and a pattern) and a weekly email.

## Plans

Plans are defined once in `app/lib/plans.js` and billed through the Shopify Billing API in USD every 30 days, no trial:

| Plan | Price | Products | Areas | Extras |
| --- | --- | --- | --- | --- |
| Dust Off | free | up to 20 | the five core areas: title and description, media, pricing, inventory, product organization | full scans, Fix all, undo |
| Quick Clean | $10 | unlimited | the five core areas | inline edits, spelling dictionary, ignored findings, scans of new products, automatic re-check on product change, weekly email |
| Deep Clean | $20 | unlimited | all eleven areas | everything in Quick Clean plus tracked metafields and priority support |

The first 50 stores can take **Deep Clean Early Bird**: Deep Clean at the Quick Clean price for as long as the subscription stays active. Every feature and area is enforced in the loaders and actions as well as hidden in the pages; a plan check that fails falls back to Dust Off with a warning and blocks scans and writes until Shopify answers.

## Running locally

Requirements: Node 22.12 or newer, the Shopify CLI, a Partner organization and a development store.

```bash
npm install
npm run dev
```

`npm run dev` runs `shopify app dev`, which starts the app, keeps the app URLs in Shopify pointed at it and prints a preview URL to open the app in the store. The `.claude/launch.json` in this repo starts it with `--use-localhost`, which needs no tunnel but cannot receive webhooks.

The database is SQLite at `prisma/dev.sqlite`. Migrations run with `npm run setup` (also run by `npm run dev` on first start). A schema change needs a migration: `npx prisma migrate dev --name <change>` for an added column, or `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` written into a new folder under `prisma/migrations/` followed by `npx prisma migrate deploy` for anything else. Stop the dev server first.

## Testing

```bash
npm run test:rules
npm run lint
```

`test:rules` runs the 66 checks against `test/fixtures.mjs` (42 synthetic products: 36 that together trigger every check, 6 clean ones and 2 edge products with empty and missing fields) and asserts the exact findings per product, the check list with its labels, severities and areas, the summary counts and that empty and single-product catalogs do not throw. The runner needs no framework; `test/register.mjs` lets plain Node import the app's extensionless modules.

## Deploying

1. Host the app as a Node server: `npm run build`, then `npm run setup` (migrations) and `npm run start`. The `Dockerfile` does this; mount a persistent volume at `/app/prisma` for the SQLite file, or switch `prisma/schema.prisma` to Postgres for anything larger.
2. Set the environment:
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` (the CLI provides these in development).
   - `NODE_ENV=production`.
   - `BILLING_TEST`: `false` for real charges. Unset, production means real charges and anything else means test charges, which are the only kind a development store accepts. Any other value stops the app at startup.
   - `SUPPORT_WEBHOOK_URL` (optional): support form messages are also posted here as JSON with a `text` field, which suits a Slack incoming webhook, Zapier or Make.
   - `RESEND_API_KEY`: the weekly email is sent with [Resend](https://resend.com). Without a key, Send test email in Settings reports that the key is missing and nothing is sent.
   - `DIGEST_FROM` (optional): the sender, such as `TidyUp <hello@yourdomain.com>`, once that domain is verified in Resend. Unset, the Resend onboarding sender is used, which only delivers to the address of the Resend account.
   - `CRON_SECRET`: the scheduler on the host calls `GET /cron/digest` once a week with this value as a bearer token or an `X-Cron-Secret` header. Unset, the route answers 503 and no weekly email goes out.

   In development, put any of these in a `.env` file at the project root: the Shopify CLI loads it when `npm run dev` starts, so restart the dev server after changing it.
3. Put the hosted URL in `shopify.app.production.toml` (`application_url` and `redirect_urls`), then `npm run deploy -- -c production` to push the config, the app name, the access scopes and the webhook subscriptions to Shopify. The plain `shopify.app.toml` is the localhost development config and carries no webhook subscriptions, because a localhost session cannot register them.

The access scopes are `write_products`, `write_files` (image alt text is written with `fileUpdate`), `read_inventory`, `write_inventory`, `read_publications`, `write_publications` and `read_locales`. The Admin API version is 2026-10 in `app/shopify.server.js` and for webhooks in both tomls; change both together.

## Versions

The version is in `package.json`, shows on the Support page in the app and is tagged in git as `vX.Y.Z`; `CHANGELOG.md` lists what each version changed. To cut one:

1. Move the Unreleased entries in `CHANGELOG.md` under the new number with the date, and commit that. `npm version` refuses to run with uncommitted changes.
2. Run `npm version minor` (or `patch` for fixes only, `major` for a break merchants would notice). It updates `package.json` and `package-lock.json`, commits them and creates the tag.
3. Push with `git push --follow-tags`.

Versions stay below 1.0.0 until the app is listed in the App Store. The first version, 0.9.0, was set and tagged by hand.

## Webhooks

`shopify.app.production.toml` subscribes to `app/uninstalled`, `app/scopes_update`, `products/create`, `products/update`, `app_subscriptions/update` and the three privacy topics (`customers/data_request`, `customers/redact`, `shop/redact`). The handlers are in `app/routes/webhooks.*.jsx`; every one verifies the HMAC first, answers at once and is safe to repeat. `app/uninstalled` deletes the sessions, turns the weekly email off and closes any running export; `shop/redact` deletes everything stored for the shop. Webhooks reach the app only when it is hosted at a public URL.

## Layout

- `app/routes/` the pages: home (`app._index.jsx`), issue pages (`app.issues.$ruleId.jsx`), Settings, Tracked metafields, Dictionary, Ignored findings, Plans, Support, Recent fixes and its batch page, the webhooks and the cron route.
- `app/lib/rules.server.js` the checks; `checkGroups.js` and `checkLabels.js` their families, tiers and wording; `categories.js` the areas; `plans.js` the plans.
- `app/lib/scan.server.js` reads the catalog (inline or bulk) and runs the checks; `rescan.server.js` keeps the stored scan current after each action; `scans.server.js` stores results (the last twenty per shop).
- `app/lib/graphql.server.js` is the one door to the Admin API: paced on the cost bucket, retried on throttling, errors as plain sentences.
- `app/lib/fixes.server.js`, `edits.server.js` and `writes.server.js` apply and undo changes; every write goes through `writes.server.js`, is preceded by a read of the value it replaces, and is logged. `validate.server.js` checks typed values, `regex.server.js` merchant patterns, `lock.server.js` serializes writes per shop.
- `app/lib/billing.server.js` the plan of a shop and the Early Bird seats; `events.server.js` the product webhooks.
- `prisma/` the schema and migrations; `test/` the rule fixtures and test.
