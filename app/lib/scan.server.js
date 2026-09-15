import { runRules, summarize } from "./rules.server";

// Page sizes are kept small so one query stays under the Admin API cost limit.
// Phase 2 swaps this for a bulk operation so large catalogs scan in one job.
const PAGE_SIZE = 10;
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
        vendor
        productType
        tags
        descriptionHtml
        media(first: 5) {
          nodes {
            ... on MediaImage {
              id
              alt
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
            inventoryItem {
              id
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
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags || [],
    descriptionHtml: node.descriptionHtml,
    images: (node.media?.nodes || [])
      .filter((m) => m && m.id)
      .map((m) => ({ id: m.id, alt: m.alt })),
    variants: (node.variants?.nodes || []).map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      inventoryItemId: v.inventoryItem?.id,
      weight: v.inventoryItem?.measurement?.weight?.value ?? 0,
      weightUnit: v.inventoryItem?.measurement?.weight?.unit || "KILOGRAMS",
    })),
  };
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

export async function scanCatalog(graphql) {
  const started = Date.now();
  const products = await fetchCatalog(graphql);
  const findings = runRules(products);
  const summary = summarize(products, findings);

  return {
    ...summary,
    findings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
