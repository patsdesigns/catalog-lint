import { runRules, summarize } from "./rules.server";
import { loadSpeller, seedWords } from "./spelling.server";
import { getWords } from "./dictionary.server";
import { getIgnoreKeys, ignoreKey } from "./ignores.server";
import { getSettings } from "./settings.server";

// Page sizes are kept small so one query stays under the Admin API cost limit.
// Phase 2 swaps this for a bulk operation so large catalogs scan in one job.
const PAGE_SIZE = 8;
const MAX_PAGES = 20; // 200 products for v1, bulk operations lift this in phase 2

const QUERY = `#graphql
  query CatalogScan($cursor: String) {
    products(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        status
        createdAt
        updatedAt
        publishedAt
        totalInventory
        vendor
        productType
        tags
        descriptionHtml
        variantsCount {
          count
        }
        collections(first: 1) {
          nodes {
            id
          }
        }
        seo {
          title
          description
        }
        options {
          name
          optionValues {
            name
          }
        }
        metafields(first: 20) {
          nodes {
            namespace
            key
            type
            value
          }
        }
        media(first: 5) {
          nodes {
            ... on MediaImage {
              id
              alt
              image {
                width
                height
              }
            }
          }
        }
        variants(first: 10) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryPolicy
            inventoryQuantity
            updatedAt
            inventoryItem {
              id
              tracked
              locationsCount {
                count
              }
              unitCost {
                amount
              }
              measurement {
                weight {
                  value
                  unit
                }
              }
            }
          }
        }
      }
    }
  }
`;

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

const LOCALE_QUERY = `#graphql
  query PrimaryLocale {
    shopLocales(published: true) {
      locale
      primary
    }
  }
`;

export async function fetchPrimaryLocale(graphql) {
  try {
    const response = await graphql(LOCALE_QUERY);
    const { data } = await response.json();
    return (data?.shopLocales || []).find((l) => l.primary)?.locale || "en";
  } catch {
    return "en";
  }
}

export async function fetchCatalog(graphql) {
  const products = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await graphql(QUERY, { variables: { cursor } });
    const { data, errors } = await response.json();

    if (errors?.length) {
      throw new Error(errors.map((e) => e.message).join("; "));
    }

    const conn = data.products;
    products.push(...conn.nodes.map(normalize));

    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return products;
}

export async function scanCatalog(graphql, shop) {
  const started = Date.now();
  const [products, speller, storeWords, ignored, settings, locale] = await Promise.all([
    fetchCatalog(graphql),
    loadSpeller(),
    shop ? getWords(shop) : [],
    shop ? getIgnoreKeys(shop) : new Set(),
    shop ? getSettings(shop) : { vendorWhitelist: [], metafieldRules: [] },
    fetchPrimaryLocale(graphql),
  ]);
  const ctx = { speller, customWords: seedWords(products, storeWords), settings, locale };
  const all = runRules(products, ctx);
  const findings = all.filter((f) => !ignored.has(ignoreKey(f)));
  const summary = summarize(products, findings, settings);

  return {
    ...summary,
    findings,
    ignoredCount: all.length - findings.length,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
