// Catalog lint rules
// Each product rule returns findings for one product; catalog rules run once over all products.
// ctx carries the speller, the store dictionary, and store settings (approved vendors, tracked metafields).

import { findMisspellings, textFields } from "./spelling.server";
import { RULE_META } from "./checkGroups";

export { CATEGORIES } from "./categories";

const PLACEHOLDERS = ["lorem ipsum", "tbd", "coming soon", "placeholder", "description here", "insert description", "test product"];
const JUNK_PHRASES = ["click here", "buy now!!!", "best price guaranteed"];
const DAY = 24 * 60 * 60 * 1000;

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}
function norm(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s|-)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}
function isTitleCase(t) {
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length < 2) return null;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / words.length >= 0.8;
}

// Pictographs and flags, minus the copyright, registered and trademark signs that the Unicode
// property also covers.
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}/u;
const EN_STOPWORDS = ["the", "and", "with", "for", "this", "that", "your", "from", "are", "is", "of", "to", "in", "on", "it"];
// Common words of other languages: a description with none of these and no accented letters is
// most likely English with few stopwords (a spec list), not another language.
const FOREIGN_WORDS = new Set(["und", "der", "die", "das", "mit", "für", "nicht", "ist", "les", "des", "une", "pour", "avec", "est", "sur", "dans", "el", "los", "las", "para", "con", "del", "una", "por", "que", "il", "di", "che", "per", "non", "een", "het", "van", "voor", "niet", "zijn", "os", "um", "uma", "não", "com", "são", "och", "att", "det", "med"]);
function englishRatio(text) {
  const words = text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  if (words.length < 30) return null;
  const hits = words.filter((w) => EN_STOPWORDS.includes(w)).length;
  return hits / words.length;
}
function looksForeign(text) {
  const letters = text.replace(/[^\p{L}\s]/gu, "");
  if (/[^A-Za-z\s]/.test(letters)) return true; // an accented or non-Latin letter
  const hits = letters.toLowerCase().split(/\s+/).filter((w) => FOREIGN_WORDS.has(w)).length;
  return hits >= 2;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// GTIN-8/12/13/14 check digit (UPC and EAN are GTINs). Returns null for other formats: no opinion.
function gtinValid(code) {
  const digits = (code || "").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return null;
  const padded = digits.padStart(14, "0");
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(padded[13]);
}

// ---- what the issue page shows and offers ----
// An edit descriptor tells the issue page what a row is about: `current` is the human readable
// value in the Current value column ("" only when the field really is empty), `suggested` prefills
// the input, `raw` is the stored value a typed correction is compared with (defaults to current),
// and `apply` allows Quick apply, which saves `applyValue` (defaults to suggested) in one click.
// `applyLabel` names that button, `noInput` rows offer only buttons, and `choices` offer a small
// select of alternatives, each an edit of its own with its value.
const productEdit = (field, current, suggested = "", more = {}) => ({ kind: "product", field, current, suggested, ...more });
const variantEdit = (v, field, current, suggested = "", more = {}) => ({ kind: "variant", variantId: v.id, field, current, suggested, ...more });

// The first `n` characters, with an ellipsis when there are more.
function first(text, n) {
  const t = String(text || "").trim();
  return t.length > n ? `${t.slice(0, n).trim()}…` : t;
}
// The word where it sits: up to `span` characters either side of its first occurrence.
function around(text, word, span = 20) {
  const t = String(text || "");
  const w = String(word || "");
  const i = t.toLowerCase().indexOf(w.toLowerCase());
  if (i === -1) return first(t, 2 * span + 20);
  const start = Math.max(0, i - span);
  const end = Math.min(t.length, i + w.length + span);
  return `${start > 0 ? "…" : ""}${t.slice(start, end)}${end < t.length ? "…" : ""}`;
}
// Trimmed to at most `max` characters at a word boundary, without a dangling separator.
function trimAt(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const i = cut.lastIndexOf(" ");
  return (i > max * 0.6 ? cut.slice(0, i) : cut.slice(0, max)).replace(/[\s,;:.\-–]+$/, "");
}
// An amount as text: with the store currency (ctx.currency) where the merchant reads it, plain
// (two decimals) where it is a value to store or compare.
function money(n, ctx) {
  const amount = Number(n || 0);
  if (!ctx?.currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: ctx.currency }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}
// Edit distance between two values, for the closest of a few candidates.
function distance(a, b) {
  const s = norm(a);
  const t = norm(b);
  const prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (s[i - 1] === t[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[t.length];
}
// The candidate closest to a value, when it is close enough to be the same thing misspelled.
function closest(value, candidates) {
  let best = "";
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distance(value, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  const limit = Math.max(2, Math.floor(norm(value).length / 3));
  return bestDistance <= limit ? best : "";
}
// The smallest amount at or above `amount` whose cents are `ending` ("99", "00", ...).
function withEnding(amount, ending) {
  const cents = Number(ending) || 0;
  let candidate = Math.floor(Number(amount)) + cents / 100;
  if (candidate < Number(amount)) candidate += 1;
  return candidate.toFixed(2);
}
// The SKU a variant would get from its product handle and its own title: SNOWBOARD-BLUE.
function skuFor(p, v) {
  const part = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = part(p.handle) || part(p.title);
  const suffix = v.title && v.title !== "Default Title" ? part(v.title) : "";
  return suffix ? `${base}-${suffix}` : base;
}
// What the catalog as a whole suggests, computed once per run for the product rules: the price
// ending most prices use, the vendor most products have when it covers most of them, and the
// product type most products in each collection have.
function catalogContext(products) {
  const endings = new Map();
  const vendors = new Map();
  const byCollection = new Map();
  for (const p of products) {
    for (const v of p.variants || []) {
      const n = Number(v.price);
      if (n > 0) {
        const e = money(n).slice(-2);
        endings.set(e, (endings.get(e) || 0) + 1);
      }
    }
    const vendor = (p.vendor || "").trim();
    if (vendor) vendors.set(vendor, (vendors.get(vendor) || 0) + 1);
    const type = (p.productType || "").trim();
    for (const c of p.collectionIds || []) {
      if (!byCollection.has(c)) byCollection.set(c, new Map());
      if (type) byCollection.get(c).set(type, (byCollection.get(c).get(type) || 0) + 1);
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const priced = [...endings.values()].reduce((a, b) => a + b, 0);
  const priceEnding = priced >= 10 && top(endings) ? top(endings)[0] : "99";
  const vendorTop = products.length >= 10 ? top(vendors) : null;
  const commonVendor = vendorTop && vendorTop[1] / products.length > 0.6 ? vendorTop[0] : "";
  // A plain object, so the context can be stored with the scan and reused by rechecks.
  const typeByCollection = {};
  for (const [c, types] of byCollection) {
    const t = top(types);
    if (t && t[1] >= 3) typeByCollection[c] = t[0];
  }
  return { priceEnding, commonVendor, typeByCollection };
}
export { catalogContext };
const KG = { KILOGRAMS: 1, GRAMS: 0.001, POUNDS: 0.45359237, OUNCES: 0.028349523125 };
const toKg = (value, unit) => Number(value) * (KG[unit] ?? 1);
const FILENAME_ALT_RE = /\.(jpe?g|png|gif|webp|heic|tiff?|bmp|svg)$|^(img|dsc|dcim|pxl|dscn|screenshot|image|photo)[_ -]?\d+(\.\w{3,4})?$|^\d{4,}[_-]?\d*$/i;
const MIN_MARGIN = 0.1;
const MAX_PATTERN_INPUT = 1000; // characters of a metafield value a merchant pattern is tested on

function finding(rule, product, extra = {}) {
  const f = {
    ruleId: rule.id,
    label: rule.label,
    category: rule.category,
    severity: rule.severity,
    productId: product.id,
    productTitle: product.title,
    ...extra,
  };
  // The SKU the row is about: the variant for a variant finding, the only variant otherwise. A
  // product with several variants shows how many instead.
  const variants = product.variants || [];
  const v = f.variantId ? variants.find((x) => x.id === f.variantId) : variants.length === 1 ? variants[0] : null;
  if (v) {
    f.sku = v.sku || "";
    if (f.variantId) f.variantTitle = v.title || "";
  } else {
    f.variantCount = variants.length;
  }
  if (f.edit) {
    f.edit = { ruleId: rule.id, productId: product.id, title: product.title, ...f.edit };
    // A suggestion that only repeats the stored value (a description offered for editing) is not
    // stored twice: the page prefills the field from `raw` when `suggested` is absent.
    if (f.edit.suggested !== undefined && f.edit.raw !== undefined && f.edit.suggested === f.edit.raw) delete f.edit.suggested;
  }
  // Tracked metafield values ride along, for the columns on the issue pages.
  if (product.metafields?.length) f.meta = Object.fromEntries(product.metafields.map((m) => [m.key, m.value ?? ""]));
  return f;
}

// The most findings one check keeps per scan. Counts stay exact (they are taken before the cap);
// the issue page says when it shows the first of many.
export const MAX_FINDINGS_PER_RULE = 5000;
export function capFindings(findings) {
  const seen = new Map();
  const kept = [];
  for (const f of findings) {
    const n = (seen.get(f.ruleId) || 0) + 1;
    seen.set(f.ruleId, n);
    if (n <= MAX_FINDINGS_PER_RULE) kept.push(f);
  }
  return kept;
}

// ---------------- product rules ----------------

export const PRODUCT_RULES = [
  // Titles and copy
  {
    id: "missing_description", category: "description", label: "No description", severity: "high",
    check(p) {
      return wordCount(stripHtml(p.descriptionHtml)) === 0
        ? [finding(this, p, { edit: productEdit("descriptionHtml", "", "", { multiline: true }) })] : [];
    },
  },
  {
    id: "short_description", category: "description", label: "Description under 20 words", severity: "low",
    check(p) {
      const text = stripHtml(p.descriptionHtml);
      const words = wordCount(text);
      return words > 0 && words < 20
        ? [finding(this, p, { detail: `${words} words`, edit: productEdit("descriptionHtml", `${words} words: ${first(text, 80)}`, text, { raw: text, multiline: true }) })] : [];
    },
  },
  {
    id: "placeholder_text", category: "description", label: "Placeholder text", severity: "high",
    check(p) {
      const text = stripHtml(p.descriptionHtml);
      const inTitle = PLACEHOLDERS.find((ph) => p.title.toLowerCase().includes(ph));
      const hit = inTitle || PLACEHOLDERS.find((ph) => text.toLowerCase().includes(ph));
      if (!hit) return [];
      // The phrase where it sits, in the field that holds it.
      const edit = inTitle
        ? productEdit("title", around(p.title, hit), p.title, { raw: p.title })
        : productEdit("descriptionHtml", around(text, hit), text, { raw: text, multiline: true });
      return [finding(this, p, { detail: `"${hit}"`, edit })];
    },
  },
  {
    id: "spelling", category: "description", label: "Possible misspelling", severity: "medium",
    check(p, ctx) {
      if (!ctx?.speller) return [];
      const fields = textFields(p);
      return findMisspellings(fields, ctx, 8).map((m) => {
        const text = fields.find((f) => f.field === m.field)?.text || "";
        return finding(this, p, {
          word: m.word,
          detail: m.suggestion ? `"${m.word}" in ${m.field} (maybe "${m.suggestion}")` : `"${m.word}" in ${m.field}`,
          // The word where it sits; the dictionary suggestion is ready to replace it in one click.
          edit: m.key ? { kind: "word", field: m.key, word: m.word, current: around(text, m.word), raw: m.word, suggested: m.suggestion || "", apply: Boolean(m.suggestion) } : null,
        });
      });
    },
  },
  {
    id: "title_all_caps", category: "description", label: "Title is all caps", severity: "medium",
    check(p) {
      const letters = p.title.replace(/[^A-Za-z]/g, "");
      return letters.length >= 6 && letters === letters.toUpperCase()
        ? [finding(this, p, { edit: productEdit("title", p.title, titleCase(p.title), { apply: true }) })] : [];
    },
  },
  {
    id: "title_too_long", category: "description", label: "Title over 70 characters", severity: "low",
    check(p) {
      return p.title.length > 70
        ? [finding(this, p, { detail: `${p.title.length} characters`, edit: productEdit("title", `${p.title} (${p.title.length} characters)`, p.title, { raw: p.title }) })] : [];
    },
  },
  {
    id: "title_formatting", category: "description", label: "Title has stray spaces or punctuation", severity: "low",
    check(p) {
      const cleaned = p.title.replace(/\s{2,}/g, " ").trim().replace(/[.,;:!?-]+$/, "").trim();
      // Quoted, so the extra spaces and the stray punctuation show. A title that is nothing but
      // punctuation has no one-click correction: Shopify does not accept an empty title.
      return cleaned !== p.title
        ? [finding(this, p, { edit: productEdit("title", `"${p.title}"`, cleaned, { raw: p.title, apply: cleaned.length > 0 }) })] : [];
    },
  },
  {
    id: "description_is_title", category: "description", label: "Description just repeats the title", severity: "medium",
    check(p) {
      const text = stripHtml(p.descriptionHtml);
      const d = norm(text);
      return d && d === norm(p.title)
        ? [finding(this, p, { edit: productEdit("descriptionHtml", text, "", { raw: text, multiline: true }) })] : [];
    },
  },
  {
    id: "description_junk", category: "description", label: "Description has junk (raw URL, empty tags, spam phrases)", severity: "low",
    check(p) {
      const html = p.descriptionHtml || "";
      const plain = stripHtml(html);
      const text = plain.toLowerCase();
      const hits = [];
      const snippets = [];
      const url = /https?:\/\/\S+/i.exec(plain);
      if (url) {
        hits.push("raw URL");
        snippets.push(around(plain, url[0], 12));
      }
      if (/<(p|div|span|h\d)(\s[^>]*)?>(\s|&nbsp;|<br\s*\/?>)*<\/\1>/i.test(html)) {
        hits.push("empty tags");
        snippets.push("empty tags");
      }
      const phrase = JUNK_PHRASES.find((j) => text.includes(j));
      if (phrase) {
        hits.push(`"${phrase}"`);
        snippets.push(around(plain, phrase));
      }
      return hits.length
        ? [finding(this, p, { detail: hits.join(", "), edit: productEdit("descriptionHtml", snippets[0], plain, { raw: plain, multiline: true }) })] : [];
    },
  },

  {
    id: "description_too_long", category: "description", label: "Description over 2,000 words", severity: "low",
    check(p) {
      const words = wordCount(stripHtml(p.descriptionHtml));
      // Too long to correct in a row: the product page is the place for it.
      return words > 2000 ? [finding(this, p, { detail: `${words} words`, current: `${words.toLocaleString("en-US")} words` })] : [];
    },
  },
  {
    id: "language_mismatch", category: "description", label: "Description may not be in your store language", severity: "medium",
    check(p, ctx) {
      if (!(ctx?.locale || "en").startsWith("en")) return [];
      const text = stripHtml(p.descriptionHtml);
      const ratio = englishRatio(text);
      // A description in another language needs rewriting, not a quick correction. Few English
      // stopwords alone is not enough (a spec list has few too): it must also look foreign.
      return ratio !== null && ratio < 0.04 && looksForeign(text) ? [finding(this, p, { current: first(text, 80) })] : [];
    },
  },
  {
    id: "vendor_repeated_in_title", category: "description", label: "Vendor appears twice in title", severity: "low",
    check(p) {
      const v = norm(p.vendor);
      if (!v || v.length < 3) return [];
      // Whole words only: vendor "Art" is not in "Party Art Cart" twice.
      const re = new RegExp(`(^|[^a-z0-9])(${escapeRe(v).replace(/ /g, "\\s+")})(?=[^a-z0-9]|$)`, "gi");
      const hits = [...p.title.matchAll(re)];
      if (hits.length < 2) return [];
      const last = hits[hits.length - 1];
      const start = last.index + last[1].length;
      const suggested = (p.title.slice(0, start) + p.title.slice(start + last[2].length)).replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)])/g, "$1").trim();
      return [finding(this, p, { edit: productEdit("title", p.title, suggested, { apply: suggested.length > 0 }) })];
    },
  },
  {
    id: "emoji_in_title", category: "description", label: "Emoji in title", severity: "low",
    check(p) {
      if (!EMOJI_RE.test(p.title)) return [];
      const suggested = p.title.replace(new RegExp(EMOJI_RE.source, "gu"), "").replace(/\s{2,}/g, " ").trim();
      return [finding(this, p, { edit: productEdit("title", p.title, suggested, { apply: suggested.length > 0 }) })];
    },
  },

  // SEO
  {
    id: "seo_title_missing", category: "seo", label: "SEO title missing", severity: "medium",
    check(p) {
      return !p.seoTitle.trim()
        ? [finding(this, p, { edit: productEdit("seoTitle", "", trimAt(p.title, 60), { apply: true }) })] : [];
    },
  },
  {
    id: "seo_title_too_long", category: "seo", label: "SEO title over 60 characters", severity: "medium",
    check(p) {
      return p.seoTitle.length > 60
        ? [finding(this, p, { detail: `${p.seoTitle.length} characters`, edit: productEdit("seoTitle", `${p.seoTitle} (${p.seoTitle.length} characters)`, trimAt(p.seoTitle, 60), { raw: p.seoTitle, apply: true }) })] : [];
    },
  },
  {
    id: "meta_description_missing", category: "seo", label: "Meta description missing", severity: "low",
    check(p) {
      if (p.seoDescription.trim()) return [];
      const suggested = trimAt(stripHtml(p.descriptionHtml), 155);
      return [finding(this, p, { edit: productEdit("seoDescription", "", suggested, { apply: Boolean(suggested), multiline: true }) })];
    },
  },
  {
    id: "meta_description_too_long", category: "seo", label: "Meta description over 160 characters", severity: "low",
    check(p) {
      return p.seoDescription.length > 160
        ? [finding(this, p, { detail: `${p.seoDescription.length} characters`, edit: productEdit("seoDescription", p.seoDescription, trimAt(p.seoDescription, 160), { apply: true, multiline: true }) })] : [];
    },
  },
  {
    id: "handle_junk", category: "seo", label: "Messy URL handle", severity: "low",
    check(p) {
      const h = p.handle || "";
      // A trailing number is only suspicious when the title does not end with it (part numbers are fine).
      const tail = /-(\d+)$/.exec(h);
      const numbered = Boolean(tail) && !norm(p.title).replace(/[^a-z0-9]+$/, "").endsWith(tail[1]);
      const bad = /copy-of|untitled/.test(h) || /^\d+$/.test(h) || numbered;
      // Changing a handle breaks links, so the product page is the place for it.
      return bad ? [finding(this, p, { detail: `/${h}`, current: `/${h}` })] : [];
    },
  },

  {
    id: "meta_copies_description", category: "seo", label: "Meta description just copies the description", severity: "low",
    check(p) {
      const meta = norm(p.seoDescription);
      const desc = norm(stripHtml(p.descriptionHtml));
      if (!meta || meta.length < 40 || !desc) return [];
      return desc.startsWith(meta.replace(/\.{3}$/, "")) ? [finding(this, p, { edit: productEdit("seoDescription", p.seoDescription, "", { multiline: true }) })] : [];
    },
  },

  // Images
  {
    id: "missing_image", category: "media", label: "No product image", severity: "high",
    check(p) { return p.images.length === 0 ? [finding(this, p, { current: "No images" })] : []; },
  },
  {
    id: "few_images", category: "media", label: "Only one image", severity: "medium",
    check(p) { return p.images.length === 1 ? [finding(this, p, { current: "1 image" })] : []; },
  },
  {
    id: "missing_alt_text", category: "media", label: "Image has no alt text", severity: "medium",
    fixable: true, fixLabel: "Set alt text to product title",
    check(p) {
      const missing = p.images.filter((img) => !(img.alt || "").trim());
      return missing.length
        ? [finding(this, p, { detail: `${missing.length} of ${p.images.length} images`, edit: { kind: "alt", mediaIds: missing.map((m) => m.id), current: `${missing.length} of ${p.images.length} images without alt`, raw: "", suggested: p.title, apply: true } })]
        : [];
    },
  },
  {
    id: "same_alt_text", category: "media", label: "All images share the same alt text", severity: "low",
    check(p) {
      if (p.images.length < 2) return [];
      const alts = new Set(p.images.map((i) => (i.alt || "").trim()).filter(Boolean));
      if (!(alts.size === 1 && p.images.every((i) => (i.alt || "").trim()))) return [];
      const alt = [...alts][0];
      // Numbered: the value plus the image number on each image.
      return [finding(this, p, { detail: `"${alt}"`, edit: { kind: "alt", mediaIds: p.images.map((i) => i.id), numbered: true, current: alt, suggested: p.title, apply: true, applyLabel: "Number them" } })];
    },
  },
  {
    id: "small_image", category: "media", label: "Image under 800px", severity: "medium",
    check(p) {
      const small = p.images.filter((i) => i.width && i.height && Math.max(i.width, i.height) < 800);
      if (!small.length) return [];
      const smallest = Math.min(...small.map((i) => Math.max(i.width, i.height)));
      return [finding(this, p, { detail: `${small.length} image${small.length > 1 ? "s" : ""}, smallest ${smallest}px`, current: `${smallest}px` })];
    },
  },


  // Variants
  {
    id: "missing_sku", category: "inventory", label: "No SKU", severity: "high",
    check(p) {
      return p.variants.filter((v) => !(v.sku || "").trim())
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title, edit: variantEdit(v, "sku", "", skuFor(p, v), { apply: true }) }));
    },
  },
  {
    id: "missing_barcode", category: "inventory", label: "No barcode", severity: "low",
    check(p) {
      return p.variants.filter((v) => !(v.barcode || "").trim())
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title, edit: variantEdit(v, "barcode", "") }));
    },
  },
  {
    id: "missing_weight", category: "shipping", label: "No shipping weight", severity: "medium",
    check(p) {
      // A sibling with a weight lends its value and its unit (the empty variant has no unit of its own).
      const donor = p.variants.find((v) => v.weight > 0);
      return p.variants.filter((v) => !v.weight || v.weight <= 0).map((v) => {
        const unit = donor ? donor.weightUnit : v.weightUnit || "KILOGRAMS";
        return finding(this, p, {
          variantId: v.id, detail: v.title,
          edit: v.inventoryItemId
            ? { kind: "weight", inventoryItemId: v.inventoryItemId, unit, current: "0", suggested: donor ? String(donor.weight) : "", apply: Boolean(donor), hint: unit.toLowerCase() }
            : null,
        });
      });
    },
  },
  {
    id: "zero_price", category: "pricing", label: "No price set", severity: "high",
    check(p, ctx) {
      const siblings = p.variants.map((v) => Number(v.price)).filter((n) => n > 0);
      const suggested = siblings.length ? money(median(siblings)) : "";
      return p.variants.filter((v) => Number(v.price) === 0)
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title, edit: variantEdit(v, "price", money(0, ctx), suggested, { raw: "0", apply: Boolean(suggested) }) }));
    },
  },
  {
    id: "compare_at_not_higher", category: "pricing", label: "Sale price is not a discount", severity: "medium",
    fixable: true, fixLabel: "Clear the compare-at price",
    check(p, ctx) {
      return p.variants.filter((v) => v.compareAtPrice != null && Number(v.compareAtPrice) <= Number(v.price))
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: ${money(v.compareAtPrice, ctx)} vs ${money(v.price, ctx)}`, edit: variantEdit(v, "compareAt", `compare-at ${money(v.compareAtPrice, ctx)} vs price ${money(v.price, ctx)}`, "", { raw: String(v.compareAtPrice), apply: true, applyValue: "", applyLabel: "Clear compare-at price" }) }));
    },
  },
  {
    id: "missing_cost", category: "pricing", label: "No cost per item", severity: "low",
    check(p) {
      return p.variants.filter((v) => v.cost == null && v.inventoryItemId)
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title, edit: { kind: "cost", inventoryItemId: v.inventoryItemId, current: "", suggested: "" } }));
    },
  },
  {
    id: "price_below_cost", category: "pricing", label: "Price below cost", severity: "high",
    check(p, ctx) {
      const ending = ctx?.catalog?.priceEnding || "99";
      return p.variants.filter((v) => v.cost != null && Number(v.price) > 0 && Number(v.price) < Number(v.cost))
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: price ${money(v.price, ctx)}, cost ${money(v.cost, ctx)}`, edit: variantEdit(v, "price", `price ${money(v.price, ctx)}, cost ${money(v.cost, ctx)}`, withEnding(v.cost, ending), { raw: String(v.price), apply: true }) }));
    },
  },
  {
    id: "option_values_inconsistent", category: "variants", label: "Option values spelled two ways", severity: "medium",
    check(p) {
      const out = [];
      // How often each spelling appears in the variant titles decides the one to keep.
      const uses = new Map();
      for (const v of p.variants) for (const part of String(v.title || "").split(" / ")) uses.set(part, (uses.get(part) || 0) + 1);
      for (const o of p.options) {
        const groups = new Map();
        o.values.forEach((value, i) => {
          const k = norm(value);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push({ id: o.valueIds?.[i], name: value });
        });
        for (const [, values] of groups) {
          if (values.length < 2) continue;
          const names = values.map((x) => x.name);
          const keep = [...names].sort((a, b) => (uses.get(b) || 0) - (uses.get(a) || 0))[0];
          const withIds = o.id && values.every((x) => x.id);
          out.push(finding(this, p, {
            detail: `${o.name}: ${names.join(" / ")}`,
            edit: withIds ? { kind: "option", optionId: o.id, values, current: names.join(" / "), raw: names.join(" / "), suggested: keep, apply: true, applyLabel: `Use ${keep}` } : null,
          }));
        }
      }
      return out;
    },
  },
  {
    id: "too_many_variants", category: "variants", label: "More than 100 variants", severity: "low",
    check(p) { return p.variantsCount > 100 ? [finding(this, p, { detail: `${p.variantsCount} variants`, current: `${p.variantsCount} variants` })] : []; },
  },

  // Pricing
  {
    id: "price_outlier", category: "pricing", label: "One variant priced far from the others", severity: "medium",
    check(p, ctx) {
      // Three priced variants at least: with two there is no majority to be far from.
      const prices = p.variants.map((v) => Number(v.price)).filter((n) => n > 0);
      if (prices.length < 3) return [];
      const med = median(prices);
      return p.variants
        .filter((v) => Number(v.price) > 0 && (Number(v.price) > med * 5 || Number(v.price) < med / 5))
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: ${money(v.price, ctx)}, others around ${money(med, ctx)}`, edit: variantEdit(v, "price", `${money(v.price, ctx)}, others around ${money(med, ctx)}`, money(med), { raw: String(v.price), apply: true }) }));
    },
  },
  {
    id: "stale_sale", category: "pricing", label: "On sale for more than 90 days", severity: "low",
    check(p, ctx) {
      return p.variants
        .filter((v) => v.compareAtPrice != null && Number(v.compareAtPrice) > Number(v.price) && (Date.now() - new Date(v.updatedAt).getTime()) / DAY > 90)
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: ${money(v.price, ctx)} was ${money(v.compareAtPrice, ctx)}`, edit: variantEdit(v, "compareAt", `on sale since ${String(v.updatedAt).slice(0, 10)}`, "", { raw: String(v.compareAtPrice), apply: true, applyValue: "", applyLabel: "End sale" }) }));
    },
  },

  // Inventory and status
  {
    id: "draft_stale", category: "status", label: "Draft for more than 30 days", severity: "low",
    check(p) {
      // Since the last change (a lower bound: setting a product to draft changes it), not since creation.
      const age = (Date.now() - new Date(p.updatedAt || p.createdAt).getTime()) / DAY;
      if (!(p.status === "DRAFT" && age > 30)) return [];
      const days = Math.round(age);
      return [finding(this, p, {
        detail: `${days} days`,
        edit: { kind: "choice", current: `Draft for ${days} days`, noInput: true, choices: [
          { label: "Set to active", kind: "product", field: "status", value: "ACTIVE" },
          { label: "Archive", kind: "product", field: "status", value: "ARCHIVED" },
        ] },
      })];
    },
  },
  {
    id: "active_no_stock", category: "inventory", label: "Active with nothing in stock", severity: "medium",
    check(p) {
      if (p.status !== "ACTIVE") return [];
      const tracked = p.variants.some((v) => v.tracked);
      const canSell = p.variants.some((v) => v.inventoryPolicy === "CONTINUE");
      if (!(tracked && !canSell && p.totalInventory <= 0)) return [];
      return [finding(this, p, {
        // The policy choice names no variant ids: every variant of the product is read when it is applied.
        edit: { kind: "choice", current: "Quantity 0, does not continue selling", noInput: true, choices: [
          { label: "Set to draft", kind: "product", field: "status", value: "DRAFT" },
          { label: "Continue selling when out of stock", kind: "policy", value: "CONTINUE" },
        ] },
      })];
    },
  },
  {
    id: "no_collection", category: "organization", label: "Not in any collection", severity: "low",
    check(p) { return p.status === "ACTIVE" && p.collectionCount === 0 ? [finding(this, p, { current: "0 collections" })] : []; },
  },
  {
    id: "not_published", category: "publishing", label: "Not visible on your store", severity: "high",
    // Published somewhere but not on the Online Store; a product on no channel at all is
    // unpublished_everywhere instead.
    check(p) {
      return p.status === "ACTIVE" && !p.publishedAt && (p.publications == null || p.publications > 0)
        ? [finding(this, p, { edit: { kind: "publish", current: "Unpublished", suggested: "Online Store", apply: true, applyLabel: "Publish to Online Store", noInput: true } })] : [];
    },
  },

  {
    id: "negative_inventory", category: "inventory", label: "Negative inventory", severity: "medium",
    check(p) {
      return p.variants.filter((v) => v.tracked && v.inventoryQuantity < 0)
        .map((v) => finding(this, p, {
          variantId: v.id, detail: `${v.title}: ${v.inventoryQuantity}`,
          edit: v.inventoryItemId ? { kind: "inventory", inventoryItemId: v.inventoryItemId, current: String(v.inventoryQuantity), suggested: "0", apply: true } : null,
        }));
    },
  },
  {
    id: "no_location", category: "inventory", label: "Tracked variant with no location", severity: "medium",
    check(p) {
      return p.variants.filter((v) => v.tracked && v.locations === 0)
        .map((v) => finding(this, p, { variantId: v.id, detail: v.title, current: "Not stocked at any location" }));
    },
  },

  // Organization
  {
    id: "missing_vendor", category: "organization", label: "No vendor", severity: "medium",
    check(p, ctx) {
      if ((p.vendor || "").trim()) return [];
      // The vendor most of the catalog has, when one covers most of it.
      const common = ctx?.catalog?.commonVendor || "";
      return [finding(this, p, { edit: productEdit("vendor", "", common, { apply: Boolean(common) }) })];
    },
  },
  {
    id: "missing_product_type", category: "organization", label: "No product type", severity: "medium",
    check(p, ctx) {
      if ((p.productType || "").trim()) return [];
      // The type most products in the same collection have.
      const common = (p.collectionIds || []).map((c) => ctx?.catalog?.typeByCollection?.[c]).find(Boolean) || "";
      return [finding(this, p, { edit: productEdit("productType", "", common, { apply: Boolean(common) }) })];
    },
  },
  {
    id: "no_tags", category: "organization", label: "No tags", severity: "low",
    check(p) { return p.tags.length === 0 ? [finding(this, p, { edit: productEdit("tags", "") })] : []; },
  },
  {
    id: "vendor_not_allowed", category: "organization", label: "Vendor not on your approved list", severity: "low",
    applies: (settings) => (settings.vendorWhitelist || []).length > 0,
    check(p, ctx) {
      const list = ctx?.settings?.vendorWhitelist || [];
      if (!list.length) return [];
      const v = (p.vendor || "").trim();
      if (!v) return [];
      const ok = list.some((w) => norm(w) === norm(v));
      if (ok) return [];
      // The closest approved vendor, ready to apply when one is close enough.
      const near = closest(v, list);
      return [finding(this, p, { detail: v, edit: productEdit("vendor", v, near, { apply: Boolean(near) }) })];
    },
  },

];

// ---------------- catalog rules ----------------

export const CATALOG_RULES = [
  {
    id: "duplicate_sku", category: "inventory", label: "Duplicate SKU", severity: "high",
    check(products) {
      const bySku = new Map();
      for (const p of products) for (const v of p.variants) {
        const sku = (v.sku || "").trim();
        if (!sku) continue;
        if (!bySku.has(sku)) bySku.set(sku, []);
        bySku.get(sku).push({ p, v });
      }
      const out = [];
      for (const [sku, hits] of bySku) {
        if (hits.length < 2) continue;
        // The first keeps the SKU; the others get a numbered suffix.
        hits.forEach(({ p, v }, i) => {
          const suggested = i === 0 ? sku : `${sku}-${i + 1}`;
          out.push(finding(this, p, { variantId: v.id, detail: `${v.title}: ${sku} used ${hits.length} times`, edit: variantEdit(v, "sku", `${sku} used ${hits.length} times`, suggested, { raw: sku, apply: i > 0 }) }));
        });
      }
      return out;
    },
  },
  {
    id: "duplicate_title", category: "seo", label: "Duplicate product title", severity: "medium",
    check(products) {
      const byTitle = new Map();
      for (const p of products) {
        const k = norm(p.title);
        if (!byTitle.has(k)) byTitle.set(k, []);
        byTitle.get(k).push(p);
      }
      const out = [];
      for (const [, hits] of byTitle) if (hits.length > 1) for (const p of hits) out.push(finding(this, p, { detail: `${hits.length} products`, edit: productEdit("title", `${p.title} · ${hits.length} products`, p.title, { raw: p.title }) }));
      return out;
    },
  },
  {
    id: "duplicate_description", category: "description", label: "Same description on many products", severity: "low",
    check(products) {
      const byDesc = new Map();
      for (const p of products) {
        const k = norm(stripHtml(p.descriptionHtml));
        if (!k || k.length < 40) continue;
        if (!byDesc.has(k)) byDesc.set(k, []);
        byDesc.get(k).push(p);
      }
      const out = [];
      for (const [, hits] of byDesc) {
        if (hits.length < 3) continue;
        for (const p of hits) {
          const text = stripHtml(p.descriptionHtml);
          out.push(finding(this, p, { detail: `shared by ${hits.length} products`, edit: productEdit("descriptionHtml", `${first(text, 80)} · shared by ${hits.length}`, text, { raw: text, multiline: true }) }));
        }
      }
      return out;
    },
  },
  {
    id: "title_casing_outlier", category: "description", label: "Title casing inconsistent", severity: "low",
    check(products) {
      const styles = products.map((p) => ({ p, tc: isTitleCase(p.title) })).filter((x) => x.tc !== null);
      if (styles.length < 10) return [];
      const share = styles.filter((x) => x.tc).length / styles.length;
      const majorityTitleCase = share >= 0.75 ? true : share <= 0.25 ? false : null;
      if (majorityTitleCase === null) return [];
      return styles.filter((x) => x.tc !== majorityTitleCase).map(({ p }) =>
        finding(this, p, {
          detail: majorityTitleCase ? "most titles use Title Case" : "most titles use sentence case",
          edit: productEdit("title", p.title, majorityTitleCase ? titleCase(p.title) : p.title.charAt(0).toUpperCase() + p.title.slice(1).toLowerCase(), { apply: true }),
        }),
      );
    },
  },
  {
    id: "vendor_casing", category: "organization", label: "Vendor spelled two ways", severity: "medium",
    fixable: true, fixLabel: "Use the most common spelling",
    check(products) {
      const groups = new Map();
      for (const p of products) {
        const raw = (p.vendor || "").trim();
        if (!raw) continue;
        const key = norm(raw);
        if (!groups.has(key)) groups.set(key, new Map());
        const counts = groups.get(key);
        counts.set(raw, (counts.get(raw) || 0) + 1);
      }
      // The most common spelling of each mixed group wins; only the other spellings are reported,
      // in one pass over the products.
      const canonical = new Map();
      for (const [key, counts] of groups) {
        if (counts.size < 2) continue;
        canonical.set(key, { keep: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0], spellings: [...counts.keys()] });
      }
      if (!canonical.size) return [];
      const out = [];
      for (const p of products) {
        const raw = (p.vendor || "").trim();
        const group = raw ? canonical.get(norm(raw)) : null;
        if (!group || raw === group.keep) continue;
        out.push(finding(this, p, { detail: group.spellings.join(" / "), edit: productEdit("vendor", raw, group.keep, { apply: true }) }));
      }
      return out;
    },
  },
];

CATALOG_RULES.push(
  {
    id: "seo_title_competing", category: "seo", label: "Two products share an SEO title", severity: "low",
    check(products) {
      const by = new Map();
      for (const p of products) {
        const k = norm(p.seoTitle);
        if (!k) continue;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(p);
      }
      const out = [];
      for (const [, hits] of by) {
        if (hits.length < 2) continue;
        for (const p of hits) {
          const suggested = trimAt(p.title, 60);
          out.push(finding(this, p, { detail: `${hits.length} products`, edit: productEdit("seoTitle", p.seoTitle, suggested, { apply: norm(suggested) !== norm(p.seoTitle) }) }));
        }
      }
      return out;
    },
  },
  {
    id: "tag_casing", category: "organization", label: "Tag spelled two ways", severity: "low",
    check(products) {
      const groups = new Map();
      for (const p of products) for (const t of p.tags) {
        const k = norm(t);
        if (!groups.has(k)) groups.set(k, new Map());
        groups.get(k).set(t, (groups.get(k).get(t) || 0) + 1);
      }
      const canon = new Map();
      for (const [k, variants] of groups) if (variants.size > 1) canon.set(k, [...variants.entries()].sort((a, b) => b[1] - a[1])[0][0]);
      if (!canon.size) return [];
      const out = [];
      for (const p of products) {
        const fixed = p.tags.map((t) => canon.get(norm(t)) || t);
        if (fixed.join("|") !== p.tags.join("|")) {
          const changed = p.tags.filter((t, i) => t !== fixed[i]);
          out.push(finding(this, p, { detail: changed.join(", "), edit: productEdit("tags", changed.join(", "), fixed.join(", "), { raw: p.tags.join(", "), apply: true }) }));
        }
      }
      return out;
    },
  },
);

PRODUCT_RULES.push(
  // Titles and copy
  {
    id: "dead_link", category: "description", label: "Dead link in description", severity: "low",
    check(p) {
      const tags = (p.descriptionHtml || "").match(/<a\b[^>]*>/gi) || [];
      // A named anchor without an href is a target, not a link.
      const links = tags.filter((tag) => /\bhref\s*=/i.test(tag) || !/\b(name|id)\s*=/i.test(tag));
      const hrefOf = (tag) => {
        const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
      };
      const dead = links.filter((tag) => {
        const href = hrefOf(tag);
        return !href || /^(#|javascript:)/i.test(href);
      });
      return dead.length ? [finding(this, p, { detail: `${dead.length} of ${links.length} links`, current: `${dead.length} of ${links.length} links` })] : [];
    },
  },

  // Images
  {
    id: "alt_is_filename", category: "media", label: "Alt text is a filename", severity: "low",
    check(p) {
      const hits = p.images.filter((i) => FILENAME_ALT_RE.test((i.alt || "").trim()));
      if (!hits.length) return [];
      const firstAlt = hits[0].alt.trim();
      // Each image gets its own value on Quick apply: the title, numbered when several images need one.
      const perImage = hits.map((i, n) => ({ id: i.id, raw: i.alt.trim(), suggested: hits.length > 1 ? `${p.title} ${n + 1}` : p.title }));
      return [finding(this, p, {
        detail: `"${firstAlt}"${hits.length > 1 ? ` and ${hits.length - 1} more` : ""}`,
        edit: { kind: "alt", mediaIds: hits.map((i) => i.id), perImage, current: firstAlt, suggested: perImage[0].suggested, apply: true },
      })];
    },
  },
  {
    id: "alt_too_long", category: "media", label: "Alt text over 125 characters", severity: "low",
    check(p) {
      const hits = p.images.filter((i) => (i.alt || "").trim().length > 125);
      if (!hits.length) return [];
      const firstAlt = hits[0].alt.trim();
      // Each image keeps its own text, trimmed, on Quick apply.
      const perImage = hits.map((i) => ({ id: i.id, raw: i.alt.trim(), suggested: trimAt(i.alt.trim(), 125) }));
      return [finding(this, p, {
        detail: `${hits.length} of ${p.images.length} images, longest ${Math.max(...hits.map((i) => i.alt.trim().length))} characters`,
        edit: { kind: "alt", mediaIds: hits.map((i) => i.id), perImage, current: firstAlt, suggested: perImage[0].suggested, apply: true },
      })];
    },
  },

  // Variants and inventory
  {
    id: "barcode_invalid", category: "inventory", label: "Barcode fails its check digit", severity: "high",
    check(p) {
      return p.variants.filter((v) => gtinValid(v.barcode) === false)
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: ${v.barcode}`, edit: variantEdit(v, "barcode", v.barcode, "") }));
    },
  },

  // Pricing
  {
    id: "thin_margin", category: "pricing", label: "Margin under 10%", severity: "medium",
    check(p, ctx) {
      const margin = (v) => (Number(v.price) - Number(v.cost)) / Number(v.price);
      return p.variants
        .filter((v) => v.cost != null && Number(v.price) > 0 && Number(v.price) >= Number(v.cost) && margin(v) < MIN_MARGIN)
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: price ${money(v.price, ctx)}, cost ${money(v.cost, ctx)} (${Math.round(margin(v) * 100)}% margin)`, edit: variantEdit(v, "price", `price ${money(v.price, ctx)}, cost ${money(v.cost, ctx)} (${Math.round(margin(v) * 100)}% margin)`, "", { raw: String(v.price) }) }));
    },
  },
  {
    id: "deep_discount", category: "pricing", label: "Discount over 80%", severity: "medium",
    check(p, ctx) {
      const off = (v) => 1 - Number(v.price) / Number(v.compareAtPrice);
      return p.variants
        .filter((v) => v.compareAtPrice != null && Number(v.price) > 0 && Number(v.compareAtPrice) > Number(v.price) && off(v) > 0.8)
        .map((v) => finding(this, p, { variantId: v.id, detail: `${v.title}: ${money(v.price, ctx)} was ${money(v.compareAtPrice, ctx)} (${Math.round(off(v) * 100)}% off)`, edit: variantEdit(v, "compareAt", `${money(v.price, ctx)} was ${money(v.compareAtPrice, ctx)} (${Math.round(off(v) * 100)}% off)`, "", { raw: String(v.compareAtPrice) }) }));
    },
  },

  // Shipping

);

CATALOG_RULES.push(
  {
    id: "duplicate_barcode", category: "inventory", label: "Duplicate barcode", severity: "high",
    check(products) {
      const by = new Map();
      for (const p of products) for (const v of p.variants) {
        const b = (v.barcode || "").trim();
        if (!b) continue;
        if (!by.has(b)) by.set(b, []);
        by.get(b).push({ p, v });
      }
      const out = [];
      for (const [b, hits] of by) {
        if (hits.length < 2) continue;
        for (const { p, v } of hits) out.push(finding(this, p, { variantId: v.id, detail: `${v.title}: ${b} used ${hits.length} times`, edit: variantEdit(v, "barcode", `${b} used ${hits.length} times`, b, { raw: b }) }));
      }
      return out;
    },
  },
  {
    id: "product_type_casing", category: "organization", label: "Product type spelled two ways", severity: "low",
    check(products) {
      const groups = new Map();
      for (const p of products) {
        const raw = (p.productType || "").trim();
        if (!raw) continue;
        const k = norm(raw);
        if (!groups.has(k)) groups.set(k, new Map());
        groups.get(k).set(raw, (groups.get(k).get(raw) || 0) + 1);
      }
      const canonical = new Map();
      for (const [key, counts] of groups) {
        if (counts.size < 2) continue;
        canonical.set(key, { keep: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0], spellings: [...counts.keys()] });
      }
      if (!canonical.size) return [];
      const out = [];
      for (const p of products) {
        const raw = (p.productType || "").trim();
        const group = raw ? canonical.get(norm(raw)) : null;
        if (!group || raw === group.keep) continue;
        out.push(finding(this, p, { detail: group.spellings.join(" / "), edit: productEdit("productType", raw, group.keep, { apply: true }) }));
      }
      return out;
    },
  },
  {
    id: "weight_units_mixed", category: "shipping", label: "Mixed weight units", severity: "low",
    check(products) {
      const counts = new Map();
      for (const p of products) for (const v of p.variants) if (v.weight > 0) counts.set(v.weightUnit, (counts.get(v.weightUnit) || 0) + 1);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      if (counts.size < 2 || total < 10) return [];
      const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (counts.get(majority) / total < 0.8) return []; // no clear convention to enforce
      const out = [];
      for (const p of products) for (const v of p.variants) {
        if (!(v.weight > 0) || v.weightUnit === majority) continue;
        out.push(finding(this, p, {
          variantId: v.id, detail: `${v.title}: ${v.weight} ${v.weightUnit.toLowerCase()}, most use ${majority.toLowerCase()}`,
          edit: v.inventoryItemId
            ? { kind: "weight", inventoryItemId: v.inventoryItemId, unit: majority, current: `${v.weight} ${v.weightUnit.toLowerCase()}`, raw: String(v.weight), suggested: (toKg(v.weight, v.weightUnit) / KG[majority]).toFixed(2), apply: true, hint: majority.toLowerCase() }
            : null,
        }));
      }
      return out;
    },
  },
);

PRODUCT_RULES.push(
  // Product category: Shopify's standard product taxonomy, which search, filters, tax and
  // marketplaces read.
  {
    id: "category_missing", category: "organization", label: "No product category", severity: "medium",
    check(p) { return p.category ? [] : [finding(this, p, { current: "" })]; },
  },

  // Sales channels
  {
    id: "unpublished_everywhere", category: "publishing", label: "Not on any sales channel", severity: "high",
    check(p) {
      return p.status === "ACTIVE" && p.publications === 0
        ? [finding(this, p, { edit: { kind: "publish", current: "On no sales channel", suggested: "Online Store", apply: true, applyLabel: "Publish to Online Store", noInput: true } })] : [];
    },
  },
  {
    id: "channel_feedback", category: "publishing", label: "A sales channel reports a problem", severity: "high",
    check(p) {
      if (p.channelIssues?.length) {
        return p.channelIssues.map((c) => finding(this, p, { detail: `${c.app}: ${c.messages[0] || "needs attention"}`, current: `${c.app}: ${c.messages[0] || "needs attention"}` }));
      }
      // Channels do not always expose their feedback text; a publication with errors still drops
      // out of the error-free count.
      const broken = p.publications != null && p.publicationsOk != null ? p.publications - p.publicationsOk : 0;
      return broken > 0 ? [finding(this, p, { detail: `${broken} of ${p.publications} channels`, current: `${broken} of ${p.publications} channels with errors` })] : [];
    },
  },
);


// ---------------- tracked metafields ----------------
// The tracked metafields (settings.trackedMetafields) are read with every product; two checks
// cover them, each finding naming the metafield.
function trackedValue(p, t) {
  return (p.metafields || []).find((m) => m.key === t.fullKey)?.value ?? "";
}
function appliesTo(p, t) {
  return !t.productType || norm(t.productType) === norm(p.productType);
}
function metafieldEdit(t, more = {}) {
  return { kind: "metafield", key: t.fullKey, type: t.type, current: "", suggested: "", ...more };
}
PRODUCT_RULES.push(
  {
    id: "metafield_required", category: "metafields", label: "Required metafield missing", severity: "medium",
    applies: (settings) => (settings.trackedMetafields || []).some((t) => t.required),
    check(p, ctx) {
      const out = [];
      for (const t of ctx?.settings?.trackedMetafields || []) {
        if (!t.required || !appliesTo(p, t)) continue;
        // `field` keeps two empty metafields on one product apart for ignores and saved marks.
        if (!String(trackedValue(p, t)).trim()) out.push(finding(this, p, { field: t.fullKey, detail: t.name, edit: metafieldEdit(t) }));
      }
      return out;
    },
  },
  {
    id: "metafield_pattern", category: "metafields", label: "Metafield does not match pattern", severity: "medium",
    applies: (settings) => (settings.trackedMetafields || []).some((t) => t.pattern),
    check(p, ctx) {
      const out = [];
      // Each pattern is compiled once per run (ctx.patterns) and tested on a bounded slice of the value.
      const cache = ctx?.patterns || new Map();
      for (const t of ctx?.settings?.trackedMetafields || []) {
        if (!t.pattern || !appliesTo(p, t)) continue;
        if (!cache.has(t.pattern)) {
          try { cache.set(t.pattern, new RegExp(t.pattern)); } catch { cache.set(t.pattern, null); }
        }
        const re = cache.get(t.pattern);
        if (!re) continue;
        const v = String(trackedValue(p, t));
        if (v.trim() && !re.test(v.slice(0, MAX_PATTERN_INPUT))) out.push(finding(this, p, { field: t.fullKey, detail: `${t.name} = "${v.slice(0, 40)}"`, edit: metafieldEdit(t, { current: v }) }));
      }
      return out;
    },
  },
);

export const ALL_RULES = [...PRODUCT_RULES, ...CATALOG_RULES];

// Findings whose check still exists: a stored result can carry findings of a check that has since
// been removed, and no summary or page should count those.
const KNOWN_RULE_IDS = new Set(ALL_RULES.map((r) => r.id));
export function knownFindings(findings) {
  return findings.filter((f) => KNOWN_RULE_IDS.has(f.ruleId));
}

// What the Settings page needs to offer a switch per check: the rule plus its family and tier.
export const RULE_CATALOG = ALL_RULES.map((r) => ({
  id: r.id, label: r.label, category: r.category, severity: r.severity,
  family: RULE_META[r.id]?.family || "other", tier: RULE_META[r.id]?.tier || "recommended",
}));

// The rules the merchant has not turned off in Settings (settings.disabledRules).
function enabled(rules, ctx) {
  const off = new Set(ctx?.settings?.disabledRules || []);
  return off.size ? rules.filter((r) => !off.has(r.id)) : rules;
}

export function runRules(products, ctx = {}) {
  const findings = [];
  // What the catalog as a whole suggests (catalogContext) rides along for the product rules; the
  // caller may pass one computed earlier. Merchant patterns compile once per run.
  const run = { ...ctx, catalog: ctx.catalog || catalogContext(products), patterns: new Map() };
  const productRules = enabled(PRODUCT_RULES, run);
  for (const p of products) for (const rule of productRules) findings.push(...rule.check(p, run));
  for (const rule of enabled(CATALOG_RULES, run)) findings.push(...rule.check(products, run));
  return findings;
}

// Product rules only, for re-checking a handful of products without reading the whole catalog.
// ctx.catalog should be the context stored with the scan, so suggestions match the full scan.
export function runProductRules(products, ctx = {}) {
  const findings = [];
  const run = { ...ctx, catalog: ctx.catalog || catalogContext(products), patterns: new Map() };
  const productRules = enabled(PRODUCT_RULES, run);
  for (const p of products) for (const rule of productRules) findings.push(...rule.check(p, run));
  return findings;
}
export const CATALOG_RULE_IDS = new Set(CATALOG_RULES.map((r) => r.id));
const RULE_BY_ID = new Map(ALL_RULES.map((r) => [r.id, r]));

const WEIGHT = { high: 3, medium: 1.5, low: 0.5 };
const MAX_PENALTY_PER_PRODUCT = 10;

// Rules with an `applies(settings)` guard need something configured in Settings; when it is empty
// they are reported as skipped rather than passed.
export function summarize(products, findings, settings = {}) {
  return summarizeFindings(products.length, findings, settings);
}

// The same summary from a product count instead of the products themselves, so a stored scan can
// be re-summarized after an incremental refresh. Products without findings count as clean.
export function summarizeFindings(total, findings, settings = {}) {
  const byRule = {};
  const penalty = new Map();
  for (const f of findings) {
    // The rule as it is now, not as it was when the finding was stored: labels and severities can change.
    const rule = RULE_BY_ID.get(f.ruleId);
    const severity = rule?.severity || f.severity;
    if (!byRule[f.ruleId]) {
      byRule[f.ruleId] = {
        ruleId: f.ruleId, label: rule?.label || f.label, category: rule?.category || f.category || "description", severity,
        fixable: Boolean(rule?.fixable), fixLabel: rule?.fixLabel || null, count: 0,
      };
    }
    byRule[f.ruleId].count += 1;
    penalty.set(f.productId, (penalty.get(f.productId) || 0) + (WEIGHT[severity] ?? 0));
  }
  let sum = 0;
  for (const pen of penalty.values()) sum += Math.min(MAX_PENALTY_PER_PRODUCT, pen);
  const clean = Math.max(0, total - penalty.size);
  const score = Math.max(0, Math.round(100 - (total ? sum / total : 0) * 10));
  const order = { high: 0, medium: 1, low: 2 };
  const rules = Object.values(byRule).sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  // Every rule, so the overview can show what was checked and not only what failed: failed, passed,
  // skipped (needs a Setting that is empty) or off (turned off in Settings).
  const off = new Set(settings.disabledRules || []);
  const checks = ALL_RULES.map((rule) => ({
    ruleId: rule.id, label: rule.label, category: rule.category, severity: rule.severity,
    count: byRule[rule.id]?.count || 0,
    status: byRule[rule.id] ? "failed" : off.has(rule.id) ? "off" : rule.applies && !rule.applies(settings) ? "skipped" : "passed",
  }));
  return { score, total, clean, rules, checks };
}
