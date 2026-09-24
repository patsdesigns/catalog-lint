// Every write to Shopify goes through here so fixes, edits, and undo share one path, and every
// write is preceded by a read of the value it replaces. Reads and writes use the shared helper
// (graphql.server.js): paced on the cost bucket, retried on throttling.

import { request } from "./graphql.server";

// Runs a mutation and returns its error messages, empty on success. A throttle that does not
// clear, or any other failure, is an error message too, so a loop of writes carries on.
async function mutate(graphql, query, variables, pickErrors) {
  let data;
  try {
    data = await request(graphql, query, variables);
  } catch (err) {
    return [err.message];
  }
  const userErrors = pickErrors(data) || [];
  return userErrors.map((e) => e.message);
}

const read = (graphql, query, variables) => request(graphql, query, variables);

// ---------- operations ----------

const PRODUCT_UPDATE = `#graphql
  mutation ProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`;

const VARIANTS_UPDATE = `#graphql
  mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const INVENTORY_UPDATE = `#graphql
  mutation InventoryUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`;

const OPTION_UPDATE = `#graphql
  mutation OptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $optionValuesToUpdate) {
      product { id }
      userErrors { field message code }
    }
  }
`;

const PUBLISH = `#graphql
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const UNPUBLISH = `#graphql
  mutation Unpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const PUBLICATIONS = `#graphql
  query Publications {
    publications(first: 25) { nodes { id catalog { title } } }
  }
`;

const PUBLISHED_ON = `#graphql
  query PublishedOn($id: ID!, $publicationId: ID!) {
    product(id: $id) { publishedOnPublication(publicationId: $publicationId) }
  }
`;

const SET_QUANTITIES = `#graphql
  mutation SetAvailable($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_LEVELS = `#graphql
  query InventoryLevels($id: ID!) {
    inventoryItem(id: $id) {
      inventoryLevels(first: 50) {
        nodes {
          location { id }
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  }
`;

const INVENTORY_ITEM = `#graphql
  query InventoryItemRead($id: ID!) {
    inventoryItem(id: $id) {
      id
      unitCost { amount }
      measurement { weight { value unit } }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const METAFIELDS_DELETE = `#graphql
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { namespace key }
      userErrors { field message }
    }
  }
`;

const METAFIELD_READ = `#graphql
  query MetafieldRead($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      metafield(namespace: $namespace, key: $key) { type value }
    }
  }
`;

const PRODUCT_READ = `#graphql
  query ProductRead($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      productType
      tags
      status
      seo { title description }
    }
  }
`;

const VARIANT_READ = `#graphql
  query VariantRead($id: ID!) {
    productVariant(id: $id) {
      id
      price
      compareAtPrice
      sku
      barcode
      inventoryPolicy
      inventoryItem { id }
    }
  }
`;

const VARIANT_IDS = `#graphql
  query VariantIds($id: ID!) {
    product(id: $id) { variants(first: 250) { nodes { id inventoryPolicy } } }
  }
`;


const OPTIONS_READ = `#graphql
  query OptionsRead($id: ID!) {
    product(id: $id) { options { id name optionValues { id name } } }
  }
`;

// ---------- fields ----------

export const PRODUCT_TEXT_FIELDS = ["title", "descriptionHtml", "vendor", "productType", "tags", "seoTitle", "seoDescription"];
// Product fields that are not text but are still set through productUpdate.
export const PRODUCT_ENUM_FIELDS = ["status"];
export const PRODUCT_FIELDS = [...PRODUCT_TEXT_FIELDS, ...PRODUCT_ENUM_FIELDS];
export const VARIANT_FIELDS = ["sku", "barcode", "price", "compareAt", "inventoryPolicy"];

// ---------- reads ----------

export async function readProduct(graphql, productId) {
  const data = await read(graphql, PRODUCT_READ, { id: productId });
  const p = data?.product;
  if (!p) return null;
  return {
    title: p.title || "",
    descriptionHtml: p.descriptionHtml || "",
    vendor: p.vendor || "",
    productType: p.productType || "",
    tags: p.tags || [],
    status: p.status || "",
    seoTitle: p.seo?.title || "",
    seoDescription: p.seo?.description || "",
  };
}

// The variant as it is now, keyed like VARIANT_FIELDS, or null when it no longer exists.
export async function readVariant(graphql, variantId) {
  const data = await read(graphql, VARIANT_READ, { id: variantId });
  const v = data?.productVariant;
  if (!v) return null;
  return {
    sku: v.sku || "",
    barcode: v.barcode || "",
    price: v.price ?? "",
    compareAt: v.compareAtPrice ?? null,
    inventoryPolicy: v.inventoryPolicy || "DENY",
    inventoryItemId: v.inventoryItem?.id || null,
  };
}

// Every variant of a product with its inventory policy.
export async function readVariantIds(graphql, productId) {
  const data = await read(graphql, VARIANT_IDS, { id: productId });
  return (data?.product?.variants?.nodes || []).map((v) => ({ id: v.id, inventoryPolicy: v.inventoryPolicy || "DENY" }));
}

// The cost and the weight of an inventory item, or null when it no longer exists.
export async function readInventoryItem(graphql, inventoryItemId) {
  const data = await read(graphql, INVENTORY_ITEM, { id: inventoryItemId });
  const item = data?.inventoryItem;
  if (!item) return null;
  return {
    cost: item.unitCost?.amount ?? null,
    weight: { value: Number(item.measurement?.weight?.value ?? 0), unit: item.measurement?.weight?.unit || "KILOGRAMS" },
  };
}

// The options of a product with their values, by option id.
export async function readOptions(graphql, productId) {
  const data = await read(graphql, OPTIONS_READ, { id: productId });
  return (data?.product?.options || []).map((o) => ({ id: o.id, name: o.name, values: (o.optionValues || []).map((v) => ({ id: v.id, name: v.name })) }));
}

// The Online Store sales channel of this store, or null when the store has none.
export async function onlineStorePublicationId(graphql) {
  const data = await read(graphql, PUBLICATIONS);
  const nodes = data?.publications?.nodes || [];
  const title = (n) => n.catalog?.title || "";
  const hit = nodes.find((n) => title(n) === "Online Store") || nodes.find((n) => /online store/i.test(title(n)));
  return hit ? hit.id : null;
}

export async function readPublished(graphql, productId, publicationId) {
  const data = await read(graphql, PUBLISHED_ON, { id: productId, publicationId });
  return Boolean(data?.product?.publishedOnPublication);
}

// Where the item is stocked, with the available quantity at each location.
export async function readInventoryLevels(graphql, inventoryItemId) {
  const data = await read(graphql, INVENTORY_LEVELS, { id: inventoryItemId });
  return (data?.inventoryItem?.inventoryLevels?.nodes || [])
    .filter((level) => level?.location?.id)
    .map((level) => ({ locationId: level.location.id, quantity: (level.quantities || []).find((q) => q.name === "available")?.quantity ?? 0 }));
}

// The metafield as it is now ({ type, value }), or null when the product has none by that key.
export async function readMetafield(graphql, productId, key) {
  const { namespace, key: k } = splitKey(key);
  const data = await read(graphql, METAFIELD_READ, { id: productId, namespace, key: k });
  const m = data?.product?.metafield;
  return m ? { type: m.type, value: m.value } : null;
}

// ---------- writes ----------

export async function setProductField(graphql, productId, field, value) {
  if (!PRODUCT_FIELDS.includes(field)) return [`Unknown product field ${field}`];
  const product = { id: productId };
  if (field === "seoTitle") product.seo = { title: value };
  else if (field === "seoDescription") product.seo = { description: value };
  else if (field === "tags") {
    product.tags = Array.isArray(value)
      ? value
      : String(value || "").split(",").map((t) => t.trim()).filter(Boolean);
  } else product[field] = value;
  return mutate(graphql, PRODUCT_UPDATE, { product }, (d) => d.productUpdate?.userErrors);
}

export async function setVariantField(graphql, productId, variantId, field, value) {
  if (!VARIANT_FIELDS.includes(field)) return [`Unknown variant field ${field}`];
  const variant = { id: variantId };
  if (field === "sku") variant.inventoryItem = { sku: value };
  else if (field === "compareAt") variant.compareAtPrice = value === "" || value === null ? null : value;
  else variant[field] = value;
  return mutate(
    graphql,
    VARIANTS_UPDATE,
    { productId, variants: [variant] },
    (d) => d.productVariantsBulkUpdate?.userErrors,
  );
}

export async function setWeight(graphql, inventoryItemId, value, unit) {
  return mutate(
    graphql,
    INVENTORY_UPDATE,
    { id: inventoryItemId, input: { measurement: { weight: { value: Number(value), unit } } } },
    (d) => d.inventoryItemUpdate?.userErrors,
  );
}

export async function setCost(graphql, inventoryItemId, cost) {
  return mutate(
    graphql,
    INVENTORY_UPDATE,
    { id: inventoryItemId, input: { cost: cost === "" || cost === null ? null : Number(cost) } },
    (d) => d.inventoryItemUpdate?.userErrors,
  );
}


// Renames one value of a product option (the value keeps its id, so every variant follows).
export async function renameOptionValue(graphql, productId, optionId, valueId, name) {
  return mutate(
    graphql,
    OPTION_UPDATE,
    { productId, option: { id: optionId }, optionValuesToUpdate: [{ id: valueId, name }] },
    (d) => d.productOptionUpdate?.userErrors,
  );
}

export async function setPublished(graphql, productId, publicationId, on) {
  const query = on ? PUBLISH : UNPUBLISH;
  return mutate(
    graphql,
    query,
    { id: productId, input: [{ publicationId }] },
    (d) => (on ? d.publishablePublish : d.publishableUnpublish)?.userErrors,
  );
}

export async function setAvailable(graphql, inventoryItemId, locationId, quantity) {
  return mutate(
    graphql,
    SET_QUANTITIES,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId, locationId, quantity: Number(quantity) }],
      },
    },
    (d) => d.inventorySetQuantities?.userErrors,
  );
}

const splitKey = (key) => {
  const i = String(key).indexOf(".");
  return i === -1 ? { namespace: "custom", key: String(key) } : { namespace: key.slice(0, i), key: key.slice(i + 1) };
};

export async function setMetafield(graphql, productId, key, type, value) {
  const { namespace, key: k } = splitKey(key);
  return mutate(
    graphql,
    METAFIELDS_SET,
    { metafields: [{ ownerId: productId, namespace, key: k, type, value: String(value) }] },
    (d) => d.metafieldsSet?.userErrors,
  );
}

export async function deleteMetafield(graphql, productId, key) {
  const { namespace, key: k } = splitKey(key);
  return mutate(
    graphql,
    METAFIELDS_DELETE,
    { metafields: [{ ownerId: productId, namespace, key: k }] },
    (d) => d.metafieldsDelete?.userErrors,
  );
}

// ---------- undo ----------

// Values compared the way the field holds them: numbers as numbers, cleared values as null.
function same(field, a, b) {
  const numeric = ["price", "compareAt", "cost"];
  if (numeric.includes(field)) {
    const n = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
    return n(a) === n(b);
  }
  if (field === "tags") return (Array.isArray(a) ? a : []).join(" ") === (Array.isArray(b) ? b : []).join(" ");
  if (field === "weight") return Number(a?.value) === Number(b?.value) && (a?.unit || "") === (b?.unit || "");
  if (field === "available") return Number(a?.quantity) === Number(b?.quantity);
  if (field === "metafield") return (a?.value ?? null) === (b?.value ?? null);
  if (field === "optionValue") return (a?.name ?? a) === (b?.name ?? b);
  if (field === "publication") return Boolean(a) === Boolean(b);
  return String(a ?? "") === String(b ?? "");
}

// What the field holds right now, or undefined when its owner no longer exists.
async function currentValue(graphql, entry) {
  const f = entry.field;
  if (PRODUCT_FIELDS.includes(f)) {
    const p = await readProduct(graphql, entry.productId);
    return p ? p[f] : undefined;
  }
  if (VARIANT_FIELDS.includes(f)) {
    const v = await readVariant(graphql, entry.targetId);
    return v ? v[f] : undefined;
  }
  if (f === "weight" || f === "cost") {
    const item = await readInventoryItem(graphql, entry.targetId);
    return item ? item[f] : undefined;
  }
  if (f === "optionValue") {
    for (const o of await readOptions(graphql, entry.productId)) {
      const v = o.values.find((x) => x.id === entry.targetId);
      if (v) return { optionId: o.id, name: v.name };
    }
    return undefined;
  }
  if (f === "publication") return readPublished(graphql, entry.productId, entry.targetId);
  if (f === "available") {
    const after = JSON.parse(entry.after);
    const level = (await readInventoryLevels(graphql, entry.targetId)).find((l) => l.locationId === after?.locationId);
    return level || undefined;
  }
  if (f === "metafield") return readMetafield(graphql, entry.productId, entry.targetId);
  return undefined;
}

// Reverses one FixLog entry. Returns { errors, stale }: errors are messages (empty on success);
// stale means the field no longer holds what the fix wrote (the product changed since, or is gone),
// so it was left as it is and the entry is closed.
export async function revert(graphql, entry) {
  const before = JSON.parse(entry.before);
  const after = JSON.parse(entry.after);
  const f = entry.field;
  // Alt text fixes from before the alt text checks were taken out (2026-09-24) cannot be undone
  // until they come back: writing alt text needs a permission the app no longer asks for. The
  // entry stays open, so the undo works again then.
  if (f === "alt") return { errors: ["alt text changes cannot be undone in this version"], stale: false };
  const current = await currentValue(graphql, entry);
  if (current === undefined) return { errors: ["no longer exists, nothing to undo"], stale: true };
  if (!same(f, current, after)) return { errors: ["was changed after the fix, left as it is"], stale: true };

  let errors;
  if (PRODUCT_FIELDS.includes(f)) errors = await setProductField(graphql, entry.productId, f, before);
  else if (VARIANT_FIELDS.includes(f)) errors = await setVariantField(graphql, entry.productId, entry.targetId, f, before);
  else if (f === "weight") errors = await setWeight(graphql, entry.targetId, before.value, before.unit);
  else if (f === "cost") errors = await setCost(graphql, entry.targetId, before);
  else if (f === "optionValue") errors = await renameOptionValue(graphql, entry.productId, before.optionId, entry.targetId, before.name);
  else if (f === "publication") errors = await setPublished(graphql, entry.productId, entry.targetId, Boolean(before));
  else if (f === "available") errors = await setAvailable(graphql, entry.targetId, before.locationId, before.quantity);
  else if (f === "metafield") {
    errors = before ? await setMetafield(graphql, entry.productId, entry.targetId, before.type, before.value) : await deleteMetafield(graphql, entry.productId, entry.targetId);
  } else errors = [`Unknown field ${f}`];
  return { errors, stale: false };
}
