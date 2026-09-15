// How each check reads when it passes, and what to set up for checks that need a Setting.
// Keyed by rule id (app/lib/rules.server.js); a rule without an entry falls back to its label.
// Kept free of server-only imports so tooling can load it directly.

export const PASS_LABELS = {
  // Title and description
  missing_description: "Every product has a description",
  short_description: "Descriptions are at least 20 words",
  placeholder_text: "No placeholder text in descriptions",
  spelling: "No misspellings found",
  title_all_caps: "No all-caps titles",
  title_too_long: "Titles are 70 characters or fewer",
  title_formatting: "Titles are cleanly formatted",
  description_is_title: "Descriptions say more than the title",
  description_junk: "Descriptions are free of raw URLs, empty tags and spam phrases",
  description_too_long: "Descriptions are under 2,000 words",
  language_mismatch: "Descriptions are in your store language",
  vendor_repeated_in_title: "Vendor names aren't repeated in titles",
  emoji_in_title: "No emoji in titles",
  duplicate_description: "Descriptions are unique to each product",
  title_casing_outlier: "Title casing is consistent",

  // Search engine listing
  seo_title_missing: "Every product has an SEO title",
  seo_title_too_long: "SEO titles are 60 characters or fewer",
  meta_description_missing: "Every product has a meta description",
  meta_description_too_long: "Meta descriptions are 160 characters or fewer",
  handle_junk: "URL handles are clean",
  meta_copies_description: "Meta descriptions are written for search, not copied",
  duplicate_title: "Product titles are unique",
  seo_title_competing: "SEO titles are unique",

  // Media
  missing_image: "Every product has an image",
  few_images: "Products have more than one image",
  missing_alt_text: "Every image has alt text",
  same_alt_text: "Alt text differs between a product's images",
  small_image: "Images are at least 800px",
  image_ratio_inconsistent: "Image shapes are consistent",
  first_image_banner: "First images aren't banner shaped",

  // Inventory
  missing_sku: "Every variant has a SKU",
  missing_barcode: "Every variant has a barcode",
  active_no_stock: "Active products have stock",
  negative_inventory: "No negative inventory",
  no_location: "Tracked variants are stocked at a location",
  duplicate_sku: "SKUs are unique",

  // Shipping
  missing_weight: "Every variant has a shipping weight",

  // Pricing
  zero_price: "Every variant has a price",
  compare_at_not_higher: "Sale prices are real discounts",
  missing_cost: "Every variant has a cost per item",
  price_below_cost: "No prices below cost",
  price_outlier: "Variant prices are in line with each other",
  stale_sale: "No sales older than 90 days",
  odd_cents: "Price endings are consistent",

  // Variants
  option_values_inconsistent: "Option values are spelled consistently",
  too_many_variants: "Products have 100 variants or fewer",

  // Status
  draft_stale: "No drafts older than 30 days",
  not_published: "Active products are visible on your store",
  untouched_year: "Every product was updated in the last year",

  // Product organization
  no_collection: "Every product is in a collection",
  missing_vendor: "Every product has a vendor",
  missing_product_type: "Every product has a product type",
  no_tags: "Every product has tags",
  vendor_not_allowed: "All vendors are on your approved list",
  vendor_casing: "Vendors are spelled consistently",
  one_off_product_type: "Product types are shared by more than one product",
  one_off_tag: "Tags are used by more than one product",
  tag_casing: "Tags are spelled consistently",

  // Metafields
  metafield_required: "Required metafields are filled in",
  metafield_pattern: "Metafield values match their patterns",
};

// What a settings-gated check needs before it can run.
export const SETUP_LABELS = {
  vendor_not_allowed: "an approved vendor list",
  metafield_required: "required metafields",
  metafield_pattern: "metafield patterns",
};
