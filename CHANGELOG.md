# Changelog

Every version of TidyUp and what changed in it. The number is in `package.json`, shows on the Support page in the app and is tagged in git as `vX.Y.Z` (the README says how to cut one).

Versions follow [semantic versioning](https://semver.org): the first number changes when merchants would notice a break, the second when something new is added, the third for fixes only. Versions stay below 1.0.0 until the app is listed in the Shopify App Store; 1.0.0 is the listed app.

## Unreleased

### Changed

- Color is back on the home page, from the Polaris palette only: each area card has its own color again (stripe, wash and dot), every value a Polaris token; severity badges are red, orange and yellow, with low severity yellow instead of grey everywhere.
- The Potential problems and Problems fixed numbers are large again and take a color by state (red while something high is open, orange otherwise, green when there is nothing to fix or when fixes have been made).
- The trend is a bar graph of the last twelve scans again.

### Fixed

- Development stores always get test charges, the only kind they accept. In production, a development store (where Shopify reviews apps) could not subscribe to a paid plan, and its test subscription was ignored. Real stores are still charged for real.
- The Plans page said charges were test charges on every store, including real ones in production. It now says so only where it is true.
- Opening the app's address directly showed a form asking for a store address, which Shopify's review rules forbid. The page now says to open TidyUp from Apps in the Shopify admin or find it in the Shopify App Store. A link that names the store still goes straight to the install.

## 0.9.0 - 2026-09-23

The first named version: the app as it stands after the full audit, ready to be submitted to the App Store.

### What the app does at this version

- 66 checks over the whole catalog, in eleven areas, with a fixture-backed test for every one (`npm run test:rules`).
- Fixes in place, one click for a batch or one product at a time, every write logged and undoable.
- Plans: Dust Off (free), Quick Clean, Deep Clean, and the Early Bird offer; areas gated by plan on the server and in the pages.
- Tracked metafields (up to seven) with required and pattern checks, paused on a plan without them.
- Catalogs of any size: inline up to 250 products, a background bulk export above that.
- Weekly email, automatic rescan after product changes, clean streak.
- Webhooks for uninstall, scope changes, product changes, subscription changes and the privacy topics.

### Added

- Image alt text is written with `fileUpdate`; the app requests the `write_files` scope.
- The version shows on the Support page.
- The Support form asks what the message is about: a general question, a feature request or a bug report.

### Changed

- `@shopify/shopify-app-react-router` 3, Admin API 2026-10, Node 22.12 or newer.
- Polaris-only visuals: no custom colors, stripes or typography.
- Title casing suggestions recase only the letters of each word and know typographic apostrophes.
- Margins are judged in cents, so a price exactly on the 10% line is not thin.
- Bulk scans keep the tracked metafield list they started with.
- Variants that do not ship skip the weight check; stores without Online Store skip the visibility check; eight-digit barcodes are not judged; duplicate SKUs and barcodes are grouped without regard to case; videos count as media.

### Fixed

- 136 audit findings across correctness, GraphQL, writes and undo, plans, webhooks, data, errors, UI, copy, security, performance and repo hygiene (`AUDIT.md`).

## Before 0.9.0

Unnumbered work, by date, for the record.

- 2026-09-15: first scan with 15 checks, then 58; scans stored with history; bulk operations for large catalogs; settings with a switch per check.
- 2026-09-17: home and settings redesign; checks organized into families and presets.
- 2026-09-22: renamed to TidyUp; issue pages as routes with current values and quick apply; billing with plans and the Early Bird offer; support page; webhooks; weekly email and automatic rescan; ignored findings and dictionary pages; tracked metafields; the final list of 66 checks.
- 2026-09-23: full audit and its fixes; library and API upgrade; review of the decisions.
