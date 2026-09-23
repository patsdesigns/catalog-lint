import prisma from "../db.server";
import { request } from "./graphql.server";
import { patternError } from "./regex.server";

// Tracked metafields: product metafield definitions the merchant chose to watch. Each is fetched
// with every product and covered by the Metafields checks (rules.server.js), and shows
// as a column on every issue page.

// Each tracked metafield adds a field to every product query; this many keeps the by-id and paged
// reads under the single-request cost limit with room to spare.
export const MAX_TRACKED = 7;
const MAX_DEFINITION_PAGES = 50;

const DEFINITIONS_QUERY = `#graphql
  query ProductMetafieldDefinitions($cursor: String) {
    metafieldDefinitions(first: 100, ownerType: PRODUCT, after: $cursor) {
      nodes { id name namespace key type { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function view(row) {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    fullKey: `${row.namespace}.${row.key}`,
    name: row.name,
    type: row.type,
    required: row.required,
    pattern: row.pattern || "",
    productType: row.productType || "",
  };
}

export async function listTracked(shop) {
  const rows = await prisma.trackedMetafield.findMany({ where: { shop }, orderBy: { id: "asc" } });
  return rows.map(view);
}

// Starts tracking a definition: required on, no pattern, every product type.
export async function trackMetafield(shop, def) {
  const namespace = String(def.namespace || "").trim();
  const key = String(def.key || "").trim();
  if (!namespace || !key) throw new Error("A metafield needs a namespace and a key.");
  const existing = await prisma.trackedMetafield.findMany({ where: { shop }, select: { namespace: true, key: true } });
  if (existing.length >= MAX_TRACKED && !existing.some((t) => t.namespace === namespace && t.key === key)) {
    throw new Error(`You can track up to ${MAX_TRACKED} metafields. Remove one to add another.`);
  }
  const data = { name: String(def.name || key).trim() || key, type: String(def.type || "single_line_text_field") };
  const row = await prisma.trackedMetafield.upsert({
    where: { shop_namespace_key: { shop, namespace, key } },
    update: data,
    create: { shop, namespace, key, ...data },
  });
  return view(row);
}

export async function updateTracked(shop, id, fields) {
  const data = {};
  if (fields.required !== undefined) data.required = Boolean(fields.required);
  if (fields.pattern !== undefined) {
    const pattern = String(fields.pattern || "").trim();
    const problem = await patternError(pattern);
    if (problem) throw new Error(problem);
    data.pattern = pattern;
  }
  if (fields.productType !== undefined) data.productType = String(fields.productType || "").trim().slice(0, 255);
  if (!Number.isInteger(Number(id))) throw new Error("That metafield was not understood. Reload the page and try again.");
  await prisma.trackedMetafield.updateMany({ where: { shop, id: Number(id) }, data });
}

export async function untrackMetafield(shop, id) {
  await prisma.trackedMetafield.deleteMany({ where: { shop, id: Number(id) } });
}

// The old metafield rules ({ key: "namespace.key", productType, pattern }) become tracked
// metafields: required on, the pattern and product type carried over, named after the key until
// the store's definition says better.
export async function migrateMetafieldRules(shop, rules) {
  let migrated = 0;
  for (const r of rules || []) {
    const full = String(r.key || "").trim();
    const dot = full.indexOf(".");
    if (dot <= 0) continue;
    const namespace = full.slice(0, dot);
    const key = full.slice(dot + 1);
    if (!key) continue;
    const name = key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    // An old pattern that would not pass today is dropped rather than carried over.
    const pattern = String(r.pattern || "").trim();
    await prisma.trackedMetafield.upsert({
      where: { shop_namespace_key: { shop, namespace, key } },
      update: {},
      create: { shop, namespace, key, name, type: "single_line_text_field", required: true, pattern: (await patternError(pattern)) ? "" : pattern, productType: String(r.productType || "").trim().slice(0, 255) },
    });
    migrated += 1;
  }
  return migrated;
}

// The store's product metafield definitions, for the Tracked metafields dropdown.
export async function fetchDefinitions(graphql) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_DEFINITION_PAGES; page++) {
    const data = await request(graphql, DEFINITIONS_QUERY, { cursor });
    const conn = data?.metafieldDefinitions;
    for (const d of conn?.nodes || []) out.push({ id: d.id, name: d.name, namespace: d.namespace, key: d.key, type: d.type?.name || "single_line_text_field" });
    const info = conn?.pageInfo;
    if (!(info?.hasNextPage && info.endCursor && info.endCursor !== cursor)) break;
    cursor = info.endCursor;
  }
  return out;
}
