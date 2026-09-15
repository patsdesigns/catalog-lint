// Catalog lint rules
// Each rule returns an array of findings for one product.
// Catalog rules run once across every product (duplicates, casing).

const PLACEHOLDERS = [
  "lorem ipsum",
  "tbd",
  "coming soon",
  "placeholder",
  "description here",
  "insert description",
  "test product",
];

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function finding(rule, product, extra = {}) {
  return {
    ruleId: rule.id,
    label: rule.label,
    severity: rule.severity,
    productId: product.id,
    productTitle: product.title,
    ...extra,
  };
}

export const PRODUCT_RULES = [
  {
    id: "missing_image",
    label: "No product image",
    severity: "high",
    check(p) {
      return p.images.length === 0 ? [finding(this, p)] : [];
    },
  },
  {
    id: "missing_alt_text",
    label: "Image missing alt text",
    severity: "low",
    check(p) {
      const missing = p.images.filter((img) => !(img.alt || "").trim());
      return missing.length
        ? [finding(this, p, { detail: `${missing.length} of ${p.images.length} images` })]
        : [];
    },
  },
  {
    id: "missing_description",
    label: "No description",
    severity: "high",
    check(p) {
      return wordCount(stripHtml(p.descriptionHtml)) === 0 ? [finding(this, p)] : [];
    },
  },
  {
    id: "short_description",
    label: "Description under 20 words",
    severity: "medium",
    check(p) {
      const words = wordCount(stripHtml(p.descriptionHtml));
      return words > 0 && words < 20
        ? [finding(this, p, { detail: `${words} words` })]
        : [];
    },
  },
  {
    id: "placeholder_text",
    label: "Placeholder text in title or description",
    severity: "high",
    check(p) {
      const haystack = `${p.title} ${stripHtml(p.descriptionHtml)}`.toLowerCase();
      const hit = PLACEHOLDERS.find((ph) => haystack.includes(ph));
      return hit ? [finding(this, p, { detail: `"${hit}"` })] : [];
    },
  },
  {
    id: "missing_vendor",
    label: "No vendor",
    severity: "medium",
    check(p) {
      return !(p.vendor || "").trim() ? [finding(this, p)] : [];
    },
  },
  {
    id: "missing_product_type",
    label: "No product type",
    severity: "medium",
    check(p) {
      return !(p.productType || "").trim() ? [finding(this, p)] : [];
    },
  },
  {
    id: "no_tags",
    label: "No tags",
    severity: "low",
    check(p) {
      return p.tags.length === 0 ? [finding(this, p)] : [];
    },
  },
  {
    id: "missing_sku",
    label: "Variant missing SKU",
    severity: "high",
    check(p) {
      return p.variants
        .filter((v) => !(v.sku || "").trim())
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title }));
    },
  },
  {
    id: "missing_barcode",
    label: "Variant missing barcode",
    severity: "low",
    check(p) {
      return p.variants
        .filter((v) => !(v.barcode || "").trim())
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title }));
    },
  },
  {
    id: "missing_weight",
    label: "Variant has no weight",
    severity: "medium",
    check(p) {
      return p.variants
        .filter((v) => !v.weight || v.weight <= 0)
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title }));
    },
  },
  {
    id: "zero_price",
    label: "Variant priced at zero",
    severity: "high",
    check(p) {
      return p.variants
        .filter((v) => Number(v.price) === 0)
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title }));
    },
  },
  {
    id: "compare_at_not_higher",
    label: "Compare at price is not above price",
    severity: "medium",
    check(p) {
      return p.variants
        .filter(
          (v) =>
            v.compareAtPrice !== null &&
            v.compareAtPrice !== undefined &&
            Number(v.compareAtPrice) <= Number(v.price),
        )
        .map((v) =>
          finding(this, p, {
            variantId: v.id,
            detail: `${v.title}: ${v.compareAtPrice} vs ${v.price}`,
          }),
        );
    },
  },
];

export const CATALOG_RULES = [
  {
    id: "duplicate_sku",
    label: "Duplicate SKU",
    severity: "high",
    check(products) {
      const bySku = new Map();
      for (const p of products) {
        for (const v of p.variants) {
          const sku = (v.sku || "").trim();
          if (!sku) continue;
          if (!bySku.has(sku)) bySku.set(sku, []);
          bySku.get(sku).push({ p, v });
        }
      }
      const out = [];
      for (const [sku, hits] of bySku) {
        if (hits.length < 2) continue;
        for (const { p, v } of hits) {
          out.push(
            finding(this, p, {
              variantId: v.id,
              detail: `${sku} used ${hits.length} times`,
            }),
          );
        }
      }
      return out;
    },
  },
  {
    id: "vendor_casing",
    label: "Vendor name differs only by casing or spacing",
    severity: "medium",
    check(products) {
      const groups = new Map();
      for (const p of products) {
        const raw = (p.vendor || "").trim();
        if (!raw) continue;
        const key = raw.toLowerCase().replace(/\s+/g, " ");
        if (!groups.has(key)) groups.set(key, new Map());
        const variants = groups.get(key);
        variants.set(raw, (variants.get(raw) || 0) + 1);
      }
      const out = [];
      for (const [, variants] of groups) {
        if (variants.size < 2) continue;
        const spellings = [...variants.keys()];
        for (const p of products) {
          if (spellings.includes((p.vendor || "").trim())) {
            out.push(finding(this, p, { detail: spellings.join(" / ") }));
          }
        }
      }
      return out;
    },
  },
];

export function runRules(products) {
  const findings = [];
  for (const p of products) {
    for (const rule of PRODUCT_RULES) findings.push(...rule.check(p));
  }
  for (const rule of CATALOG_RULES) findings.push(...rule.check(products));
  return findings;
}

export function summarize(products, findings) {
  const byRule = {};
  for (const f of findings) {
    if (!byRule[f.ruleId]) {
      byRule[f.ruleId] = { ruleId: f.ruleId, label: f.label, severity: f.severity, count: 0 };
    }
    byRule[f.ruleId].count += 1;
  }

  const dirty = new Set(
    findings.filter((f) => f.severity !== "low").map((f) => f.productId),
  );
  const total = products.length;
  const clean = total - dirty.size;
  const score = total === 0 ? 100 : Math.round((clean / total) * 100);

  const order = { high: 0, medium: 1, low: 2 };
  const rules = Object.values(byRule).sort(
    (a, b) => order[a.severity] - order[b.severity] || b.count - a.count,
  );

  return { score, total, clean, rules };
}
