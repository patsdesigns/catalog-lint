# App Store submission checklist

State on 2026-09-23, after the audit in `AUDIT.md`. "Done" means it is in the code or the deploy config; "Needed" means something outside the repository, or a decision, still has to happen.

## Listing

| Item | Status | Notes |
| --- | --- | --- |
| App name in the admin | Done | `name = "TidyUp"` in both tomls: short, so it never truncates in the admin navigation (a Built for Shopify rejection reason). |
| Listing name | Needed | Set **TidyUp: Product Data Cleanup** as the listing name in the Partner Dashboard. |
| App introduction (100 characters) and description | Needed | Written in the Partner Dashboard. Say what it does (scans product data, fixes it in place, undo), no outcome promises. |
| Privacy policy URL | Needed | A public page that says what TidyUp stores: product data findings, fix logs, settings, the support form and the weekly email address; no customer data. Required for the listing. |
| Support email and support URL | Needed | The in-app Support page stores messages and can forward them (`SUPPORT_WEBHOOK_URL`); the listing still needs an email address. |
| App icon | Needed | 1200 by 1200, no Shopify branding. |
| Screenshots | Needed | 1600 by 900, three to six, desktop, no browser chrome, no pricing in the images. Suggested: the home overview after a scan, an issue page with Quick apply, the Settings page, Recent fixes, the Plans page. Add one phone-width shot if mobile is claimed. |
| Pricing in the listing | Needed | Must match `app/lib/plans.js`: Dust Off free (20 products), Quick Clean $10 every 30 days, Deep Clean $20 every 30 days, Early Bird $10 for the first 50 paying stores (not available on development stores). No trial. |
| Demo store or test instructions | Needed | A development store with products that trigger a range of checks. Charges on development stores are always test charges, so reviewers can try every plan except Early Bird. Say that Early Bird is Deep Clean at the Quick Clean price for the first 50 paying stores, shown but not selectable on development stores. |
| Demo screencast | Needed | A video of setup and the main features as the listing describes them, in English or with English subtitles (App Store requirement 4.5.3). |
| Emergency developer contact | Needed | Set in the Partner Dashboard account settings (App Store requirement 4.5.6). |

## Hosting and configuration

| Item | Status | Notes |
| --- | --- | --- |
| Public HTTPS host | Needed | `application_url` and `redirect_urls` in `shopify.app.production.toml`, then `npm run deploy -- -c production`. |
| Environment | Needed | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `NODE_ENV=production`, `BILLING_TEST=false`, `RESEND_API_KEY`, `DIGEST_FROM`, `CRON_SECRET`, optionally `SUPPORT_WEBHOOK_URL`. |
| Database | Needed | A persistent volume at `prisma/` (the Dockerfile declares it), or Postgres. `npm run setup` applies migrations. |
| Weekly email schedule | Needed | A scheduler that calls `GET /cron/digest` once a week with the secret. |
| Access scopes | Done | `write_products, write_files, read_inventory, write_inventory, read_publications, write_publications, read_locales`; nothing unused. Existing installs are asked to re-approve after the change (metaobject scopes were removed, `read_locales` and `write_files` added). |
| Admin API version | Done | 2026-10 in the client (`@shopify/shopify-app-react-router` 3) and for webhooks. |

## Requirements that are met in the code

- Embedded in the admin with the latest App Bridge (`AppProvider`, `s-app-nav`), session token authentication on every `/app` route, no cookies.
- GraphQL Admin API only; no REST.
- Billing through the Billing API with in-app upgrade and downgrade and declined charges handled. Development stores always get test charges, where Shopify's reviewers and other Partners try the app; real stores are charged for real in production.
- No page asks for a store address: the one page outside the admin points to the admin and the App Store, and links that name the store go straight to the install.
- Mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) handled and registered in the production config; `shop/redact` deletes every row for the shop.
- `app/uninstalled` deletes sessions, stops the weekly email, clears queued work; reinstall works (sessions are upserted by the library).
- Every webhook verifies the HMAC and answers within the timeout; product webhooks work after answering.
- No secrets in the repository; `.env` ignored; the image excludes `.env`, the local database and dev certificates.
- Errors reach the merchant as red banners with plain sentences; no stack traces.
- Sentence-case headings, verbs on buttons, no exclamation marks or emoji, every input labelled, tables with header rows, loading states, one-heading empty states, layouts measured without horizontal overflow at 375 pixels.
- Plan-gated features are labelled and disabled, not merely hidden; every gate is enforced on the server.
- One primary action per page; breadcrumbs back to the parent page.

## Billing test flow (before submitting)

Run it once with `BILLING_TEST=false` in the development `.env` (then restart the dev server): that is the production setting, and a development store still gets test charges, so the run shows exactly what a reviewer sees.

1. On a development store, open Plans and choose Quick Clean: Shopify shows the approval screen for a test charge; approve; back on Plans the card reads "Current plan".
2. Open an issue page: inline edits, Trust word and Ignore appear. Quick apply a suggestion, then undo it from the row and from Recent fixes.
3. Choose Deep Clean: the subscription is replaced; Deep Clean areas unlock on Home.
4. The Early Bird card shows with its button disabled and the note that it is for paying stores: a development store cannot choose it and never takes a seat. The claim and lapse of a seat can only be seen on a live store with real billing.
5. Choose Dust Off: the subscription is canceled; Home shows the 20-product limit banner if the last scan was larger.
6. Decline a charge on the approval screen: Plans reloads with the previous plan and no error page.
7. Uninstall and reinstall: the app authenticates again and the previous data is still there until `shop/redact` arrives 48 hours later.

## Shopify self-review

Shopify publishes the requirements that can be checked from the code. Fetch the current list from the project root, never from memory, and check each one:

```bash
npx shopify doc fetch --url https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements
```

Result on 2026-09-23: 28 likely passing, none failing, 3 needing review. Two of the three were fixed that day: billing on development stores (1.2.2) and the store address form (2.3.1). The third, a valid TLS certificate (3.1.1), depends on the host. Ten groups were skipped: the app has no extensions, and four groups are opt-in categories that do not apply.

## Built for Shopify: not yet met

- Merchant utility prerequisites: 50 net installs on paid plans, five reviews and the minimum rating. Only time and merchants provide these.
- Web Vitals in the admin (LCP under 2.5 s, CLS under 0.1, INP under 200 ms at the 75th percentile, measured by Shopify after 100 page loads). The home page reads stored results without parsing findings, which helps; measure after launch.
- Contextual save bar: the weekly email form in Settings and the tracked metafield rows use their own Save buttons rather than the App Bridge save bar.
- Two banners can appear close together on Home (a notice plus the scan progress or a plan banner); the guidelines prefer one.
- Onboarding: the first-run page disappears after the first scan, which meets the "removable onboarding" rule; there is no setup guide beyond it.
