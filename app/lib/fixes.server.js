import { fetchCatalog } from "./scan.server";

// Every fix re-reads the catalog first so it never acts on stale data.
// Each fix returns { fixed, skipped, errors } and the caller rescans afterwards.

const MAX_MUTATIONS_PER_RUN = 100;

async function mutate(graphql, query, variables, pickErrors) {
  const response = await graphql(query, { variables });
  const { data, errors } = await response.json();
  if (errors?.length) return errors.map((e) => e.message);
  const userErrors = pickErrors(data) || [];
  return userErrors.map((e) => e.message);
}

const UPDATE_VENDOR = `#graphql
  mutation UpdateVendor($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_WEIGHT = `#graphql
  mutation UpdateWeight($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_ALT = `#graphql
  mutation UpdateAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
    }
  }
`;

async function fixVendorCasing(graphql, products) {
  const groups = new Map();
  for (const p of products) {
    const raw = (p.vendor || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase().replace(/\s+/g, " ");
    if (!groups.has(key)) groups.set(key, new Map());
    const counts = groups.get(key);
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }

  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;

  for (const [key, counts] of groups) {
    if (counts.size < 2) continue;
    const canonical = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    for (const p of products) {
      const raw = (p.vendor || "").trim();
      if (raw.toLowerCase().replace(/\s+/g, " ") !== key || raw === canonical) continue;
      if (budget-- <= 0) {
        result.skipped += 1;
        continue;
      }
      const errs = await mutate(
        graphql,
        UPDATE_VENDOR,
        { product: { id: p.id, vendor: canonical } },
        (d) => d.productUpdate?.userErrors,
      );
      if (errs.length) result.errors.push(`${p.title}: ${errs.join(", ")}`);
      else result.fixed += 1;
    }
  }
  return result;
}

async function fixMissingWeight(graphql, products) {
  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;

  for (const p of products) {
    const donor = p.variants.find((v) => v.weight > 0);
    const missing = p.variants.filter((v) => !v.weight || v.weight <= 0);
    if (!missing.length) continue;
    if (!donor) {
      result.skipped += missing.length;
      continue;
    }

    for (const v of missing) {
      if (!v.inventoryItemId || budget-- <= 0) {
        result.skipped += 1;
        continue;
      }
      const errs = await mutate(
        graphql,
        UPDATE_WEIGHT,
        {
          id: v.inventoryItemId,
          input: {
            measurement: { weight: { value: donor.weight, unit: donor.weightUnit } },
          },
        },
        (d) => d.inventoryItemUpdate?.userErrors,
      );
      if (errs.length) result.errors.push(`${p.title} / ${v.title}: ${errs.join(", ")}`);
      else result.fixed += 1;
    }
  }
  return result;
}

async function fixMissingAltText(graphql, products) {
  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;

  for (const p of products) {
    const missing = p.images.filter((img) => !(img.alt || "").trim());
    if (!missing.length) continue;
    if (budget-- <= 0) {
      result.skipped += missing.length;
      continue;
    }
    const errs = await mutate(
      graphql,
      UPDATE_ALT,
      { productId: p.id, media: missing.map((img) => ({ id: img.id, alt: p.title })) },
      (d) => d.productUpdateMedia?.mediaUserErrors,
    );
    if (errs.length) result.errors.push(`${p.title}: ${errs.join(", ")}`);
    else result.fixed += missing.length;
  }
  return result;
}

const FIXERS = {
  vendor_casing: fixVendorCasing,
  missing_weight: fixMissingWeight,
  missing_alt_text: fixMissingAltText,
};

export async function applyFix(graphql, ruleId) {
  const fixer = FIXERS[ruleId];
  if (!fixer) throw new Error(`No fix available for ${ruleId}`);
  const products = await fetchCatalog(graphql);
  return fixer(graphql, products);
}
