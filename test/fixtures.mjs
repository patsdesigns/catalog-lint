// Synthetic catalog for test/rules.test.mjs.
//
// Every product starts from one clean base (see `product`) and overrides a few fields to trigger
// specific checks; `expected` lists exactly which checks each product triggers, so the test can
// compare whole sets. Catalog-wide checks (duplicates, casing majorities, weight units) are planned
// across the list as a whole: the majority style is the one the clean products use (Title Case
// titles, "Porsche", "Jackets", "winter", kilograms), so the clean products stay clean.
//
// Spelling: the real dictionary runs over every product, so all text here is common English words
// (or capitalized names, which prose skips) except the one product with "recieve" and "beutiful".
// Vendor names are trusted automatically.

const DAY = 86400000;
const iso = (days) => new Date(Date.now() + days * DAY).toISOString();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// A valid GTIN-13 per index, so barcodes are unique and pass the check digit.
export function gtin13(i) {
  const body = `400638100${String(i).padStart(3, "0")}`.slice(0, 12);
  let sum = 0;
  for (let k = 0; k < 12; k++) sum += Number(body[k]) * (k % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

export const settings = {
  vendorWhitelist: ["Porsche", "Bosch"],
  trackedMetafields: [
    { id: 1, namespace: "custom", key: "mpn", fullKey: "custom.mpn", name: "MPN", type: "single_line_text_field", required: true, pattern: "^[A-Z]{3}-\\d{4}$", productType: "" },
  ],
  disabledRules: [],
};

// ---- texts ----
// 26 words, so the base is over the 20-word floor and, with the per-product sentence, over the
// 30-word floor where the language check starts to look.
const DESCRIPTION = "This warm jacket keeps you comfortable on cold days with a soft lining, deep pockets and a sturdy zip that lasts for many winters to come.";
// Not a prefix of the description, so the meta description does not "copy" it.
const META = "Warm jacket with soft lining and deep pockets for cold winter days.";
const LONG_TITLE = "Warm Winter Jacket With Soft Lining And Deep Pockets For Cold Days And Long Nights"; // 82 characters
const LONG_META = "Warm jacket with soft lining and deep pockets for cold winter days, made to last for many seasons with a sturdy zip, a snug collar and a roomy fit that works over a sweater or a shirt."; // 184 characters
const LONG_ALT = "Warm winter jacket with soft lining and deep pockets, shown from the front on a plain white background in bright daylight with the hood down and the zip closed"; // 160 characters
const PLACEHOLDER = "<p>This product is coming soon and the full description will be written when the first batch arrives at the store later this year.</p>"; // 23 words
const MISSPELLED = "<p>You will recieve this beutiful jacket in a box with a soft lining, deep pockets and a sturdy zip that lasts for many winters to come and keeps you warm.</p>";
// Raw URL, a spam phrase and an empty paragraph (links are not spell-checked).
const JUNK = "<p>Click here to order this warm jacket that keeps you comfortable on cold days with a soft lining and deep pockets, see https://example.com/jacket for more.</p><p></p>";
// 48 words of Spanish with no English stopwords. The lowercase words are cognates the English
// dictionary knows, and the accented words split into fragments too short to check.
const SPANISH = "<p>Chaqueta ideal para el frío. Color natural y material original, de valor superior. El interior es singular y el uso es casual, normal o formal. Es popular en el hotel, el patio, la plaza central y el festival local. Regalo ideal para papá, mamá y el bebé.</p>";
// 24 words shared by three products, with two dead links (no href, and href="#").
const SHARED = '<p>This soft wool scarf keeps your neck warm on cold days and goes with any coat, see <a href="#">details</a> or <a>more</a> about the range below.</p>';

// ---- builders ----
let seq = 0;
export function variant(key, over = {}) {
  const n = ++seq;
  return {
    id: `gid://shopify/ProductVariant/${key}-${n}`, title: "Default Title", sku: `SKU-${n}`, barcode: gtin13(n), price: "199.99", compareAtPrice: null,
    inventoryPolicy: "DENY", inventoryQuantity: 5, updatedAt: iso(-10), locations: 1, tracked: true, cost: "100.00",
    inventoryItemId: `gid://shopify/InventoryItem/${key}-${n}`, weight: 2, weightUnit: "KILOGRAMS", ...over,
  };
}
export function image(key, n, alt, over = {}) {
  return { id: `gid://shopify/MediaImage/${key}-${n}`, alt, width: 1200, height: 1200, ...over };
}
export function option(key, name, values) {
  return { id: `gid://shopify/ProductOption/${key}-${slug(name)}`, name, values, valueIds: values.map((v, i) => `gid://shopify/ProductOptionValue/${key}-${slug(name)}-${i + 1}`) };
}
const mpn = (value) => ({ key: "custom.mpn", name: "MPN", type: "single_line_text_field", value });

// A clean product: nothing on it triggers any check.
export function product(key, title, over = {}) {
  const n = ++seq;
  const variants = over.variants || [variant(key)];
  return {
    id: `gid://shopify/Product/${key}`, title, handle: slug(title), status: "ACTIVE", createdAt: iso(-400), updatedAt: iso(-10), publishedAt: iso(-10),
    totalInventory: 5, variantsCount: variants.length, collectionCount: 1, collectionIds: ["gid://shopify/Collection/1"],
    vendor: "Porsche", productType: "Jackets", tags: ["winter"],
    // Unique per product, so only the products that share a description on purpose do.
    descriptionHtml: `<p>${DESCRIPTION} Style ${n} of the range.</p>`, seoTitle: title, seoDescription: META,
    category: { id: "gid://shopify/TaxonomyCategory/aa-1-13", name: "Jackets", fullName: "Apparel & Accessories > Clothing > Outerwear > Jackets", isLeaf: true, level: 3 },
    publications: 2, publicationsOk: 2, channelIssues: [],
    options: [option(key, "Title", ["Default Title"])],
    metafields: [mpn("ABC-1234")],
    images: [image(key, 1, title), image(key, 2, `${title} side`)],
    ...over,
    variants,
  };
}

export const products = [];
export const expected = {};
// One fixture: the product, and exactly the checks it should trigger. `over` may be a function of
// the key, for overrides that build variants, images or options with ids.
function add(key, title, rules, over = {}) {
  const p = product(key, title, typeof over === "function" ? over(key) : over);
  products.push(p);
  expected[p.id] = [...rules].sort();
  return p;
}

// ---- description and title ----
add("no-description", "Winter Jacket Light", ["missing_description", "meta_description_missing", "missing_image"],
  { descriptionHtml: "", seoDescription: "", images: [] });
add("placeholder", "Wool Scarf Long", ["placeholder_text", "few_images"],
  (k) => ({ descriptionHtml: PLACEHOLDER, images: [image(k, 1, "Wool Scarf Long")] }));
add("misspelled", "Leather Boots Brown", ["spelling", "missing_alt_text"],
  (k) => ({ descriptionHtml: MISSPELLED, images: [image(k, 1, ""), image(k, 2, "Leather Boots Brown side")] }));
add("all-caps", "WINTER JACKET DELUXE", ["title_all_caps", "same_alt_text"],
  (k) => ({ images: [image(k, 1, "Winter Jacket"), image(k, 2, "Winter Jacket")] }));
add("too-long-title", LONG_TITLE, ["title_too_long", "small_image"],
  (k) => ({ seoTitle: "Warm Winter Jacket", images: [image(k, 1, "Warm Winter Jacket", { width: 600, height: 400 }), image(k, 2, "Warm Winter Jacket side")] }));
add("seo-too-long", "Cotton Shirt Blue", ["seo_title_too_long", "alt_is_filename"],
  (k) => ({ seoTitle: LONG_TITLE, images: [image(k, 1, "IMG_1234.jpg"), image(k, 2, "Cotton Shirt Blue side")] }));
add("stray-punctuation", "Summer  Hat Wide!!", ["title_formatting", "alt_too_long"],
  (k) => ({ images: [image(k, 1, LONG_ALT), image(k, 2, "Summer Hat side")] }));
// A description that is the title is also under 20 words.
add("repeats-title", "Wool Scarf Classic", ["description_is_title", "short_description", "missing_sku"],
  (k) => ({
    descriptionHtml: "<p>Wool Scarf Classic</p>",
    options: [option(k, "Color", ["Blue", "Red"])],
    variants: [variant(k, { title: "Blue", sku: "" }), variant(k, { title: "Red", sku: "  " })],
  }));
add("junk-description", "Rain Coat Yellow", ["description_junk", "missing_barcode"],
  (k) => ({ descriptionHtml: JUNK, variants: [variant(k, { barcode: "" })] }));
add("too-long-description", "Leather Belt Black", ["description_too_long", "barcode_invalid"],
  (k) => ({ descriptionHtml: `<p>${Array(81).fill(DESCRIPTION).join(" ")}</p>`, variants: [variant(k, { barcode: "4006381333930" })] }));
add("spanish-description", "Cotton Socks Green", ["language_mismatch", "zero_price"],
  (k) => ({
    descriptionHtml: SPANISH,
    options: [option(k, "Color", ["Blue", "Red"])],
    variants: [variant(k, { title: "Blue", price: "0", cost: "10.00" }), variant(k, { title: "Red", price: "20.00", cost: "10.00" })],
  }));
add("vendor-twice", "Porsche Jacket Porsche Edition", ["vendor_repeated_in_title", "price_below_cost"],
  (k) => ({ variants: [variant(k, { price: "50.00", cost: "80.00" })] }));
add("emoji-title", "Party Jacket 🎉", ["emoji_in_title", "thin_margin"],
  (k) => ({ variants: [variant(k, { price: "105.00", cost: "100.00" })] }));

// ---- SEO ----
add("no-seo-title", "Wool Sweater Red", ["seo_title_missing", "deep_discount"],
  (k) => ({ seoTitle: "", variants: [variant(k, { price: "10.00", compareAtPrice: "100.00", cost: "5.00" })] }));
add("long-meta", "Winter Gloves Warm", ["meta_description_too_long", "stale_sale"],
  (k) => ({ seoDescription: LONG_META, variants: [variant(k, { price: "150.00", compareAtPrice: "200.00", updatedAt: iso(-120) })] }));
add("junk-handle", "Winter Jacket Second", ["handle_junk", "compare_at_not_higher"],
  (k) => ({ handle: "copy-of-winter-jacket", variants: [variant(k, { compareAtPrice: "150.00" })] }));
add("meta-copies", "Cotton Vest Blue", ["meta_copies_description", "price_outlier"],
  (k) => ({
    seoDescription: "This warm jacket keeps you comfortable on cold days with a soft lining, deep pockets...",
    options: [option(k, "Size", ["Small", "Medium", "Large"])],
    variants: [
      variant(k, { title: "Small", price: "20.00", cost: "10.00" }),
      variant(k, { title: "Medium", price: "22.00", cost: "10.00" }),
      variant(k, { title: "Large", price: "200.00", cost: "10.00" }),
    ],
  }));

// ---- variants and shipping ----
add("no-cost-no-weight", "Leather Wallet Brown", ["missing_cost", "missing_weight"],
  (k) => ({ variants: [variant(k, { cost: null, weight: 0 })] }));
add("mixed-units", "Wool Blanket Soft", ["option_values_inconsistent", "weight_units_mixed"],
  (k) => ({
    options: [option(k, "Color", ["Blue", "blue"])],
    variants: [variant(k, { title: "Blue" }), variant(k, { title: "blue", weight: 4, weightUnit: "POUNDS" })],
  }));
// A draft is stale after 30 days without a change (updatedAt), not 30 days after creation.
add("too-many-variants", "Cotton Shirt Every Size", ["too_many_variants", "draft_stale"],
  { variantsCount: 101, status: "DRAFT", createdAt: iso(-400), updatedAt: iso(-60), publishedAt: null });

// ---- inventory and publishing ----
add("out-of-stock", "Summer Sandals Tan", ["active_no_stock", "no_collection"],
  (k) => ({ totalInventory: 0, collectionCount: 0, collectionIds: [], variants: [variant(k, { inventoryQuantity: 0 })] }));
// Two variants, so the product still has stock overall and only the negative one is reported.
add("negative-stock", "Winter Boots Black", ["negative_inventory", "not_published"],
  (k) => ({
    publishedAt: null, publications: 1, publicationsOk: 1, totalInventory: 2,
    options: [option(k, "Size", ["Small", "Large"])],
    variants: [variant(k, { title: "Small", inventoryQuantity: 5 }), variant(k, { title: "Large", inventoryQuantity: -3 })],
  }));
add("no-location", "Rain Boots Green", ["no_location", "unpublished_everywhere"],
  (k) => ({ publishedAt: null, publications: 0, publicationsOk: 0, variants: [variant(k, { locations: 0 })] }));
add("channel-error", "Leather Bag Brown", ["channel_feedback", "missing_vendor"],
  { vendor: "", channelIssues: [{ app: "Google & YouTube", messages: ["Missing GTIN"] }] });

// ---- organization ----
add("no-type", "Wool Hat Green", ["missing_product_type", "no_tags"], { productType: "", tags: [] });
add("vendor-off-list", "Cotton Cap Red", ["vendor_not_allowed", "category_missing"], { vendor: "Ferrari", category: null });
// Three Bosch products spell the vendor two ways: only the odd one out ("BOSCH") is reported, the
// two on the most common spelling are not. Each also carries one other casing outlier.
add("bosch-a", "Warm winter jacket for cold days", ["title_casing_outlier"], { vendor: "Bosch" });
add("bosch-b", "Winter Scarf Blue", ["tag_casing"], { vendor: "Bosch", tags: ["Winter"] });
add("bosch-c", "Winter Jacket Blue", ["vendor_casing", "product_type_casing"], { vendor: "BOSCH", productType: "jackets" });

// ---- duplicates and metafields ----
add("shared-desc-a", "Wool Scarf Red", ["duplicate_description", "dead_link", "metafield_pattern"], { descriptionHtml: SHARED, metafields: [mpn("abc")] });
add("shared-desc-b", "Wool Scarf Green", ["duplicate_description", "dead_link", "metafield_required"], { descriptionHtml: SHARED, metafields: [mpn("")] });
add("shared-desc-c", "Wool Scarf Blue", ["duplicate_description", "dead_link"], { descriptionHtml: SHARED });
// A cloned product: same title (so the same SEO title), SKU and barcode.
const CLONE = ["duplicate_sku", "duplicate_barcode", "duplicate_title", "seo_title_competing"];
add("clone-a", "Leather Gloves Classic", CLONE, (k) => ({ variants: [variant(k, { sku: "GLV-001", barcode: "4006381333931" })] }));
add("clone-b", "Leather Gloves Classic", CLONE, (k) => ({ variants: [variant(k, { sku: "GLV-001", barcode: "4006381333931" })] }));

// ---- edges that must not throw ----
add("bare", "Cotton Shirt Plain",
  ["missing_description", "missing_image", "seo_title_missing", "no_tags", "missing_vendor", "missing_product_type", "category_missing", "metafield_required"],
  { variants: [], images: [], descriptionHtml: null, options: [], tags: [], vendor: null, productType: null, category: null, publications: null, publicationsOk: null, handle: null, seoTitle: "", metafields: [] });
// No cost, no weight, no inventory item and no updatedAt: only the weight is reported, and with no
// inventory item there is nothing to save a cost to.
add("bare-variant", "Cotton Shirt Simple", ["missing_weight"],
  (k) => ({ variants: [{ id: `gid://shopify/ProductVariant/${k}-1`, title: "Default Title", sku: "SKU-BARE", barcode: gtin13(999), price: "199.99", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 5, locations: 1, tracked: true, cost: null, weight: 0, weightUnit: "KILOGRAMS" }] }));

// ---- clean ----
for (const title of ["Winter Jacket", "Wool Scarf", "Leather Boots", "Cotton Shirt", "Summer Hat", "Rain Coat"]) add(`clean-${slug(title)}`, title, []);

export const edgeProduct = products.find((p) => p.id === "gid://shopify/Product/bare");
