// Every write to Shopify goes through here so fixes, edits, and undo share one path.

async function mutate(graphql, query, variables, pickErrors) {
  const response = await graphql(query, { variables });
  const { data, errors } = await response.json();
  if (errors?.length) return errors.map((e) => e.message);
  const userErrors = pickErrors(data) || [];
  return userErrors.map((e) => e.message);
}

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

const PRODUCT_READ = `#graphql
  query ProductRead($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      productType
      tags
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
export const VARIANT_FIELDS = ["sku", "barcode", "price", "compareAt"];

export async function readProduct(graphql, productId) {
  const response = await graphql(PRODUCT_READ, { variables: { id: productId } });
  const { data } = await response.json();
  const p = data?.product;
  if (!p) return null;
  return {
    title: p.title || "",
    descriptionHtml: p.descriptionHtml || "",
    vendor: p.vendor || "",
    productType: p.productType || "",
    tags: p.tags || [],
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

// Reverse one FixLog entry. Returns error strings, empty on success.
export async function revert(graphql, entry) {
  const before = JSON.parse(entry.before);
  const f = entry.field;
  if (PRODUCT_TEXT_FIELDS.includes(f)) return setProductField(graphql, entry.productId, f, before);
  if (VARIANT_FIELDS.includes(f)) return setVariantField(graphql, entry.productId, entry.targetId, f, before);
  if (f === "weight") return setWeight(graphql, entry.targetId, before.value, before.unit);
  if (f === "alt") return setAlt(graphql, entry.productId, entry.targetId, before);
  if (f === "cost") return setCost(graphql, entry.targetId, before);
  return [`Unknown field ${f}`];
}
