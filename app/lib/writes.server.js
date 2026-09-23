// Every write to Shopify goes through here so fixes, edits, and undo share one path. Reads and
// writes use the shared helper (graphql.server.js): paced on the cost bucket, retried on throttling.

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

const MEDIA_UPDATE = `#graphql
  mutation MediaUpdate($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
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

const SET_QUANTITIES = `#graphql
  mutation SetAvailable($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_LEVEL = `#graphql
  query InventoryLevel($id: ID!) {
    inventoryItem(id: $id) {
      inventoryLevels(first: 1) {
        nodes {
          location { id }
          quantities(names: ["available"]) { name quantity }
        }
      }
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

export const PRODUCT_TEXT_FIELDS = [
  "title",
  "descriptionHtml",
  "vendor",
  "productType",
  "tags",
  "seoTitle",
  "seoDescription",
];
// Product fields that are not text but are still set through productUpdate.
export const PRODUCT_ENUM_FIELDS = ["status"];
export const VARIANT_FIELDS = ["sku", "barcode", "price", "compareAt", "inventoryPolicy"];

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

export async function setProductField(graphql, productId, field, value) {
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
  const variant = { id: variantId };
  if (field === "sku") variant.inventoryItem = { sku: value };
  else if (field === "compareAt") variant.compareAtPrice = value === "" ? null : value;
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

export async function setAlt(graphql, productId, mediaId, alt) {
  return mutate(
    graphql,
    MEDIA_UPDATE,
    { productId, media: [{ id: mediaId, alt }] },
    (d) => d.productUpdateMedia?.mediaUserErrors,
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

// The Online Store sales channel of this store, or null when the store has none.
export async function onlineStorePublicationId(graphql) {
  const data = await read(graphql, PUBLICATIONS);
  const nodes = data?.publications?.nodes || [];
  const title = (n) => n.catalog?.title || "";
  const hit = nodes.find((n) => title(n) === "Online Store") || nodes.find((n) => /online store/i.test(title(n)));
  return hit ? hit.id : null;
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

// Where the item is stocked first, with its available quantity, or null when it is stocked nowhere.
export async function readAvailable(graphql, inventoryItemId) {
  const data = await read(graphql, INVENTORY_LEVEL, { id: inventoryItemId });
  const level = data?.inventoryItem?.inventoryLevels?.nodes?.[0];
  if (!level?.location?.id) return null;
  const available = (level.quantities || []).find((q) => q.name === "available");
  return { locationId: level.location.id, quantity: available ? available.quantity : 0 };
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

// The metafield as it is now ({ type, value }), or null when the product has none by that key.
export async function readMetafield(graphql, productId, key) {
  const { namespace, key: k } = splitKey(key);
  const data = await read(graphql, METAFIELD_READ, { id: productId, namespace, key: k });
  const m = data?.product?.metafield;
  return m ? { type: m.type, value: m.value } : null;
}

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

// Reverse one FixLog entry. Returns error strings, empty on success.
export async function revert(graphql, entry) {
  const before = JSON.parse(entry.before);
  const f = entry.field;
  if (PRODUCT_TEXT_FIELDS.includes(f) || PRODUCT_ENUM_FIELDS.includes(f)) return setProductField(graphql, entry.productId, f, before);
  if (VARIANT_FIELDS.includes(f)) return setVariantField(graphql, entry.productId, entry.targetId, f, before);
  if (f === "weight") return setWeight(graphql, entry.targetId, before.value, before.unit);
  if (f === "alt") return setAlt(graphql, entry.productId, entry.targetId, before);
  if (f === "cost") return setCost(graphql, entry.targetId, before);
  if (f === "optionValue") return renameOptionValue(graphql, entry.productId, before.optionId, entry.targetId, before.name);
  if (f === "publication") return setPublished(graphql, entry.productId, entry.targetId, Boolean(before));
  if (f === "available") return setAvailable(graphql, entry.targetId, before.locationId, before.quantity);
  if (f === "metafield") {
    return before ? setMetafield(graphql, entry.productId, entry.targetId, before.type, before.value) : deleteMetafield(graphql, entry.productId, entry.targetId);
  }
  return [`Unknown field ${f}`];
}
