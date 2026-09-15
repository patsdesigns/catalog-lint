// Reading the catalog and running the rules over it.
//
// Catalogs up to SYNC_LIMIT products are read with regular paginated queries inside the request.
// Larger catalogs go through a Shopify bulk operation: Shopify exports every product to a JSONL
// file in the background, the page loader polls it (rescan.server.js) and the rules run once the
// file is ready, so a 50k-product catalog scans without request timeouts or API rate limits.

import { runRules, runProductRules, CATALOG_RULE_IDS, summarize, summarizeFindings } from "./rules.server";
import { loadSpeller, seedWords } from "./spelling.server";
import { getWords } from "./dictionary.server";
import { getIgnoreKeys, ignoreKey } from "./ignores.server";
import { getSettings } from "./settings.server";

export const SYNC_LIMIT = Number(process.env.CATALOG_LINT_SYNC_LIMIT ?? 250);
const PAGE_SIZE = 8; // keeps one paginated query under the Admin API cost limit
const IDS_PER_QUERY = 10;

// One product's fields, shared by the paginated, by-id and bulk queries. Regular queries page
// their connections; a bulk query takes no pagination arguments and returns every node, each on
// its own JSONL line tagged with __parentId and __typename.
function productFields(paged) {
  const arg = (n) => (paged ? `(first: ${n})` : "");
  const conn = (body) => (paged ? `{ nodes { ${body} } }` : `{ edges { node { __typename ${body} } } }`);
  return `
    __typename
    id title handle status createdAt updatedAt publishedAt totalInventory vendor productType tags descriptionHtml
    variantsCount { count }
    seo { title description }
    options { name optionValues { name } }
    collections${arg(1)} ${conn("id")}
    metafields${arg(20)} ${conn("namespace key type value")}
    media${arg(5)} ${conn("... on MediaImage { id alt image { width height } }")}
    variants${arg(10)} ${conn(`
      id title sku barcode price compareAtPrice inventoryPolicy inventoryQuantity updatedAt
      inventoryItem { id tracked locationsCount { count } unitCost { amount } measurement { weight { value unit } } }
    `)}
  `;
}

const CATALOG_QUERY = `#graphql
  query CatalogScan($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${productFields(true)} }
    }
  }
`;

const BY_IDS_QUERY = `#graphql
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { ${productFields(true)} } }
  }
`;

// Five connections (products + four nested), two levels deep: the bulk query limits.
export const BULK_QUERY = `{ products { edges { node { ${productFields(false)} } } } }`;

const COUNT_QUERY = `#graphql
  query ProductsCount { productsCount { count } }
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

const LOCALE_QUERY = `#graphql
  query PrimaryLocale {
    shopLocales(published: true) { locale primary }
  }
`;

async function graphqlJson(graphql, query, variables) {
  const response = await graphql(query, { variables });
  const { data, errors } = await response.json();
  // GraphQL errors are an array; an auth failure comes back as a single string.
  if (errors) throw new Error(Array.isArray(errors) ? errors.map((e) => e.message).join("; ") : String(errors?.message || errors));
  return data;
}

function normalize(node) {
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    publishedAt: node.publishedAt,
    totalInventory: node.totalInventory ?? 0,
    variantsCount: node.variantsCount?.count ?? 0,
    collectionCount: (node.collections?.nodes || []).length,
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags || [],
    descriptionHtml: node.descriptionHtml,
    seoTitle: node.seo?.title || "",
    seoDescription: node.seo?.description || "",
    options: (node.options || []).map((o) => ({
      name: o.name,
      values: (o.optionValues || []).map((v) => v.name),
    })),
    metafields: (node.metafields?.nodes || []).map((m) => ({
      key: `${m.namespace}.${m.key}`,
      type: m.type,
      value: m.value,
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

export async function fetchPrimaryLocale(graphql) {
  try {
    const data = await graphqlJson(graphql, LOCALE_QUERY);
    return (data?.shopLocales || []).find((l) => l.primary)?.locale || "en";
  } catch {
    return "en";
  }
}

export async function countProducts(graphql) {
  const data = await graphqlJson(graphql, COUNT_QUERY);
  return data.productsCount?.count ?? 0;
}

// Every product, page by page. Only used for catalogs up to SYNC_LIMIT (see rescan.server.js).
export async function fetchCatalog(graphql) {
  const products = [];
  let cursor = null;
  for (;;) {
    const data = await graphqlJson(graphql, CATALOG_QUERY, { cursor });
    const conn = data.products;
    products.push(...conn.nodes.map(normalize));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return products;
}

// The given products only, in small batches. Products that no longer exist are left out.
export async function fetchProductsByIds(graphql, ids) {
  const products = [];
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const data = await graphqlJson(graphql, BY_IDS_QUERY, { ids: ids.slice(i, i + IDS_PER_QUERY) });
    for (const node of data.nodes || []) if (node?.id) products.push(normalize(node));
  }
  return products;
}

// ---------- bulk operations ----------

async function runningBulkQuery(graphql) {
  const data = await graphqlJson(graphql, RUNNING_BULK);
  return (data.bulkOperations?.nodes || []).find((op) => op.status === "RUNNING" || op.status === "CREATED") || null;
}

// Starts Shopify's export of the whole catalog and returns the bulk operation id.
export async function startBulkScan(graphql) {
  const data = await graphqlJson(graphql, START_BULK, { query: BULK_QUERY });
  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (bulkOperation?.id) return bulkOperation.id;
  // Shopify runs one bulk query per app per shop. If ours is still going (say, the page was
  // closed mid-scan), pick it up rather than failing.
  const running = await runningBulkQuery(graphql);
  const squash = (s) => (s || "").replace(/\s+/g, "");
  if (running && squash(running.query) === squash(BULK_QUERY)) return running.id;
  throw new Error(userErrors.map((e) => e.message).join("; ") || "Shopify did not start the catalog export");
}

export async function bulkScanStatus(graphql, id) {
  const data = await graphqlJson(graphql, BULK_STATUS, { id });
  return data.bulkOperation;
}

// Streams the finished JSONL export and rebuilds one object per product. Child nodes (variants,
// media, metafields, collections) arrive as their own lines pointing at the product via __parentId.
export async function downloadBulkCatalog(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the catalog export (${response.status})`);
  const products = new Map();
  const orphans = [];
  const attach = (child) => {
    const parent = products.get(child.__parentId);
    if (!parent) return false;
    if (child.__typename === "ProductVariant") parent.variants.nodes.push(child);
    else if (child.__typename === "Metafield") parent.metafields.nodes.push(child);
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
      products.set(obj.id, { ...obj, variants: { nodes: [] }, media: { nodes: [] }, metafields: { nodes: [] }, collections: { nodes: [] } });
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
  return [...products.values()].map(normalize);
}

// ---------- running the rules ----------

async function scanContext(graphql, shop) {
  const [speller, storeWords, ignored, settings, locale] = await Promise.all([
    loadSpeller(),
    shop ? getWords(shop) : [],
    shop ? getIgnoreKeys(shop) : new Set(),
    shop ? getSettings(shop) : { vendorWhitelist: [], metafieldRules: [] },
    fetchPrimaryLocale(graphql),
  ]);
  return { speller, storeWords, ignored, settings, locale };
}

// Runs every rule over an already-read catalog and builds the stored scan result.
export async function scanProducts(products, graphql, shop, startedAt = Date.now()) {
  const { speller, storeWords, ignored, settings, locale } = await scanContext(graphql, shop);
  const ctx = { speller, customWords: seedWords(products, storeWords), settings, locale };
  const all = runRules(products, ctx);
  const findings = all.filter((f) => !ignored.has(ignoreKey(f)));
  return {
    ...summarize(products, findings, settings),
    findings,
    ignoredCount: all.length - findings.length,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

export async function scanCatalog(graphql, shop) {
  const started = Date.now();
  return scanProducts(await fetchCatalog(graphql), graphql, shop, started);
}

// Re-reads only the given products and re-runs the product rules on them, splicing the results
// into the latest scan. Catalog-wide rules keep their findings for these products, except the rule
// the merchant just acted on (dropRuleId), which the action has resolved for them.
export async function recheckProducts(graphql, shop, latest, ids, dropRuleId = null) {
  const started = Date.now();
  const products = await fetchProductsByIds(graphql, ids);
  const { speller, storeWords, ignored, settings, locale } = await scanContext(graphql, shop);
  const ctx = { speller, customWords: seedWords(products, storeWords), settings, locale };
  const fresh = runProductRules(products, ctx).filter((f) => !ignored.has(ignoreKey(f)));
  const touched = new Set(ids);
  const kept = latest.findings.filter(
    (f) => !touched.has(f.productId) || (CATALOG_RULE_IDS.has(f.ruleId) && f.ruleId !== dropRuleId),
  );
  const findings = [...kept, ...fresh];
  const total = Math.max(0, latest.total - (ids.length - products.length)); // products deleted since the scan
  return {
    ...summarizeFindings(total, findings, settings),
    findings,
    ignoredCount: latest.ignoredCount || 0,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
