// How each check reads when it passes, and what to set up for checks that need a Setting.
// Keyed by rule id (app/lib/rules.server.js); a rule without an entry falls back to its label.
// Each label is a clause, so it reads on its own in a list and after "Passes when".
// Kept free of server-only imports so tooling can load it directly.

export const PASS_LABELS = {
  // Title and description
  missing_description: "Every product has a description",
  short_description: "Descriptions are at least 20 words",
  placeholder_text: "Descriptions and titles have no placeholder text",
  spelling: "There are no misspellings",
  title_all_caps: "No title is all caps",
  title_too_long: "Titles are 70 characters or fewer",
  title_formatting: "Titles are cleanly formatted",
  description_is_title: "Descriptions say more than the title",
  description_junk: "Descriptions are free of raw URLs, empty tags and spam phrases",
  description_too_long: "Descriptions are 2,000 words or fewer",
  language_mismatch: "Descriptions are in your store language",
  vendor_repeated_in_title: "Vendor names are not repeated in titles",
  emoji_in_title: "Titles have no emoji",
  duplicate_description: "Descriptions are unique to each product",
  title_casing_outlier: "Title casing is consistent",
  dead_link: "Links in descriptions go somewhere",

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
  same_alt_text: "Alt text differs between the images of a product",
  small_image: "Images are at least 800px",
  alt_is_filename: "No alt text is a filename",
  alt_too_long: "Alt text is 125 characters or fewer",

  // Inventory
  missing_sku: "Every variant has a SKU",
  missing_barcode: "Every variant has a barcode",
  active_no_stock: "Active products have stock",
  negative_inventory: "No variant has negative inventory",
  no_location: "Tracked variants are stocked at a location",
  duplicate_sku: "SKUs are unique",
  barcode_invalid: "Barcodes pass their check digit",
  duplicate_barcode: "Barcodes are unique",

  // Shipping
  missing_weight: "Every variant has a shipping weight",
  weight_units_mixed: "Weight units are consistent",

  // Pricing
  zero_price: "Every variant has a price",
  compare_at_not_higher: "Sale prices are real discounts",
  missing_cost: "Every variant has a cost per item",
  price_below_cost: "No price is below cost",
  price_outlier: "Variant prices are in line with each other",
  stale_sale: "No sale is older than 90 days",
  thin_margin: "Margins are at least 10%",
  deep_discount: "No discount is over 80%",

  // Variants
  option_values_inconsistent: "Option values are spelled consistently",
  too_many_variants: "Products have 100 variants or fewer",

  // Status
  draft_stale: "No draft is older than 30 days",

  // Sales channels
  not_published: "Active products are visible on your store",
  unpublished_everywhere: "Every active product is on at least one sales channel",
  channel_feedback: "No sales channel reports a problem",

  // Product organization
  no_collection: "Every active product is in a collection",
  missing_vendor: "Every product has a vendor",
  missing_product_type: "Every product has a product type",
  no_tags: "Every product has tags",
  vendor_casing: "Vendors are spelled consistently",
  tag_casing: "Tags are spelled consistently",
  product_type_casing: "Product types are spelled consistently",
  category_missing: "Every product has a product category",

  // Metafields
  metafield_required: "Required metafields are filled in",
  metafield_pattern: "Metafield values match their patterns",
};

// What a settings-gated check needs before it can run.
export const SETUP_LABELS = {
  metafield_required: "a required tracked metafield",
  metafield_pattern: "a tracked metafield with a pattern",
};

// Short names for the bulk fixes, used in notices, the Recent fixes card and the fix pages.
export const FIX_NAMES = {
  vendor_casing: "Vendor spelling",
  missing_weight: "Shipping weight",
  missing_alt_text: "Image alt text",
  compare_at_not_higher: "Sale price",
  zero_price: "Price",
  missing_sku: "SKU",
  duplicate_sku: "Duplicate SKU",
};
