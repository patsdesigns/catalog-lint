// Reading the catalog and running the rules over it.
//
// Catalogs up to SYNC_LIMIT products are read with regular paginated queries inside the request.
// Larger catalogs go through a Shopify bulk operation: Shopify exports every product to a JSONL
// file in the background, the page loader polls it (rescan.server.js) and the rules run once the
// file is ready, so a 50k-product catalog scans without request timeouts or API rate limits.

import { runRules, runProductRules, catalogContext, CATALOG_RULE_IDS, summarize, summarizeFindings, knownFindings, capFindings } from "./rules.server";
import { loadSpeller, seedWords, catalogNames } from "./spelling.server";
import { getWords } from "./dictionary.server";
import { getIgnoreKeys, ignoreKey } from "./ignores.server";
import { getSettings } from "./settings.server";
import { shopInfo } from "./shop.server";
import { request } from "./graphql.server";

export const SYNC_LIMIT = Number(process.env.CATALOG_LINT_SYNC_LIMIT ?? 250);
const PAGE_SIZE = 8; // keeps one paginated query under the Admin API cost limit
const IDS_PER_QUERY = 5; // by-id reads stay under the limit with every tracked metafield the app allows
// A paged read stops after this many pages whatever Shopify says: the inline path is only used up
// to SYNC_LIMIT products, and a cursor that never advances must not loop forever.
const MAX_PAGES = Math.ceil(SYNC_LIMIT / PAGE_SIZE) + 1;

// One product's fields, shared by the paginated, by-id and bulk queries. Regular queries page
// their connections; a bulk query takes no pagination arguments and returns every node, each on
// its own JSONL line tagged with __parentId and __typename.
// The tracked metafields, each by namespace and key under an alias, so a value comes back inline
// with the product (no connection, no pagination), or null when the product has none.
function trackedFields(tracked) {
  return tracked.map((t, i) => `tf_${i}: metafield(namespace: ${JSON.stringify(t.namespace)}, key: ${JSON.stringify(t.key)}) { type value }`).join("\n    ");
}

function productFields(paged, tracked = []) {
  const arg = (n) => (paged ? `(first: ${n})` : "");
  const conn = (body) => (paged ? `{ nodes { ${body} } }` : `{ edges { node { __typename ${body} } } }`);
  return `
    __typename
    id title handle status createdAt updatedAt publishedAt totalInventory vendor productType tags descriptionHtml
    variantsCount { count }
    seo { title description }
    options { id name optionValues { id name } }
    category { id name fullName isLeaf level }
    feedback { details { app { title } messages { message } state } }
    resourcePublicationsCount { count }
    availablePublicationsCount { count }
    collections${arg(1)} ${conn("id")}
    ${trackedFields(tracked)}
    media${arg(10)} ${conn("... on MediaImage { id alt image { width height } }")}
    variants${arg(10)} ${conn(`
      id title sku barcode price compareAtPrice inventoryPolicy inventoryQuantity updatedAt
      inventoryItem { id tracked locationsCount { count } unitCost { amount } measurement { weight { value unit } } }
    `)}
  `;
}

const catalogQuery = (tracked) => `#graphql
  query CatalogScan($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${productFields(true, tracked)} }
    }
  }
`;

const byIdsQuery = (tracked) => `#graphql
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { ${productFields(true, tracked)} } }
  }
`;

// Four connections (products + three nested), two levels deep: within the bulk query limits.
export const bulkQuery = (tracked) => `{ products { edges { node { ${productFields(false, tracked)} } } } }`;

const COUNT_QUERY = `#graphql
  query ProductsCount($query: String) { productsCount(query: $query) { count } }
`;

// Ids of the products created at or after a time, oldest first, for scanning what was added since
// the catalog was last read.
const NEW_IDS_QUERY = `#graphql
  query NewProductIds($cursor: String, $query: String) {
    products(first: 250, after: $cursor, query: $query, sortKey: CREATED_AT) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const START_BULK = `#graphql
  mutation StartBulkScan($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

const BULK_STATUS = `#graphql
  query BulkScanStatus($id: ID!) {
    bulkOperation(id: $id) { id status errorCode objectCount rootObjectCount url partialDataUrl }
  }
`;

const RUNNING_BULK = `#graphql
  query RunningBulkQueries {
    bulkOperations(first: 5, query: "operation_type:query") { nodes { id status query } }
  }
`;

const CANCEL_BULK = `#graphql
  mutation CancelBulkScan($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

// Every read here goes through the shared helper: paced on the cost bucket, retried on throttling.
const graphqlJson = (graphql, query, variables) => request(graphql, query, variables);

// True when a connection has a next page the loop has not seen (a cursor that does not move would
// otherwise loop forever).
function nextPage(pageInfo, cursor) {
  return Boolean(pageInfo?.hasNextPage && pageInfo.endCursor && pageInfo.endCursor !== cursor);
}

export function normalize(node, tracked = []) {
  return {
    id: node.id,
    title: node.title ?? "",
    handle: node.handle ?? "",
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    publishedAt: node.publishedAt,
    totalInventory: node.totalInventory ?? 0,
    variantsCount: node.variantsCount?.count ?? 0,
    collectionCount: (node.collections?.nodes || []).length,
    collectionIds: (node.collections?.nodes || []).map((c) => c.id).filter(Boolean),
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags || [],
    descriptionHtml: node.descriptionHtml,
    seoTitle: node.seo?.title || "",
    seoDescription: node.seo?.description || "",
    // Shopify's standard product taxonomy category, if one is set.
    category: node.category
      ? { id: node.category.id, name: node.category.name, fullName: node.category.fullName, isLeaf: Boolean(node.category.isLeaf), level: node.category.level ?? 0 }
      : null,
    // Sales channels: how many the product is published to, how many of those are error-free, and
    // any feedback a channel (Google, Meta, ...) says the merchant must act on.
    publications: node.resourcePublicationsCount?.count ?? null,
    publicationsOk: node.availablePublicationsCount?.count ?? null,
    channelIssues: (node.feedback?.details || [])
      .filter((d) => d.state === "REQUIRES_ACTION")
      .map((d) => ({ app: d.app?.title || "A sales channel", messages: (d.messages || []).map((m) => m.message).filter(Boolean) })),
    options: (node.options || []).map((o) => ({
      id: o.id,
      name: o.name,
      values: (o.optionValues || []).map((v) => v.name),
      valueIds: (o.optionValues || []).map((v) => v.id),
    })),
    // The tracked metafields, in order, with an empty value where the product has none.
    metafields: tracked.map((t, i) => ({
      key: t.fullKey,
      name: t.name,
      type: node[`tf_${i}`]?.type || t.type,
      value: node[`tf_${i}`]?.value ?? "",
    })),
    images: (node.media?.nodes || [])
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, alt: m.alt, width: m.image?.width, height: m.image?.height })),
    variants: (node.variants?.nodes || []).map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryPolicy: v.inventoryPolicy,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      updatedAt: v.updatedAt,
      locations: v.inventoryItem?.locationsCount?.count ?? 0,
      tracked: Boolean(v.inventoryItem?.tracked),
      cost: v.inventoryItem?.unitCost?.amount ?? null,
      inventoryItemId: v.inventoryItem?.id,
      weight: v.inventoryItem?.measurement?.weight?.value ?? 0,
      weightUnit: v.inventoryItem?.measurement?.weight?.unit || "KILOGRAMS",
    })),
  };
}

// The store's product count, or the count matching a product search query such as
// created_at:>='2026-09-22T18:00:00Z'.
export async function countProducts(graphql, query = null) {
  const data = await graphqlJson(graphql, COUNT_QUERY, { query });
  return data.productsCount?.count ?? 0;
}

// A product search clause for everything created at or after an ISO time (to the second).
export function createdSince(iso) {
  return `created_at:>='${String(iso).slice(0, 19)}Z'`;
}

// Ids of products created at or after `since`, capped so one call never pulls a whole catalog.
export async function fetchNewProductIds(graphql, since, cap = 2000) {
  const ids = [];
  let cursor = null;
  const query = createdSince(since);
  for (;;) {
    const data = await graphqlJson(graphql, NEW_IDS_QUERY, { cursor, query });
    const conn = data.products;
    ids.push(...conn.nodes.map((n) => n.id));
    if (ids.length >= cap || !nextPage(conn.pageInfo, cursor)) break;
    cursor = conn.pageInfo.endCursor;
  }
  return ids.slice(0, cap);
}

// Every product, page by page, or only the first `limit` of them (the plan's product limit).
// Only used for catalogs up to SYNC_LIMIT (see rescan.server.js).
export async function fetchCatalog(graphql, limit = null, tracked = []) {
  const products = [];
  let cursor = null;
  const query = catalogQuery(tracked);
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphqlJson(graphql, query, { cursor });
    const conn = data.products;
    products.push(...conn.nodes.map((n) => normalize(n, tracked)));
    if (limit && products.length >= limit) return products.slice(0, limit);
    if (!nextPage(conn.pageInfo, cursor)) break;
    cursor = conn.pageInfo.endCursor;
  }
  return products;
}

// The given products only, in small batches. Products that no longer exist are left out.
export async function fetchProductsByIds(graphql, ids, tracked = []) {
  const products = [];
  const query = byIdsQuery(tracked);
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const data = await graphqlJson(graphql, query, { ids: ids.slice(i, i + IDS_PER_QUERY) });
    for (const node of data.nodes || []) if (node?.id) products.push(normalize(node, tracked));
  }
  return products;
}

// ---------- bulk operations ----------

async function runningBulkQuery(graphql) {
  const data = await graphqlJson(graphql, RUNNING_BULK);
  return (data.bulkOperations?.nodes || []).find((op) => op.status === "RUNNING" || op.status === "CREATED") || null;
}

// Starts Shopify's export of the whole catalog and returns the bulk operation id.
export async function startBulkScan(graphql, tracked = []) {
  const query = bulkQuery(tracked);
  const data = await graphqlJson(graphql, START_BULK, { query });
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (bulkOperation?.id) return bulkOperation.id;
  // Shopify runs one bulk query per app per shop. If ours is still going (say, the page was
  // closed mid-scan), pick it up rather than failing.
  const running = await runningBulkQuery(graphql);
  const squash = (s) => (s || "").replace(/\s+/g, "");
  if (running && squash(running.query) === squash(query)) return running.id;
  throw new Error(userErrors.map((e) => e.message).join("; ") || "Shopify did not start the catalog export");
}

export async function bulkScanStatus(graphql, id) {
  const data = await graphqlJson(graphql, BULK_STATUS, { id });
  return data.bulkOperation;
}

// Stops an export the app no longer waits for (a job that timed out).
export async function cancelBulkScan(graphql, id) {
  const data = await graphqlJson(graphql, CANCEL_BULK, { id });
  const errors = data.bulkOperationCancel?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

// Streams the finished JSONL export and rebuilds one object per product. Child nodes (variants,
// media, collections) arrive as their own lines pointing at the product via __parentId; the
// tracked metafields come inline with the product (they are aliased fields, not a connection).
export async function downloadBulkCatalog(url, tracked = []) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the catalog export (${response.status})`);
  const products = new Map();
  const orphans = [];
  const attach = (child) => {
    const parent = products.get(child.__parentId);
    if (!parent) return false;
    if (child.__typename === "ProductVariant") parent.variants.nodes.push(child);
    else if (child.__typename === "Collection") parent.collections.nodes.push(child);
    else parent.media.nodes.push(child); // MediaImage, Video, Model3d, ExternalVideo
    return true;
  };
  const handle = (line) => {
    if (!line.trim()) return;
    const obj = JSON.parse(line);
    if (obj.__parentId) {
      if (!attach(obj)) orphans.push(obj);
    } else {
      products.set(obj.id, { ...obj, variants: { nodes: [] }, media: { nodes: [] }, collections: { nodes: [] } });
    }
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  handle(buffer);
  for (const child of orphans) attach(child);
  return [...products.values()].map((p) => normalize(p, tracked));
}

// ---------- running the rules ----------

async function scanContext(graphql, shop) {
  const [speller, storeWords, ignored, settings, info] = await Promise.all([
    loadSpeller(),
    shop ? getWords(shop) : [],
    shop ? getIgnoreKeys(shop) : new Set(),
    shop ? getSettings(shop) : { vendorWhitelist: [], trackedMetafields: [] },
    shopInfo(graphql, shop),
  ]);
  // The store language decides which language checks apply; the currency reads the prices.
  return { speller, storeWords, ignored, settings, locale: info.locale, currency: info.currency };
}

// Runs every rule over an already-read catalog and builds the stored scan result. catalogTotal is
// how many products the store has when a plan limit left some unscanned.
export async function scanProducts(products, graphql, shop, startedAt = Date.now(), catalogTotal = products.length) {
  const { speller, storeWords, ignored, settings, locale, currency } = await scanContext(graphql, shop);
  const names = catalogNames(products, speller);
  // What the catalog as a whole suggests, stored with the scan so rechecks suggest the same.
  const catalog = catalogContext(products);
  const ctx = { speller, customWords: seedWords(products, storeWords), nameWords: new Set(names), settings, locale, currency, catalog };
  const all = runRules(products, ctx);
  const findings = all.filter((f) => !ignored.has(ignoreKey(f)));
  // Counts come from every finding; the stored list is capped per check.
  const summary = summarize(products, findings, settings);
  return {
    ...summary,
    findings: capFindings(findings),
    names,
    context: catalog,
    full: true,
    catalogTotal: Math.max(catalogTotal, products.length),
    truncated: catalogTotal > products.length,
    readAt: new Date(startedAt).toISOString(),
    productIds: products.map((p) => p.id),
    ignoredCount: all.length - findings.length,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

// A full scan of a small catalog, or of its first `limit` products when the plan allows fewer than
// the store has. The count is read first so the result can say how many were left out.
export async function scanCatalog(graphql, shop, limit = null) {
  const started = Date.now();
  const count = await countProducts(graphql);
  const tracked = shop ? (await getSettings(shop)).trackedMetafields || [] : [];
  const products = await fetchCatalog(graphql, limit, tracked);
  return scanProducts(products, graphql, shop, started, count);
}

// Re-reads only the given products and re-runs the product rules on them, splicing the results
// into the latest scan. Catalog-wide rules keep their findings for these products, except the rule
// the merchant just acted on (dropRuleId), which the action has resolved for them.
export async function recheckProducts(graphql, shop, latest, ids, dropRuleId = null) {
  const started = Date.now();
  const { speller, storeWords, ignored, settings, locale, currency } = await scanContext(graphql, shop);
  const products = await fetchProductsByIds(graphql, ids, settings.trackedMetafields || []);
  const names = latest.names || [];
  const ctx = { speller, customWords: seedWords(products, storeWords), nameWords: new Set(names), settings, locale, currency, catalog: latest.context || undefined };
  const fresh = runProductRules(products, ctx).filter((f) => !ignored.has(ignoreKey(f)));
  const touched = new Set(ids);
  // Products the scan covers: an id it did not know is an addition (a webhook, a queued product),
  // an id it knew that Shopify no longer returns is a deletion. Scans saved before ids were recorded
  // treat every id as known.
  const known = latest.productIds?.length ? new Set(latest.productIds) : null;
  const fetched = new Set(products.map((p) => p.id));
  const deleted = ids.filter((id) => (known ? known.has(id) : true) && !fetched.has(id));
  const added = known ? products.filter((p) => !known.has(p.id)).map((p) => p.id) : [];
  const gone = new Set(deleted);
  // A deleted product keeps nothing, not even its catalog-wide findings.
  const kept = knownFindings(latest.findings).filter(
    (f) => !gone.has(f.productId) && (!touched.has(f.productId) || (CATALOG_RULE_IDS.has(f.ruleId) && f.ruleId !== dropRuleId)),
  );
  const findings = capFindings([...kept, ...fresh]);
  const productIds = known ? [...latest.productIds.filter((id) => !gone.has(id)), ...added] : latest.productIds || [];
  const total = Math.max(0, latest.total - deleted.length + added.length);
  const summary = summarizeFindings(total, findings, settings);
  return {
    ...summary,
    findings,
    names,
    context: latest.context || {},
    catalogTotal: Math.max(total, (latest.catalogTotal || latest.total) - deleted.length + added.length),
    readAt: latest.readAt,
    productIds,
    ignoredCount: latest.ignoredCount || 0,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

// Scans only the products added since the catalog was last read and merges them into the latest
// scan: their findings join the list, the totals grow by their number, and the read time moves to
// now. Catalog-wide rules are not re-run (a full scan does that). Returns null when nothing is new.
export async function scanNewProducts(graphql, shop, latest) {
  const started = Date.now();
  const known = new Set(latest.productIds || []);
  const ids = (await fetchNewProductIds(graphql, latest.readAt || latest.scannedAt)).filter((id) => !known.has(id));
  if (!ids.length) return null;
  const { speller, storeWords, ignored, settings, locale, currency } = await scanContext(graphql, shop);
  const products = await fetchProductsByIds(graphql, ids, settings.trackedMetafields || []);
  const names = latest.names || [];
  const ctx = { speller, customWords: seedWords(products, storeWords), nameWords: new Set(names), settings, locale, currency, catalog: latest.context || undefined };
  const fresh = runProductRules(products, ctx).filter((f) => !ignored.has(ignoreKey(f)));
  const added = new Set(ids);
  const findings = capFindings([...knownFindings(latest.findings).filter((f) => !added.has(f.productId)), ...fresh]);
  const total = latest.total + products.length;
  const summary = summarizeFindings(total, findings, settings);
  return {
    ...summary,
    findings,
    names,
    context: latest.context || {},
    catalogTotal: (latest.catalogTotal || latest.total) + products.length,
    readAt: new Date(started).toISOString(),
    productIds: [...(latest.productIds || []), ...products.map((p) => p.id)],
    ignoredCount: latest.ignoredCount || 0,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    added: products.length,
    addedFindings: fresh.length,
  };
}
