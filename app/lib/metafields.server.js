import prisma from "../db.server";

// Tracked metafields: product metafield definitions the merchant chose to watch. Each is fetched
// with every product and covered by the Metafields checks (rules.server.js), and shows
// as a column on every issue page.

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
    if (pattern) new RegExp(pattern); // throws on an invalid pattern
    data.pattern = pattern;
  }
  if (fields.productType !== undefined) data.productType = String(fields.productType || "").trim();
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
    await prisma.trackedMetafield.upsert({
      where: { shop_namespace_key: { shop, namespace, key } },
      update: {},
      create: { shop, namespace, key, name, type: "single_line_text_field", required: true, pattern: String(r.pattern || "").trim(), productType: String(r.productType || "").trim() },
    });
    migrated += 1;
  }
  return migrated;
}

// The store's product metafield definitions, for the Tracked metafields dropdown.
export async function fetchDefinitions(graphql) {
  const out = [];
  let cursor = null;
  for (;;) {
    const response = await graphql(DEFINITIONS_QUERY, { variables: { cursor } });
    const { data, errors } = await response.json();
    if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));
    const conn = data?.metafieldDefinitions;
    for (const d of conn?.nodes || []) out.push({ id: d.id, name: d.name, namespace: d.namespace, key: d.key, type: d.type?.name || "single_line_text_field" });
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}
