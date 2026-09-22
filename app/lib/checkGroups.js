// How the checks are organized: every rule has a family (what it is about) and a tier (how strongly
// we recommend it), and a preset picks tiers. Kept free of server-only imports so the pages can
// read it. Rule ids are the `id`s in rules.server.js.

export const TIERS = {
  essential: { label: "Essential", description: "Stops products from selling or being found." },
  recommended: { label: "Recommended", description: "Quality, SEO and margin checks." },
  consistency: { label: "Consistency", description: "House-style rules: casing, one-off tags, image shapes." },
};

export const FAMILIES = [
  { id: "title", label: "Title" },
  { id: "description", label: "Description" },
  { id: "spelling", label: "Spelling" },
  { id: "seo", label: "SEO Title & Meta Description" },
  { id: "images", label: "Images" },
  { id: "alt", label: "Alt Text" },
  { id: "identifiers", label: "SKUs & Barcodes" },
  { id: "stock", label: "Stock" },
  { id: "prices", label: "Prices" },
  { id: "sales", label: "Sales & Margins" },
  { id: "weight", label: "Weight" },
  { id: "variants", label: "Variants" },
  { id: "category", label: "Product Category" },
  { id: "vendor_type", label: "Vendor & Product Type" },
  { id: "tags_collections", label: "Tags & Collections" },
  { id: "status", label: "Status" },
  { id: "channels", label: "Sales Channels" },
  { id: "metafields", label: "Metafields" },
];

const E = "essential";
const R = "recommended";
const C = "consistency";

export const RULE_META = {
  // Title
  title_all_caps: { family: "title", tier: R },
  title_too_long: { family: "title", tier: R },
  title_formatting: { family: "title", tier: C },
  emoji_in_title: { family: "title", tier: R },
  vendor_repeated_in_title: { family: "title", tier: C },
  title_casing_outlier: { family: "title", tier: C },
  duplicate_title: { family: "title", tier: R },

  // Description
  missing_description: { family: "description", tier: E },
  short_description: { family: "description", tier: R },
  description_too_long: { family: "description", tier: R },
  description_is_title: { family: "description", tier: R },
  placeholder_text: { family: "description", tier: E },
  description_junk: { family: "description", tier: R },
  pasted_formatting: { family: "description", tier: R },
  description_img_no_alt: { family: "description", tier: R },
  dead_link: { family: "description", tier: R },
  language_mismatch: { family: "description", tier: R },
  duplicate_description: { family: "description", tier: C },

  // Spelling
  spelling: { family: "spelling", tier: R },

  // SEO title & meta description
  seo_title_missing: { family: "seo", tier: E },
  seo_title_too_long: { family: "seo", tier: R },
  seo_title_competing: { family: "seo", tier: R },
  meta_description_missing: { family: "seo", tier: E },
  meta_description_too_long: { family: "seo", tier: R },
  meta_description_short: { family: "seo", tier: R },
  meta_copies_description: { family: "seo", tier: R },
  handle_junk: { family: "seo", tier: C },

  // Images
  missing_image: { family: "images", tier: E },
  few_images: { family: "images", tier: R },
  small_image: { family: "images", tier: R },
  huge_image: { family: "images", tier: R },
  image_ratio_inconsistent: { family: "images", tier: C },

  // Alt text
  missing_alt_text: { family: "alt", tier: R },
  same_alt_text: { family: "alt", tier: R },
  alt_is_filename: { family: "alt", tier: R },
  alt_too_long: { family: "alt", tier: R },

  // SKUs & barcodes
  missing_sku: { family: "identifiers", tier: E },
  duplicate_sku: { family: "identifiers", tier: E },
  missing_barcode: { family: "identifiers", tier: R },
  barcode_invalid: { family: "identifiers", tier: E },
  duplicate_barcode: { family: "identifiers", tier: E },

  // Stock
  active_no_stock: { family: "stock", tier: E },
  negative_inventory: { family: "stock", tier: E },
  no_location: { family: "stock", tier: E },
  inventory_not_tracked: { family: "stock", tier: R },
  sells_when_out_of_stock: { family: "stock", tier: R },
  archived_with_stock: { family: "stock", tier: R },

  // Prices
  zero_price: { family: "prices", tier: E },
  placeholder_price: { family: "prices", tier: E },
  price_outlier: { family: "prices", tier: C },

  // Sales & margins
  compare_at_not_higher: { family: "sales", tier: E },
  stale_sale: { family: "sales", tier: R },
  deep_discount: { family: "sales", tier: R },
  missing_cost: { family: "sales", tier: R },
  price_below_cost: { family: "sales", tier: E },
  thin_margin: { family: "sales", tier: R },

  // Weight
  missing_weight: { family: "weight", tier: E },
  weight_implausible: { family: "weight", tier: R },
  weight_units_mixed: { family: "weight", tier: C },

  // Variants
  option_values_inconsistent: { family: "variants", tier: R },
  too_many_variants: { family: "variants", tier: C },

  // Vendor & product type
  missing_vendor: { family: "vendor_type", tier: E },
  vendor_casing: { family: "vendor_type", tier: C },
  vendor_not_allowed: { family: "vendor_type", tier: R },
  missing_product_type: { family: "vendor_type", tier: E },
  product_type_casing: { family: "vendor_type", tier: C },
  one_off_product_type: { family: "vendor_type", tier: C },

  // Tags & collections
  no_tags: { family: "tags_collections", tier: R },
  tag_casing: { family: "tags_collections", tier: C },
  one_off_tag: { family: "tags_collections", tier: C },
  no_collection: { family: "tags_collections", tier: R },

  // Status
  draft_stale: { family: "status", tier: R },

  // Product category
  category_missing: { family: "category", tier: E },
  category_broad: { family: "category", tier: R },

  // Sales channels
  not_published: { family: "channels", tier: E },
  unpublished_everywhere: { family: "channels", tier: E },
  channel_feedback: { family: "channels", tier: E },

  // Metafields
  metafield_required: { family: "metafields", tier: E },
  metafield_pattern: { family: "metafields", tier: E },
  metafield_malformed: { family: "metafields", tier: R },
};

export const PRESETS = [
  { id: "essential", label: "Essentials", description: "Only what stops products from selling or being found." },
  { id: "recommended", label: "Recommended", description: "Essentials plus quality, SEO and margin checks." },
  { id: "everything", label: "Everything", description: "Adds the house-style consistency checks." },
  { id: "custom", label: "Custom", description: "Pick checks one by one." },
];
export const DEFAULT_PRESET = "everything"; // every check on until the merchant turns some off
export const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

// The rule ids a preset turns off. "custom" is the merchant's own list.
export function disabledForPreset(preset, custom = []) {
  const ids = Object.keys(RULE_META);
  if (preset === "essential") return ids.filter((id) => RULE_META[id].tier !== E);
  if (preset === "recommended") return ids.filter((id) => RULE_META[id].tier === C);
  if (preset === "everything") return [];
  return [...custom];
}
