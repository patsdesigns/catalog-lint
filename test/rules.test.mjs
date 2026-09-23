// The 66 checks against a synthetic catalog (test/fixtures.mjs): the catalog itself (ids, labels,
// severities, categories), exact findings per product, coverage of every check, the shape of a
// finding, the summary, and that empty and single-product catalogs do not throw.
// Plain node: `npm run test:rules`. One line per assertion, exit code 1 on any failure.
import { products, expected, settings, edgeProduct } from "./fixtures.mjs";

const APP = new URL("../app/lib/", import.meta.url).href;
const { runRules, RULE_CATALOG, summarizeFindings } = await import(APP + "rules.server.js");
const { loadSpeller, seedWords, catalogNames } = await import(APP + "spelling.server.js");

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failed += 1;
};
const uniqueSorted = (list) => [...new Set(list)].sort();
const minus = (a, b) => a.filter((x) => !b.includes(x));

// ---------- 1. the catalog: 66 checks with these labels, severities and categories ----------
const FINAL = {
  description: {
    high: { missing_description: "No description", placeholder_text: "Placeholder text" },
    medium: { description_is_title: "Description just repeats the title", language_mismatch: "Description may not be in your store language", spelling: "Possible misspelling", title_all_caps: "Title is all caps" },
    low: {
      short_description: "Description under 20 words", dead_link: "Dead link in description", description_junk: "Description has junk (raw URL, empty tags, spam phrases)",
      description_too_long: "Description over 2,000 words", emoji_in_title: "Emoji in title", duplicate_description: "Same description on many products",
      title_casing_outlier: "Title casing inconsistent", title_formatting: "Title has stray spaces or punctuation", title_too_long: "Title over 70 characters",
      vendor_repeated_in_title: "Vendor appears twice in title",
    },
  },
  media: {
    high: { missing_image: "No product image" },
    medium: { small_image: "Image under 800px", missing_alt_text: "Image has no alt text", few_images: "Only one image" },
    low: { same_alt_text: "All images share the same alt text", alt_is_filename: "Alt text is a filename", alt_too_long: "Alt text over 125 characters" },
  },
  pricing: {
    high: { zero_price: "No price set", price_below_cost: "Price below cost" },
    medium: { deep_discount: "Discount over 80%", thin_margin: "Margin under 10%", price_outlier: "One variant priced far from the others", compare_at_not_higher: "Sale price is not a discount" },
    low: { missing_cost: "No cost per item", stale_sale: "On sale for more than 90 days" },
  },
  inventory: {
    high: { duplicate_sku: "Duplicate SKU", missing_sku: "No SKU", barcode_invalid: "Barcode fails its check digit", duplicate_barcode: "Duplicate barcode" },
    medium: { active_no_stock: "Active with nothing in stock", negative_inventory: "Negative inventory", no_location: "Tracked variant with no location" },
    low: { missing_barcode: "No barcode" },
  },
  organization: {
    medium: { category_missing: "No product category", missing_product_type: "No product type", missing_vendor: "No vendor", vendor_casing: "Vendor spelled two ways" },
    low: { vendor_not_allowed: "Vendor not on your approved list", no_tags: "No tags", no_collection: "Not in any collection", product_type_casing: "Product type spelled two ways", tag_casing: "Tag spelled two ways" },
  },
  shipping: {
    medium: { missing_weight: "No shipping weight" },
    low: { weight_units_mixed: "Mixed weight units" },
  },
  variants: {
    medium: { option_values_inconsistent: "Option values spelled two ways" },
    low: { too_many_variants: "More than 100 variants" },
  },
  seo: {
    medium: { duplicate_title: "Duplicate product title", seo_title_missing: "SEO title missing", seo_title_too_long: "SEO title over 60 characters" },
    low: {
      meta_description_missing: "Meta description missing", seo_title_competing: "Two products share an SEO title", handle_junk: "Messy URL handle",
      meta_copies_description: "Meta description just copies the description", meta_description_too_long: "Meta description over 160 characters",
    },
  },
  status: { low: { draft_stale: "Draft for more than 30 days" } },
  publishing: { high: { channel_feedback: "A sales channel reports a problem", unpublished_everywhere: "Not on any sales channel", not_published: "Not visible on your store" } },
  metafields: { medium: { metafield_pattern: "Metafield does not match pattern", metafield_required: "Required metafield missing" } },
};
const FINAL_RULES = new Map();
for (const [category, bySeverity] of Object.entries(FINAL)) {
  for (const [severity, rules] of Object.entries(bySeverity)) {
    for (const [id, label] of Object.entries(rules)) FINAL_RULES.set(id, { label, severity, category });
  }
}
const RULE_IDS = [...FINAL_RULES.keys()].sort();

console.log("---- catalog");
check("the final list has 66 checks", FINAL_RULES.size === 66, String(FINAL_RULES.size));
check("RULE_CATALOG has 66 checks", RULE_CATALOG.length === 66, String(RULE_CATALOG.length));
const catalogIds = RULE_CATALOG.map((r) => r.id).sort();
check("RULE_CATALOG ids are unique", new Set(catalogIds).size === RULE_CATALOG.length);
check("RULE_CATALOG has exactly the final ids", catalogIds.join() === RULE_IDS.join(),
  `missing=[${minus(RULE_IDS, catalogIds)}] extra=[${minus(catalogIds, RULE_IDS)}]`);
for (const rule of RULE_CATALOG) {
  const want = FINAL_RULES.get(rule.id);
  if (!want) continue;
  const ok = rule.label === want.label && rule.severity === want.severity && rule.category === want.category;
  check(`${rule.id}: ${want.severity} ${want.category} "${want.label}"`, ok,
    ok ? "" : `got ${rule.severity} ${rule.category} "${rule.label}"`);
}

// ---------- 2. exact findings per product ----------
console.log("---- products");
const speller = await loadSpeller();
const ctx = { speller, customWords: seedWords(products, []), nameWords: new Set(catalogNames(products, speller)), settings, locale: "en" };
const findings = runRules(products, ctx);

check("every product has an expectation", products.every((p) => Array.isArray(expected[p.id])),
  `without: ${products.filter((p) => !expected[p.id]).map((p) => p.id).join(", ")}`);
check("every expectation has a product", Object.keys(expected).every((id) => products.some((p) => p.id === id)));
check("product ids are unique", new Set(products.map((p) => p.id)).size === products.length);
const cleanCount = products.filter((p) => (expected[p.id] || []).length === 0).length;
check(`${products.length} products, ${cleanCount} of them clean (at least 4)`, cleanCount >= 4);

const byProduct = new Map(products.map((p) => [p.id, []]));
for (const f of findings) if (byProduct.has(f.productId)) byProduct.get(f.productId).push(f.ruleId);
check("every finding belongs to a product in the catalog", findings.every((f) => byProduct.has(f.productId)));
for (const p of products) {
  const key = p.id.split("/").pop();
  const want = expected[p.id] || [];
  const got = uniqueSorted(byProduct.get(p.id));
  const ok = got.join() === want.join();
  check(`${key}: ${want.length ? want.join(", ") : "clean"}`, ok,
    ok ? "" : `missing=[${minus(want, got)}] extra=[${minus(got, want)}]`);
}

// ---------- 3. every check fires at least once ----------
console.log("---- coverage");
const fired = new Set(findings.map((f) => f.ruleId));
const uncovered = RULE_IDS.filter((id) => !fired.has(id));
check("every one of the 66 checks has at least one finding", uncovered.length === 0, uncovered.length ? `uncovered: ${uncovered.join(", ")}` : "");
check("no finding carries an unknown check", [...fired].every((id) => FINAL_RULES.has(id)), [...fired].filter((id) => !FINAL_RULES.has(id)).join(", "));

// ---------- 4. the shape of a finding ----------
console.log("---- findings");
const SEVERITIES = new Set(["high", "medium", "low"]);
const shaped = (f) =>
  typeof f.ruleId === "string" && typeof f.label === "string" && typeof f.category === "string" && SEVERITIES.has(f.severity)
  && typeof f.productId === "string" && typeof f.productTitle === "string";
check(`all ${findings.length} findings have ruleId, label, category, severity, productId and productTitle`, findings.every(shaped),
  findings.filter((f) => !shaped(f)).slice(0, 3).map((f) => JSON.stringify(f).slice(0, 120)).join(" | "));
check("every finding carries the label, severity and category of its check",
  findings.every((f) => { const w = FINAL_RULES.get(f.ruleId); return w && f.label === w.label && f.severity === w.severity && f.category === w.category; }));
const withEdit = findings.filter((f) => f.edit);
check(`the ${withEdit.length} findings with an edit have edit.kind and a string edit.current`,
  withEdit.every((f) => typeof f.edit.kind === "string" && f.edit.kind && typeof f.edit.current === "string"),
  withEdit.filter((f) => !(typeof f.edit.kind === "string" && typeof f.edit.current === "string")).slice(0, 3).map((f) => `${f.ruleId}:${JSON.stringify(f.edit).slice(0, 80)}`).join(" | "));
check("edits name their check and product", withEdit.every((f) => f.edit.ruleId === f.ruleId && f.edit.productId === f.productId));
const misspelt = findings.filter((f) => f.ruleId === "spelling");
check("the spelling findings carry the misspelt word",
  misspelt.length >= 2 && misspelt.every((f) => typeof f.word === "string") && misspelt.some((f) => f.word === "recieve") && misspelt.some((f) => f.word === "beutiful"),
  misspelt.map((f) => `${f.productId.split("/").pop()}:${f.word}`).join(", "));
check("variant findings name their variant", findings.filter((f) => f.variantId).every((f) => typeof f.variantTitle === "string" && typeof f.sku === "string"));

// ---------- 5. the summary ----------
console.log("---- summary");
const summary = summarizeFindings(products.length, findings, settings);
check("summary lists a check for each of the 66", summary.checks.length === 66 && summary.checks.map((c) => c.ruleId).sort().join() === RULE_IDS.join());
const notFailed = summary.checks.filter((c) => fired.has(c.ruleId) && c.status !== "failed");
check("every triggered check is failed", notFailed.length === 0, notFailed.map((c) => `${c.ruleId}=${c.status}`).join(", "));
const skipped = summary.checks.filter((c) => c.status === "skipped" || c.status === "off");
check("no check is skipped or off (a vendor list and a required tracked metafield with a pattern are set)", skipped.length === 0, skipped.map((c) => `${c.ruleId}=${c.status}`).join(", "));
check("check counts add up to the findings", summary.checks.reduce((a, c) => a + c.count, 0) === findings.length);
check(`summary counts ${cleanCount} clean products out of ${products.length}`, summary.total === products.length && summary.clean === cleanCount, `total=${summary.total} clean=${summary.clean}`);
check("score is a whole number from 0 to 100", Number.isInteger(summary.score) && summary.score >= 0 && summary.score <= 100, String(summary.score));

// ---------- 6. empty and single-product catalogs ----------
console.log("---- edges");
let emptyResult = null;
let emptyError = null;
try { emptyResult = runRules([], ctx); } catch (e) { emptyError = e; }
check("runRules([]) returns no findings without throwing", !emptyError && Array.isArray(emptyResult) && emptyResult.length === 0, emptyError ? String(emptyError.stack).split("\n").slice(0, 2).join(" ") : "");
let singleResult = null;
let singleError = null;
try { singleResult = runRules([edgeProduct], ctx); } catch (e) { singleError = e; }
const singleGot = singleError ? [] : uniqueSorted(singleResult.map((f) => f.ruleId));
check("runRules([bare]) runs the edge product alone without throwing", !singleError && singleGot.join() === expected[edgeProduct.id].join(),
  singleError ? String(singleError.stack).split("\n").slice(0, 2).join(" ") : `missing=[${minus(expected[edgeProduct.id], singleGot)}] extra=[${minus(singleGot, expected[edgeProduct.id])}]`);
let noCtxError = null;
try { runRules(products.slice(0, 3)); } catch (e) { noCtxError = e; }
check("runRules without a ctx (no speller, no settings) does not throw", !noCtxError, noCtxError ? String(noCtxError.stack).split("\n").slice(0, 2).join(" ") : "");

// ---------- 7. suggestions and boundaries ----------
console.log("---- suggestions");
const { catalogContext } = await import(APP + "rules.server.js");
const base = products.find((p) => (expected[p.id] || []).length === 0);
const clone = (key, over) => ({ ...base, id: `gid://shopify/Product/${key}`, handle: key, ...over });
const suggestionFor = (list, key) => list.find((f) => f.ruleId === "title_casing_outlier" && f.productId === `gid://shopify/Product/${key}`)?.edit?.suggested;

// The fixture catalog is mostly Title Case: an outlier gets a Title Case suggestion that recases
// only the letters of each word, leaves punctuation where it is, and keeps brands as they are.
const toTitle = [
  ["tc-punct", "warm jacket, blue (large)", "Warm Jacket, Blue (Large)"],
  ["tc-apos", "kids’ jacket for cold days", "Kids’ Jacket For Cold Days"],
  ["tc-brand", "wool hat for iPhone users", "Wool Hat For iPhone Users"],
  ["tc-quote", "“warm” jacket for kids", "“Warm” Jacket For Kids"],
];
const titleRun = runRules([...products, ...toTitle.map(([key, title]) => clone(key, { title }))], ctx);
for (const [key, title, want] of toTitle) {
  const got = suggestionFor(titleRun, key);
  check(`Title Case suggestion for "${title}"`, got === want, got === want ? "" : `got ${JSON.stringify(got)}`);
}

// A catalog that is mostly sentence case: the outliers get a sentence case suggestion that keeps
// the first word, acronyms and brands, and lowercases the other Capitalized words.
const toSentence = [
  ["sc-punct", "Warm Jacket, Blue (Large)", "Warm jacket, blue (large)"],
  ["sc-apos", "Kids’ Winter Jacket", "Kids’ winter jacket"],
  ["sc-acronym", "USB Cable For Winter", "USB cable for winter"],
  ["sc-brand", "Wool Hat For iPhone Users", "Wool hat for iPhone users"],
  ["sc-lead", "(Winter) Jacket Blue", "(Winter) jacket blue"],
];
const sentenceCatalog = Array.from({ length: 18 }, (_, i) => clone(`sc-base-${i}`, { title: `Warm jacket for cold days ${i + 1}` }));
const sentenceRun = runRules([...sentenceCatalog, ...toSentence.map(([key, title]) => clone(key, { title }))], ctx);
for (const [key, title, want] of toSentence) {
  const got = suggestionFor(sentenceRun, key);
  check(`sentence case suggestion for "${title}"`, got === want, got === want ? "" : `got ${JSON.stringify(got)}`);
}
check("a title already in the majority style is not an outlier", !sentenceRun.some((f) => f.ruleId === "title_casing_outlier" && f.productId.includes("sc-base-")));

// Margins are judged in cents: a price exactly on the 10% line is not thin, one cent under is.
const priced = (key, price, cost) => clone(key, { variants: [{ ...base.variants[0], id: `gid://shopify/ProductVariant/${key}`, price, cost }] });
const marginRun = runRules([priced("m-edge", "1.00", "0.90"), priced("m-thin", "1.00", "0.91")], ctx);
const marginIds = (key) => marginRun.filter((f) => f.productId === `gid://shopify/Product/${key}`).map((f) => f.ruleId);
check("a 10% margin is not thin", !marginIds("m-edge").includes("thin_margin"), marginIds("m-edge").join(", "));
check("a 9% margin is thin", marginIds("m-thin").includes("thin_margin"), marginIds("m-thin").join(", "));

// The price suggested for a variant priced below cost clears the margin check, whatever the
// store's price ending.
for (const [ending, cost] of [["99", "100.00"], ["00", "0.90"], ["95", "57.30"], ["01", "0.91"]]) {
  const withEnding = { ...ctx, catalog: { ...catalogContext(products), priceEnding: ending } };
  const below = runRules([priced("m-below", "0.50", cost)], withEnding).find((f) => f.ruleId === "price_below_cost");
  const suggested = below?.edit?.suggested;
  const after = suggested ? runRules([priced("m-after", suggested, cost)], withEnding).filter((f) => f.productId.endsWith("m-after")).map((f) => f.ruleId) : [];
  const ok = Boolean(suggested) && suggested.endsWith(ending) && !after.includes("thin_margin") && !after.includes("price_below_cost");
  check(`price_below_cost with cost ${cost} and ending ${ending} suggests a price that clears the margin`, ok, `suggested=${suggested} after=[${after}]`);
}

// A product whose one media item is not an image says so.
const oneImage = products.find((p) => p.id.endsWith("/placeholder")).images[0];
const mediaRun = runRules([clone("video-only", { images: [], mediaCount: 1 }), clone("one-image", { images: [oneImage], mediaCount: 1 })], ctx);
const fewFor = (key) => mediaRun.find((f) => f.ruleId === "few_images" && f.productId.endsWith(`/${key}`));
check("few_images on a video-only product reads \"1 media item, no image\"", fewFor("video-only")?.current === "1 media item, no image", JSON.stringify(fewFor("video-only")?.current));
check("few_images on a one-image product reads \"1 image\"", fewFor("one-image")?.current === "1 image", JSON.stringify(fewFor("one-image")?.current));
check("a video-only product is not reported as having no image", !mediaRun.some((f) => f.ruleId === "missing_image" && f.productId.endsWith("/video-only")));

console.log(failed ? `${failed} FAILED` : "PASS");
process.exit(failed ? 1 : 0);
