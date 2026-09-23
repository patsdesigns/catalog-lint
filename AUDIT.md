# TidyUp audit

Date: 2026-09-23. Scope: every file in `app/`, `prisma/`, `shopify.app.toml`, `shopify.app.production.toml`, `package.json`, `CLAUDE.md`/`AGENTS.md`, `README.md`, `Dockerfile`, plus the installed `@shopify/shopify-app-react-router` 1.2.1 client code where the behaviour depends on it.

Method: one full read of every file, then seven independent review passes (one per group of sections) whose findings were verified against the code before being listed. GraphQL operations were validated with the Shopify Dev MCP validator against Admin API 2026-10 and 2026-07. Migrations were checked with `prisma migrate diff --from-migrations` (no difference from the schema). The dev database was measured: one 18-product test store holds 100 Scan rows and 7.9 MB of findings JSON (about 480 bytes per finding).

Legend: `[ ]` open, `[x]` fixed. Severity: high (wrong data, lost undo, outage, security), medium (wrong behaviour in a real case), low (polish, robustness, consistency). Line numbers refer to the code before Phase 2. Product decisions are not changed; they are listed under Questions at the end.

Totals: 136 items found; 21 fixed so far; 21 open questions.

## 1. Correctness of every check

Verified for all 66 rules: id, label, severity and area match the final list; every rule has a RULE_META family and a PASS_LABELS entry; none throws on products with no variants, no images, no description, null vendor, null category, null publications, no options or no metafields; catalog rules return nothing on 0 or 1 products. The new `test/rules.test.mjs` (item 1.24) proves it with 42 fixtures.

- [x] **1.1** medium — `app/lib/rules.server.js:336` — `vendor_repeated_in_title` matches the vendor as a substring, so vendor "Art" in "Party Art Cart" counts 3 and Quick apply offers "Party Art C". Fix: match on word boundaries with an escaped, normalized vendor and skip when a second whole-word hit is not found.
- [x] **1.2** medium — `app/lib/rules.server.js:463` — `missing_weight` suggests the donor variant's number but carries the empty variant's unit (the normalize default KILOGRAMS), so 500 GRAMS becomes 500 KILOGRAMS on Quick apply. Fix: convert the donor weight into the target unit and carry the donor unit.
- [ ] **1.3** medium — `app/lib/rules.server.js:942`, `app/lib/edits.server.js:69` — `weight_units_mixed` sets `unit` to the target unit while `raw` is the old number; undo restores the old number in the new unit. Fix: read the inventory item measurement before writing and log the real prior value and unit (see 3.2).
- [ ] **1.4** high — `app/lib/rules.server.js:419`, `app/lib/edits.server.js:83` — `missing_alt_text` sets `current` to "3 of 5 images without alt" and the alt edit logs `before: edit.current`, so undo writes that sentence as alt text on every image; `alt_is_filename`/`alt_too_long` log the first image's alt for all images. Fix: read every media alt before writing and log each image's real prior value (see 3.2).
- [x] **1.5** medium — `app/lib/rules.server.js:1084` — `summarizeFindings` takes `severity` and `label` from the stored finding, so scans stored before a severity change keep the old severity, weight and label until a full rescan, and an unknown severity makes the score NaN. Fix: take severity and label from the current rule and default an unknown weight to 0.
- [x] **1.6** medium — `app/lib/rules.server.js:758` — `vendor_casing` reports every product in a mixed group, including the ones already on the most common spelling (1000 "Nike" + 1 "nike" gives 1001 findings). Fix: report only products whose spelling differs from the canonical one, as `product_type_casing` and `tag_casing` do.
- [x] **1.7** medium — `app/lib/rules.server.js:564` — `draft_stale` measures from `createdAt`, so a product set to draft yesterday reads "Draft for 730 days". Fix: measure from `updatedAt` (a lower bound with no false positives).
- [x] **1.8** low — `app/lib/rules.server.js:758`, `:919` — `vendor_casing` and `product_type_casing` loop over every product once per mixed group (quadratic on big catalogs). Fix: one pass over products with a canonical-by-key map.
- [x] **1.9** low — `app/lib/rules.server.js:33` — `EMOJI_RE` misses U+2B50, U+203C, flags and U+231A-23FF. Fix: use `\p{Extended_Pictographic}` and `\p{Regional_Indicator}` (minus copyright, registered and trademark).
- [x] **1.10** low — `app/lib/rules.server.js:821` — `dead_link` only accepts a double-quoted `href`, so single-quoted links and named anchors count as dead. Fix: accept single, double and bare hrefs; ignore anchors with `name`/`id` and no href.
- [x] **1.11** low — `app/lib/rules.server.js:847`, `:835` — `alt_too_long` and `alt_is_filename` build one edit for all matching images with the first image's alt as the suggestion, so Quick apply writes the first image's text onto every image. Fix: carry per-image raw and suggested values and apply each image its own value.
- [x] **1.12** low — `app/lib/rules.server.js:273`, `:347` — a title made only of punctuation or emoji gets `suggested: ""` with `apply: true`, and Shopify rejects the empty title. Fix: `apply` only when the cleaned title is not empty.
- [x] **1.13** low — `app/lib/rules.server.js:35`, `:327` — `language_mismatch` flags English spec lists ("Material stainless steel. Weight 200g.") because they contain few stopwords. Fix: also require non-ASCII letters or two hits on a short list of common non-English words.
- [x] **1.14** low — `app/lib/rules.server.js:173` — `FILENAME_ALT_RE` has no end anchor on its prefix branch, so "Image 3 of the blue chair" is a filename. Fix: anchor the prefix branch.
- [x] **1.15** low — `app/lib/rules.server.js:544` — `price_outlier` with exactly two priced variants uses their mean as the median and flags the cheaper one with Quick apply to the mean. Fix: require three priced variants.
- [x] **1.16** low — `app/lib/spelling.server.js:68` — `ctx.customWords.has` throws when a caller passes a speller without `customWords`. Fix: default to an empty set.
- [x] **1.17** low — `app/lib/rules.server.js:1059`, `app/lib/scan.server.js:369` — `runProductRules` recomputes the catalog context from the few re-read products, so after a fix the recheck loses the common vendor, the price ending and the type-by-collection suggestions. Fix: store the catalog context with the scan (`Scan.context`) and pass it to rechecks.
- [x] **1.18** low — `app/lib/scan.server.js:121` — `normalize` passes `title` and `handle` through unchanged; rules call string methods on them. Fix: default both to "".
- [x] **1.19** low — `app/lib/scan.server.js:42` — the paged query reads `media(first: 5)` and drops non-image media, so a product whose first five media are videos scans as "No product image". Fix: read `media(first: 10)` (cost stays under the limit, see 2.6).
- [ ] **1.20** low — `app/lib/rules.server.js:586` — the "Continue selling" choice of `active_no_stock` lists the scanned variant ids, capped at 10 by the query. Fix: read every variant id at apply time (part of 3.1).
- [x] **1.21** low — `app/lib/rules.server.js:1016` — `metafield_pattern` compiles the merchant's regex once per product and tests the whole value. Fix: compile once per run and test at most 1,000 characters (see 10.2).
- [x] **1.22** low — `app/lib/rules.server.js:298` — the empty-tags regex misses `<p>&nbsp;</p>` and `<p class="x"></p>`, which the Shopify editor emits. Fix: allow attributes and `&nbsp;`.
- [x] **1.23** low — `app/lib/spelling.server.js:34` — raw URLs in descriptions are spell-checked, so every `https://` link yields a "Possible misspelling: https" finding. Fix: strip URLs from the text before checking.
- [x] **1.24** medium — no rule test exists. Fix: add `test/fixtures.mjs` (42 synthetic products: 36 that together trigger all 66 rules, 6 clean, 2 edge products) and `test/rules.test.mjs` run by `npm run test:rules`, asserting the catalog (66 rules with label, severity, area), the exact finding set per product, coverage of all 66, finding shape, summary counts, and that empty and single-product catalogs do not throw.

## 2. GraphQL

All 26 operations validate against 2026-10 and 2026-07 with no removed fields; `Product.images`, `productUpdate(input:)`, legacy `weight`/`weightUnit` and `productVariantUpdate` are not used. Two deprecations and one missing scope were found.

- [ ] **2.1** medium — `app/shopify.server.js:15`, `shopify.app.toml:37`, `shopify.app.production.toml:38` — Admin calls run at 2026-07 (`ApiVersion.July26`; the installed library has no `October26`) while webhooks are pinned to 2026-10, a release candidate until 2026-10-01. Fix: pin webhooks to `2026-07` so both match; move both together when the library is upgraded (see Questions).
- [ ] **2.2** medium — `shopify.app.toml:10`, `app/lib/scan.server.js:104` — `shopLocales` requires `read_locales`, which is not requested; the query fails on every scan, is swallowed, and every store is treated as English (so a French store gets "may not be in your store language" on every French description). Fix: add `read_locales` to both tomls and to `SCOPES` in the dev config.
- [ ] **2.3** low — `shopify.app.toml:10-34`, `shopify.app.production.toml:11-35` — `write_metaobject_definitions`, `write_metaobjects`, `[product.metafields.app.demo_info]` and `[metaobjects.app.example]` are template leftovers; nothing in `app/` uses metaobjects or `demo_info`. Fix: remove the two scopes and both sections from both tomls.
- [ ] **2.4** low — `app/lib/writes.server.js:45` — `productUpdateMedia` is deprecated in 2026-07 and 2026-10 ("Use fileUpdate instead"). Fix: use `fileUpdate(files: [{ id, alt }])`.
- [ ] **2.5** low — `app/lib/writes.server.js:79`, `:241` — `Publication.name` is deprecated ("Use Catalog.title"). Fix: select `catalog { title }` and match the Online Store on it.
- [ ] **2.6** medium — `app/lib/scan.server.js:16`, `app/lib/metafields.server.js:36` — cost of `byIdsQuery` is about 10 x (89 + N tracked metafields): 900 of the 1,000-point limit with one tracked metafield and over the limit from 11, and the number of tracked metafields is not capped, so rechecks, webhooks and bulk fixes would fail for a shop tracking 11 fields. Fix: read 5 ids per query and cap tracked metafields at 8 (with a message on the Tracked metafields page).
- [ ] **2.7** medium — `app/lib/scan.server.js:110`, `:222` — the inline scan fetches 32 pages back to back at about 720 requested points each; Shopify refuses a query when the requested cost exceeds the points available, so an inline scan of a 250-product store gets THROTTLED after a few pages and, with no retry, fails with "Throttled". Fix: a shared GraphQL helper that reads `extensions.cost.throttleStatus` after every response, waits until the bucket can take the next request, and retries THROTTLED and HTTP 429/503 with backoff (see 7.4).
- [ ] **2.8** medium — `app/lib/rescan.server.js:48` — any error while polling the bulk operation (including a throttled 1-point status query) or while downloading the finished export marks the job failed for good, although Shopify keeps the result for seven days. Fix: keep the job running on a poll error (fail only after 5 consecutive errors or a terminal status) and let the next page load retry a failed download.
- [ ] **2.9** low — `app/lib/jobs.server.js:5`, `app/lib/rescan.server.js:28` — a job that never leaves "running" (Shopify export lost, process died mid-finish) blocks Scan again forever. Fix: a job older than 24 hours is marked failed with "timed out", and a finish step older than 15 minutes is retried.
- [ ] **2.10** low — `app/lib/scan.server.js:210`, `:226`, `app/lib/metafields.server.js:92` — the cursor loops have no guard against `hasNextPage: true` with a null or unchanged cursor. Fix: stop when the cursor does not advance and after a page cap.
- [ ] **2.11** low — `app/routes/app.tracked.jsx:18` — `fetchDefinitions(...).catch(() => [])` hides every error, so the dropdown silently shows nothing. Fix: return an error flag and show a banner.
- [ ] **2.12** low — `app/lib/billing.server.js:34`, `app/lib/events.server.js:14` — when the plan lookup throws inside a product webhook, the handler logs and returns 200 and the product change is lost until the next full scan. Fix: queue the product in PendingProduct when the plan cannot be read.

## 3. Writes, fixes, edits, undo

Confirmed: every catalog write goes through `writes.server.js` (the only other mutation starts the bulk export); `revert` handles null compare-at, empty alt, tag arrays, weights with units, cost null, status, publication, available quantity, metafield delete and option value; the 100-mutation budget is applied per fixer; the bulk fixers re-read products before writing.

- [ ] **3.1** high — `app/routes/app.issues.$ruleId.jsx:91`, `app/lib/edits.server.js:26`, `app/lib/writes.server.js:186` — the edit descriptor posted by the browser is trusted as is: `setProductField` sets `product[field]` for any field name (handle, templateSuffix, giftCard, id), ids and arrays are unbounded, the plan and area gates key off the URL rather than the descriptor, and an unknown field crashes the FixLog insert after the write. Fix: the action takes only the finding key, the typed value and a choice index; the server looks the finding up in the stored scan and uses its own `edit` descriptor; fields are whitelisted per kind in `writes.server.js` anyway.
- [ ] **3.2** high — `app/lib/edits.server.js:54`, `:60`, `:69`, `:83`, `:97` — variant, policy, weight, alt and publish edits log a `before` value taken from the finding (scan-time, or a display string, or a literal `false`) instead of the live value, so undo restores stale or wrong data and a stale finding "fixes" a product that had already changed. Fix: read the variant, inventory item, media alts and publication state before writing; refuse a Quick apply when the live value no longer matches the finding.
- [ ] **3.3** medium — `app/lib/writes.server.js:97`, `app/lib/edits.server.js:99` — `readAvailable` uses `inventoryLevels(first: 1)`, an arbitrary location, while `negative_inventory` flags the summed quantity, so the edit can set a positive location to the typed value and leave the negative one. Fix: read all levels and set the negative ones, logging one entry per level.
- [ ] **3.4** medium — `app/lib/fixes.server.js:140`, `app/lib/writes.server.js:317` — undo writes `before` without checking that the field still holds `after` (save 10 then 20, undo the first, 20 is lost). Fix: re-read before reverting and skip with a message when the current value is not the logged `after`.
- [ ] **3.5** high — `app/lib/fixes.server.js:112`, `app/lib/edits.server.js:117` — FixLog rows are written only after the whole loop, so a throw mid-loop (a throttle on mutation 40) leaves 39 changes applied in Shopify with no log and no undo. Fix: persist each entry right after its mutation succeeds.
- [ ] **3.6** medium — `app/lib/edits.server.js:26`, `app/routes/app.issues.$ruleId.jsx:196` — no server-side validation: `Number("abc")` becomes NaN and clears the cost, negative or non-numeric prices and weights go straight to Shopify, status and inventory policy accept any string, empty titles are blocked only in the browser. Fix: validate per kind before any write (money, non-negative weight, integer quantity, enum values, non-empty title, metafield value by type) with plain error messages.
- [ ] **3.7** medium — `app/routes/app.issues.$ruleId.jsx:463`, `app/routes/app._index.jsx:836`, `app/lib/fixes.server.js:97` — a second click before React commits the busy state submits twice, and two tabs (or Fix all on Home while the issue page fix runs) both write and log two batches. Fix: ignore clicks while a submission is pending, serialize writes per shop on the server, and skip a write whose target already holds the value.
- [ ] **3.8** low — `app/lib/fixes.server.js:141` — undo of an entry whose product was deleted keeps the entry forever (Recent fixes keeps offering it, the count includes it). Fix: mark such entries undone with a note.
- [ ] **3.9** low — `app/lib/writes.server.js:161` — `readProduct` ignores errors and reports any failure as "Product not found". Fix: use the shared error-aware read.
- [ ] **3.10** low — `app/lib/edits.server.js:46` — the word replacement runs a case-sensitive `\b` regex over the raw HTML, so it can rewrite inside tags and URLs and misses the word when the casing differs. Fix: replace only in text nodes, case-insensitively, keeping the original casing.
- [ ] **3.11** low — `app/lib/edits.server.js:50` — replacing a word that is no longer there still writes and logs a no-op entry. Fix: refuse with "That word is no longer in the field".
- [ ] **3.12** low — `app/lib/fixes.server.js:21`, `app/lib/ui.jsx:69` — `skipped` mixes "changed since the scan" with "over the 100 budget" and the notice always says "no safe value to use". Fix: report the two counts separately and say "100 per run, run again for the rest".
- [ ] **3.13** low — `app/routes/app.fixes.$batchId.jsx:32` — `FIELD_LABELS` lacks status, inventoryPolicy, optionValue, publication, available and metafield, so those batches show raw field names. Fix: add the labels.
- [ ] **3.14** low — `app/lib/checks.server.js:38` — restoring an ignored check splices its findings back from the older row whenever `readAt` matches, so findings for products fixed since the ignore come back stale. Fix: splice only when nothing else was saved since the ignore; otherwise re-check.
- [ ] **3.15** low — `app/routes/app.issues.$ruleId.jsx:78`, `app/routes/app._index.jsx:96` — undo triggers a full catalog rescan even when no product changed. Fix: skip the refresh when `productIds` is empty.
- [ ] **3.16** low — `app/lib/fixes.server.js:107` — a bulk fix re-reads every flagged product before the budget applies (2,000 findings means 200 reads for 100 writes). Fix: read in batches and stop when the budget is spent.

## 4. Plans and gating

Confirmed: every gated feature (inline edits, dictionary, ignores, tracked metafields, weekly email, new-product scans) is refused in the action as well as hidden; the product limit is applied on every scan path (inline, bulk slice, pending queue, rechecks); Early Bird carries the Deep Clean areas and features everywhere and is matched by name in billing; cancel and uninstall lapse the claim. Export is "coming soon" and has no route.

- [ ] **4.1** medium — `app/lib/billing.server.js:14`, every loader and action — `currentPlan` has no error handling, so a transient billing failure throws before the route's own try/catch and the whole app becomes an error page. Fix: catch, fall back to Dust Off with a `planUnknown` flag, show a warning banner, and refuse scans and writes while the plan is unknown (a paid shop must not save a 20-product truncated scan by accident).
- [ ] **4.2** medium — `app/routes/app.plans.jsx:20` — the Early Bird seat is claimed only when the merchant returns to the Plans page, and an Early Bird to paid-plan change never lapses the claim without the webhook. Fix: claim and lapse from the home loader too, so the claim follows the live subscription.
- [ ] **4.3** medium — `app/routes/cron.digest.jsx:15`, `app/lib/digest.server.js:111` — the weekly email ignores the plan: a shop downgraded to Dust Off, or uninstalled, keeps getting it. Fix: skip shops with no session and shops whose current plan lacks the feature.
- [ ] **4.4** low — `app/routes/app.issues.$ruleId.jsx:52`, `app/routes/app._index.jsx:98` — in a locked area, `ignore` and `refresh` (and Home ignore/restore) are still accepted. Fix: refuse `ignore` and `refresh` for locked areas like `fix` and `edit`; the check switches stay ungated as in Settings.
- [ ] **4.5** low — `app/routes/app.ignored.jsx:20`, `app/routes/app.dictionary.jsx:15` — the loaders return every row to plans without the feature (the page shows only the upgrade notice). Fix: return empty lists when the feature is off.
- [ ] **4.6** low — `app/lib/rescan.server.js:122` — after a downgrade the stored scan keeps every product until Scan again. Fix: a banner on Home when the stored scan exceeds the plan limit.
- [ ] **4.7** low — `app/lib/billing.server.js:10` — `BILLING_TEST` is test only for the exact string "true"; "1" or "yes" silently means real charges. Fix: accept 1/true/yes case-insensitively and refuse any other non-empty value at startup.
- [ ] **4.8** low — `app/routes/app.plans.jsx:37` — with an active Early Bird subscription and a lapsed claim no card shows "Current plan". Fix: show the offer card when the current plan is Early Bird.
- [ ] **4.9** low — `app/lib/billing.server.js:63`, `prisma/schema.prisma:158` — nothing in the schema forbids a 51st claim; the transaction count is the only guard. Fix: a unique `seat` number assigned inside the transaction.

## 5. Webhooks and background work

Confirmed: every webhook route awaits `authenticate.webhook` (bad HMAC is a 401) before any work; handlers are idempotent at the database; products/create and products/update re-read only that product and run product rules only; the compliance route exists for all three topics and is registered in `shopify.app.production.toml` (the localhost dev config cannot register subscriptions); the cron route answers 503 without `CRON_SECRET` and 401 with a wrong one.

- [ ] **5.1** high — `app/routes/webhooks.compliance.jsx:13` — shop/redact leaves PendingProduct, DailySnapshot, DigestSettings, TrackedMetafield and EarlyBirdClaim rows for the shop. Fix: delete the first four; anonymize the claim (the seat count survives, the shop domain does not).
- [ ] **5.2** high — `app/routes/webhooks.app.uninstalled.jsx:12` — uninstall leaves the weekly email enabled and the queue and running job in place, so the digest keeps emailing the shop for up to 48 hours. Fix: turn the email off, clear pending products and fail the running job on uninstall.
- [ ] **5.3** medium — `app/lib/events.server.js:9` — products/create and products/update read the plan, re-read the product, run the rules and save before answering; on a large catalog that passes the 5-second webhook timeout and Shopify retries the work. Fix: answer 200 at once and run the work detached under the per-shop lock.
- [ ] **5.4** medium — `app/routes/cron.digest.jsx:11` — the secret comparison is not constant-time. Fix: `crypto.timingSafeEqual` with a length check.
- [ ] **5.5** low — `app/routes/webhooks.*.jsx` — the template "Received X webhook" logs are noise. Fix: log failures only.

## 6. Data and Prisma

Confirmed: the migrations apply from empty to exactly the current schema (`prisma migrate diff` reports no difference; `prisma migrate reset --force` is the non-interactive form); the Session model matches `@shopify/shopify-app-session-storage-prisma` 9; no loader runs per-row queries in a loop; `setup` runs `prisma migrate deploy`.

- [ ] **6.1** high — `app/lib/scans.server.js:7` — every save (scan, ignore, learn, edit, settings toggle, webhook) inserts a new Scan row with the full findings JSON and nothing ever deletes rows: the dev store already has 100 rows and 7.9 MB for 18 products; a 5,000-product store would add megabytes per click. Fix: prune to the last 20 rows and the last 12 full scans per shop after every save; cap stored findings at 5,000 per rule (counts stay exact, the issue page says "Showing the first 5,000 of N"); drop the duplicated description text from edit descriptors.
- [ ] **6.2** high — `app/routes/app._index.jsx:22` — the home loader parses the whole findings JSON on every load and every 3-second poll only to count open and high findings. Fix: derive both from the small per-rule summary and read the row without `findings`.
- [ ] **6.3** low — `prisma/schema.prisma:75` — FixLog is indexed on (shop, batchId) only; Recent fixes and the fixed counts filter on shop, undone and createdAt. Fix: add `@@index([shop, undone, createdAt])`.
- [ ] **6.4** low — `prisma/schema.prisma:16` — Session has no index on `shop`, which uninstall and the session storage query by. Fix: add `@@index([shop])`.
- [ ] **6.5** low — `prisma/schema.prisma:94` — `Setting.preset` defaults to "recommended" while the app default is "everything". Fix: align the schema default.
- [ ] **6.6** medium — `prisma/schema.prisma:13`, `.dockerignore` — the SQLite file path is fixed and `COPY . .` bakes a local `prisma/dev.sqlite` (with access tokens) and `.env` into the image. Fix: exclude `.env*`, `prisma/*.sqlite*` and `.shopify` from the image and document the volume for `prisma/`.
- [ ] **6.7** low — `app/lib/scan.server.js:372` — a recheck keeps catalog-rule findings for products Shopify no longer returns, so a deleted product stays on an issue page until the next full scan. Fix: drop findings of deleted products.
- [ ] **6.8** low — `app/lib/scans.server.js:67` — `toResult` parses every JSON column bare; one corrupt row takes down every page for that shop. Fix: parse with fallbacks and a `corrupt` flag.

## 7. Errors and edge cases

Confirmed: zero-product and one-product stores scan without throwing (score 100, no findings); every action on issue, home, plans and fixes pages has a try/catch that returns a banner; `shopTimeZone` and `countNewProducts` fall back quietly.

- [ ] **7.1** high — `app/routes/app.jsx:30` — the error boundary only handles Shopify responses and rethrows everything else, so any uncaught loader error shows React Router's default page (a stack trace in development) with the app layout gone. Fix: render the layout with an `s-banner` carrying a plain message for other errors and log the raw error on the server.
- [ ] **7.2** medium — `app/routes/app.settings.jsx:66`, `app/routes/app.tracked.jsx:48`, `app/routes/app.ignored.jsx:44`, `app/routes/app.dictionary.jsx:26`, `app/routes/app.support.jsx:34`, `app/routes/app.plans.jsx:24` — parts of these actions run outside any try (JSON parse, saves, refresh, cancel inside a catch), so a failure becomes the error page instead of a banner; banners also print raw Prisma and `[object Response]` messages. Fix: try/catch every action, map Prisma, JSON and thrown Response errors to plain sentences.
- [ ] **7.3** medium — `app/lib/rescan.server.js:56` — a finished bulk export is downloaded and scanned inside the home loader with no lock, so a second tab (or a webhook page load) processes it twice and saves two rows, and a 5,000-product scan can outrun the request timeout. Fix: claim the job atomically, mark it "finishing", run the download and rules detached, and let the loader only report status.
- [ ] **7.4** high — `app/lib/scan.server.js:110`, `app/lib/writes.server.js:3`, `app/lib/metafields.server.js:93`, `app/lib/billing.server.js:35` — no call retries a throttled response: the client throws `GraphqlQueryError` for a THROTTLED body and a `Response` for HTTP 429, the `errors` branches in the app are unreachable, and route banners show "[object Response]". Fix: one shared `app/lib/graphql.server.js` helper used by every call site: paces on `throttleStatus`, retries THROTTLED and 429/503 with backoff (3 attempts), passes `tries`, and returns plain error messages.
- [ ] **7.5** low — `app/lib/spelling.server.js:4` — a failed dictionary load is cached forever. Fix: clear the cached promise on failure.
- [ ] **7.6** medium — `app/lib/rules.server.js:89`, `app/lib/format.js:15`, `app/routes/app._index.jsx:179` — money values are printed without the store currency and every date and number is formatted en-US regardless of the store. Fix: read `shop { currencyCode ianaTimezone }` and the primary locale once per shop (cached), format money with the store currency in findings, and format dates, relative times and numbers with the store locale on the pages.
- [ ] **7.7** low — `app/routes/app._index.jsx:578` — a store with zero products shows "Your catalog is clean, no issues found across 0 products". Fix: a "No products yet" state.
- [ ] **7.8** low — `app/lib/billing.server.js:35` — `planForShop` never checks for missing data and silently yields Dust Off. Fix: throw when data is missing (the webhook then queues the product, see 2.12).

## 8. UI and Polaris

Confirmed: every page uses Polaris web components; every input has a label (visible or exclusive); every table has a header row; the five tables use the `loading` attribute; no exclamation marks or emoji; every external link says it opens in a new tab; every banner tone and icon name is valid.

- [ ] **8.1** high — `app/routes/app._index.jsx:450`, `:637` — `s-badge size="small"` is not a valid value (base, large, large-100). Fix: drop `size`.
- [ ] **8.2** high — `app/routes/app.settings.jsx:291`, `app/routes/app.support.jsx:90` — `s-text-field type="email"` is not a prop. Fix: `s-email-field`.
- [ ] **8.3** medium — `app/routes/app._index.jsx:401` — the overview row has `clickDelegate` and two buttons, so a click on Ignore can also open the issue page. Fix: remove `clickDelegate` (the row keeps its link and Review button).
- [ ] **8.4** medium — `app/routes/app.issues.$ruleId.jsx:411` — row keys include the array index, so filtering remounts rows and drops typed corrections. Fix: key on product, variant, word and field only.
- [ ] **8.5** medium — `app/routes/app.issues.$ruleId.jsx:490`, `app/routes/app._index.jsx:553`, `app/routes/app.plans.jsx:110`, `app/routes/app.settings.jsx:177`, `:231`, `:296`, `app/routes/app.tracked.jsx:82` — the bulk fix, Fix all, Choose plan, Save vendors, Send test email, and tracked Save/Remove/Add buttons give no loading feedback, and the check switches save silently. Fix: `loading` on the pressed button and a "Saved." line after the switches, vendors and tracked saves.
- [ ] **8.6** medium — `app/routes/app._index.jsx:135` — the overview tables carry fixed grid tracks adding up to about 840px, so between ~1000px and the list breakpoint the table scrolls sideways inside the card. Fix: responsive tracks (fixed widths only above 900px of container width).
- [ ] **8.7** medium — `app/routes/app.issues.$ruleId.jsx:121`, `:257` — the Fix cell is a 160px input plus one `auto` track per button (about 480px), which overflows a phone-width list item. Fix: a full-width track below 600px with the buttons wrapping under the field.
- [ ] **8.8** low — `app/routes/app.dictionary.jsx:86` — `onKeyDown` on `s-text-field` is outside the component API. Fix: a form with a submit button.
- [ ] **8.9** low — `app/routes/app._index.jsx:396`, `:544`, `:562` — `s-link` with `onClick` and no `href` is not a real link (no URL, no new tab). Fix: `href` to the issue page.
- [ ] **8.10** low — `app/routes/app._index.jsx:269` — trend bars keyed by index. Fix: key by scan time.
- [ ] **8.11** low — `app/routes/app.tracked.jsx:114`, `app/routes/app.dictionary.jsx:54`, `app/routes/app.ignored.jsx:70` — the no-plan pages repeat the page heading as the section heading. Fix: "Not included in your plan".
- [ ] **8.12** low — `app/routes/app.fixes._index.jsx:72` — the empty state is two sentences. Fix: "No fixes yet."
- [ ] **8.13** low — `app/routes/app.issues.$ruleId.jsx:478`, `app/routes/app.fixes._index.jsx:55`, `app/routes/app.fixes.$batchId.jsx:82` — "Back to issues" is not a verb and duplicates the breadcrumb. Fix: keep the breadcrumb and the link under the list only.
- [ ] **8.14** medium — `app/routes/app.settings.jsx:217`, `:237`, `:249`, `:269`, `:281`, `:285`, `app/routes/app.tracked.jsx:112`, `app/routes/app.ignored.jsx:68`, `app/routes/app.fixes._index.jsx:53`, `app/routes/app.support.jsx:86`, `app/routes/app._index.jsx:603` — headings and chips in Title Case ("Approved Vendors", "Tracked Metafields", "Ignored Findings", "Weekly Email", "Recent Fixes", "Contact Support", "All Areas"). Fix: sentence case.
- [ ] **8.15** medium — `app/lib/checkGroups.js:20-32`, `app/lib/categories.js:5-14` — family and area labels in Title Case with ampersands ("SKUs & Barcodes", "Product Organization", "Search Engine Listing"). Fix: sentence case with "and" ("SKUs and barcodes", "Product organization", "Search engine listing").
- [ ] **8.16** medium — `app/routes/app._index.jsx:793`, `:851`, `:865`, `app/routes/app.issues.$ruleId.jsx:338`, `app/routes/app.support.jsx:100` — buttons in Title Case ("Run Full Scan", "Scan Again", "Scan New Products", "View Product", "Send Message"). Fix: sentence case.
- [ ] **8.17** low — `app/lib/rules.server.js:585`, `app/routes/app.support.jsx:10`, `:89` — "Set to Draft" beside "Set active"; support options and labels in Title Case. Fix: "Set to draft", "Set to active", "General question", "Your name".
- [ ] **8.18** low — `app/routes/app._index.jsx:161`, `:163` — the trend bar color and the passed-checks tint are custom hex/rgba colors. Fix: bars use `currentColor` inside subdued text; the panel uses `s-box background="subdued"`.

## 9. Copy

- [ ] **9.1** high — `app/lib/ui.jsx:82` — "1 changes reverted". Fix: pluralize.
- [ ] **9.2** medium — `app/routes/app.plans.jsx:26`, `:150` — "cancelled" (British). Fix: "canceled".
- [ ] **9.3** medium — `app/lib/rules.server.js:485`, `:488`, `app/routes/app.fixes.$batchId.jsx:35` — compare-at is written three ways. Fix: "compare-at price" everywhere.
- [ ] **9.4** medium — `app/lib/format.js:41` — "3 min ago", "2 h ago", "5 d ago". Fix: spelled-out units.
- [ ] **9.5** medium — `app/lib/checkLabels.js:9`, `:10`, `:11`, `:19`, `:44`, `:55`, `:57`, `:64`, `:82`, `:87`, `app/lib/ui.jsx:22` — ten "No X" pass labels read as non-sentences after "Passes when" ("Passes when no misspellings found."). Fix: reword them as clauses ("There are no misspellings").
- [ ] **9.6** medium — `app/routes/app.plans.jsx:92`, `:132`, `:156` — "$10 / month" beside "billed every 30 days". Fix: say both once: "$10 every 30 days".
- [ ] **9.7** medium — `app/routes/app.plans.jsx:99` — "fix-all buttons" but the button is "Fix all". Fix: "Full scans, Fix all and undo".
- [ ] **9.8** medium — `app/routes/app.issues.$ruleId.jsx:368` — "part of the Quick Clean plan" while every other gate says "plan and up". Fix: "plan and up".
- [ ] **9.9** low — `app/lib/checkLabels.js:68`, `:16`, `:18` — "Every product is in a collection" (rule checks active products), "under 2,000 words" (rule allows 2,000), "aren't" (only contraction). Fix: "Every active product...", "2,000 words or fewer", "are not".
- [ ] **9.10** low — `app/lib/format.js:9`, `app/routes/app.support.jsx:97`, `:90`, `app/routes/app.dictionary.jsx:83`, `app/routes/app.tracked.jsx:165` — "..." versus "…", "Please describe...", "your@email.com" versus "you@example.com", "e.g." versus "for example", "Settings, Custom data, Products". Fix: one form each.
- [ ] **9.11** low — `app/lib/ui.jsx:117`, `app/routes/app._index.jsx:331`, `:531` — "the product limit of your plan is reached", "high severity problems", a missing period. Fix: reword.
- [ ] **9.12** low — `app/routes/app.settings.jsx:285`, `app/lib/plans.js:84`, `app/lib/digest.server.js:57`, `:78` — "Weekly Email", "Weekly email digest", "weekly digest". Fix: "Weekly email" everywhere.
- [ ] **9.13** low — `app/lib/ui.jsx:8`, `app/lib/fixes.server.js:216` — the short fix names exist in two files. Fix: one map in `checkLabels.js`.
- [ ] **9.14** low — `README.md:50` — the layout list omits the Tracked metafields and Ignored findings pages. Fix: list them.

## 10. Security

Confirmed: no secrets in tracked files; `.env` is gitignored and untracked; every `/app` route calls `authenticate.admin` in loader and action; no route reads a shop from the client; every by-id write is scoped by `session.shop`; the dev simulate route is a 404 in production; no stack trace reaches a response.

- [ ] **10.1** high — see 3.1 — the client-supplied edit descriptor is trusted. Fix: resolve the descriptor server-side from the stored finding and whitelist fields per kind.
- [ ] **10.2** high — `app/lib/metafields.server.js:54`, `app/lib/rules.server.js:1016` — merchant regex patterns are only syntax-checked: no length cap, no rejection of nested quantifiers, no timeout, compiled per product and run on unbounded values in the shared process. Fix: cap the pattern at 200 characters, reject nested quantifiers and backreferences, probe the pattern in a worker with a 200 ms timeout at save time, compile once per scan and test at most 1,000 characters.
- [ ] **10.3** medium — `app/routes/app.settings.jsx:66` — `disabledRules` is parsed outside any try and any JSON shape is stored. Fix: parse safely, require an array of known rule ids.
- [ ] **10.4** low — `app/routes/app.issues.$ruleId.jsx:86` — the `finding` JSON feeds the ignore key and the Ignore row unbounded. Fix: validate the shape (known rule id, gid product id, capped strings) and store the server's copy of the finding.
- [ ] **10.5** low — `app/routes/app.support.jsx:22` — no length caps and no rate limit on the support form. Fix: caps (100/254/200/5,000) and at most 10 messages per shop per hour.
- [ ] **10.6** low — `app/routes/app.settings.jsx:40` — "Send test email" is unlimited, so the app can be used to mail third parties. Fix: at most 3 test emails per shop per hour.
- [ ] **10.7** low — `.dockerignore` — see 6.6 (local `.env`, SQLite file and `.shopify/` can end up in the image). Fix: exclude them.
- [ ] **10.8** low — `app/routes/app.support.jsx:54` — the failed forward logs the error object, which can contain the webhook URL. Fix: log the message only.

## 11. Performance

Confirmed: rules run in one pass per product over the enabled product rules; the dictionary loads once per process and unknown words are cached per scan; the overview reads stored rows and makes one GraphQL call (a product count) per load, plus one status poll while a bulk job runs. A 1,000-product store uses the bulk path (Shopify exports in the background; the app downloads once), so the inline path only matters up to 250 products, where the risk is throttling (2.7), not time.

- [ ] **11.1** low — see 1.8 — quadratic casing rules. Fix: single pass.
- [ ] **11.2** low — `app/lib/rules.server.js:241`, `app/lib/spelling.server.js:54` — suggestions are computed for every unknown word before the 8-per-product cut. Fix: stop at 8.
- [ ] **11.3** low — see 3.15 and 3.16 — needless full rescan on an empty undo; bulk fix reads before the budget.
- [ ] **11.4** low — `app/lib/billing.server.js:14` — `billing.check` runs on every loader and action of every page. Fix: cache the plan per shop for 60 seconds, bypassed on the Plans page and cleared by the Plans action and the subscription webhook.
- [ ] **11.5** low — `app/lib/rules.server.js:657` — `closest` recomputes the edit distance for every off-list product. Fix: memoize per vendor string within a run.

## 12. Repo hygiene

Confirmed: no `app.additional.jsx`, no demo product generation, no unused imports (lint is clean), `typecheck` passes, `.DS_Store` files are ignored (two untracked ones were on disk).

- [ ] **12.1** medium — `Dockerfile:10` — `npm ci --omit=dev` then `npm run build`, but `vite` is a devDependency, so the image build fails. Fix: install everything, build, then prune dev dependencies.
- [ ] **12.2** low — `CHANGELOG.md` — the template's own changelog. Fix: delete.
- [ ] **12.3** low — `extensions/.gitkeep`, `pnpm-workspace.yaml`, `package.json` `workspaces` — an empty extensions workspace. Fix: remove.
- [ ] **12.4** low — `app/.DS_Store`, `app/routes/.DS_Store` — on disk, untracked. Fix: delete.
- [ ] **12.5** low — see 5.5 and 9.13 — console noise and the duplicated label map.
- [ ] **12.6** low — `app/lib/scan.server.js:285` — the `Metafield` branch in the bulk parser is dead (tracked metafields arrive inline). Fix: remove.
- [ ] **12.7** medium — `package.json` — no `test:rules` script and no test folder. Fix: `test/` with the fixtures, the test and a small loader hook for extensionless imports; `npm run test:rules`.
- [ ] **12.8** medium — `README.md`, `AGENTS.md`, `CLAUDE.md` — the README lists only some webhooks, has no test section and no data volume note; AGENTS.md (which CLAUDE.md includes) is the template's two lines and says nothing about the app. Fix: describe what the app does, the plans and areas, how to run, test and deploy.

## 13. App Store readiness checklist

- [ ] **13.1** — Fix: add `STORE_CHECKLIST.md` with what is done and what is still needed: listing name "TidyUp: Product Data Cleanup", privacy policy URL, support email, screenshots, mandatory webhooks, billing test flow, and the Built for Shopify requirements not yet met.

## Questions

Product decisions found during the audit; nothing below was changed.

1. **API version.** The client library (1.2.1) tops out at Admin API 2026-07; the current release is 3.0.0. Upgrade now (bigger change, may need code updates) or stay on 2026-07 until 2026-10 is stable?
2. **Tracked metafield cap.** Eight tracked metafields keeps every query under the cost limit. Is eight enough, and should it differ by plan?
3. **Downgrades.** After a downgrade, ignores, dictionary words and tracked metafields still shape the scan (tracked metafields are also still fetched). Suspend them until the plan returns, or leave as is?
4. **Frozen subscriptions.** Should a FROZEN Early Bird subscription lapse the seat, or keep it until CANCELLED or EXPIRED?
5. **Redact and the seat.** shop/redact now anonymizes the Early Bird claim so the seat stays counted and the store cannot claim twice; delete it instead?
6. **missing_weight** fires for products that do not require shipping (digital goods, gift cards). Exclude them by reading `requiresShipping`?
7. **not_published** (high) flags every active product in a store that has no Online Store channel (headless, POS-only). Skip the rule when there is no Online Store publication?
8. **seo_title_missing.** Shopify defaults the page title to the product title when the SEO title is empty. Keep it as a medium check?
9. **price_below_cost** suggests the cost rounded to the common ending, which lands at the cost itself when the cost already has that ending and then trips `thin_margin`. Suggest cost plus the minimum margin instead?
10. **title_casing_outlier** one-click apply lowercases everything after the first letter ("USB-C Cable" becomes "Usb-c cable"). Keep Quick apply on this rule?
11. **duplicate_sku / duplicate_barcode** compare case-sensitively ("abc-1" and "ABC-1" are distinct). Intended?
12. **barcode_invalid** treats any 8-digit numeric barcode as a GTIN-8, so internal 8-digit codes fail. Acceptable?
13. **few_images** counts images only; a product with one image and one video reads "Only one image". Intended?
14. **Section colors.** The eleven area colors, the stripe and wash on each card, and the colored dots are custom colors outside Polaris. They were requested and are kept as a deliberate exception; reduce to the stripe only?
15. **The 32px summary figures** are custom typography (Polaris App Home has no display-size text). Keep, or use `s-heading`?
16. **Welcome page** is an onboarding section (heading, paragraph, button, three blurbs) rather than a one-line empty state. Keep as designed?
17. **"TidyUp: Product Data Cleanup"** as the home page heading is kept as the product name. The admin nav name in the tomls stays "TidyUp" (a longer name truncates in the nav, a Built for Shopify rejection reason).
18. **SYNC_LIMIT.** Inline scans now pace themselves on the rate limit; keep 250, or lower it so more stores use the bulk path?
19. **Scan retention.** Twenty rows and twelve full scans per shop are kept. Enough for the trend and for undo?
20. **Stuck bulk jobs** time out after 24 hours. Very large exports can legitimately run for hours; is 24 hours right?
21. **`app/lib/stats.server.js`** (owner-only numbers, used by a script outside the repo) is unused by the app. Keep or remove?
