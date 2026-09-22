import nspell from "nspell";

// The English dictionary loads once per server process and is reused.
let spellerPromise = null;

export function loadSpeller() {
  if (!spellerPromise) {
    spellerPromise = (async () => {
      const mod = await import("dictionary-en");
      const dict = mod.default ?? mod.dictionaryEn ?? mod;
      const loaded =
        typeof dict === "function"
          ? await new Promise((resolve, reject) =>
              dict((err, d) => (err ? reject(err) : resolve(d))),
            )
          : dict;
      return nspell({ aff: Buffer.from(loaded.aff), dic: Buffer.from(loaded.dic) });
    })();
  }
  return spellerPromise;
}

const WORD_RE = /[A-Za-z][A-Za-z']+/g;

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Every field on a product that a human wrote, with a label for the finding.
export function textFields(p) {
  const fields = [
    { field: "Title", key: "title", text: p.title || "", titleLike: true },
    { field: "Description", key: "descriptionHtml", text: stripHtml(p.descriptionHtml) },
    { field: "SEO title", key: "seoTitle", text: p.seoTitle || "", titleLike: true },
    { field: "SEO description", key: "seoDescription", text: p.seoDescription || "" },
    { field: "Vendor", key: "vendor", text: p.vendor || "" },
    { field: "Product type", key: "productType", text: p.productType || "" },
    { field: "Tags", key: "tags", text: (p.tags || []).join(" ") },
  ];
  for (const o of p.options || []) {
    fields.push({ field: `Option ${o.name}`, key: null, text: `${o.name} ${(o.values || []).join(" ")}` });
  }
  return fields;
}

// Returns [{ word, suggestion, field }] for words the dictionary does not know.
// Skips short words, mixed-case codes, and capitalized words (brands, names) in prose. Titles
// capitalize every word, so in a title or SEO title a capitalized word is checked too, unless the
// catalog uses it as a name (see catalogNames) or no known word is within two edits of it.
export function findMisspellings(fields, ctx) {
  const seen = new Set();
  const out = [];
  const names = ctx.nameWords || new Set();
  // Dictionary lookups, and suggestions above all, are the slow part of a scan, and the same unknown
  // words recur across a catalog, so results are kept for the whole scan (ctx lives that long).
  const cache = ctx.spellCache || (ctx.spellCache = new Map());
  for (const { field, key, text, titleLike } of fields) {
    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0];
      const lower = word.toLowerCase();
      if (word.length < 4) continue;
      if (seen.has(lower)) continue;
      if (/[A-Z]/.test(word.slice(1))) continue;
      if (ctx.customWords.has(lower)) continue;
      const capitalized = /^[A-Z]/.test(word);
      if (capitalized && (!titleLike || names.has(lower))) continue;
      const cacheKey = (capitalized ? "C:" : "w:") + word;
      let hit = cache.get(cacheKey);
      if (!hit) {
        hit = known(ctx.speller, word)
          ? { known: true, suggestion: null }
          : { known: false, suggestion: capitalized ? nearSuggestion(ctx.speller, word) : ctx.speller.suggest(word)[0] || null };
        cache.set(cacheKey, hit);
      }
      if (hit.known) continue;
      if (capitalized && !hit.suggestion) continue;
      seen.add(lower);
      out.push({ word, suggestion: hit.suggestion, field, key });
    }
  }
  return out;
}

function known(speller, word) {
  return speller.correct(word) || speller.correct(word.toLowerCase());
}

// The closest suggestion within two edits, or null: a misspelling sits near a real word, while a
// part, model or brand name the dictionary lacks usually does not.
function nearSuggestion(speller, word) {
  const lower = word.toLowerCase();
  let best = null;
  for (const s of speller.suggest(word).slice(0, 5)) {
    const d = distance(lower, s.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { s, d };
  }
  return best ? best.s : null;
}

// Damerau-Levenshtein distance (optimal string alignment).
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Words a title spell check must trust: capitalized title words the dictionary lacks that two or
// more products share (part, model and brand names rather than misspellings), plus every vendor.
// Stored with the scan so a recheck of a few products sees the same names the full scan did.
export function catalogNames(products, speller) {
  const count = new Map();
  const names = new Set();
  for (const p of products) {
    for (const m of (p.vendor || "").matchAll(WORD_RE)) names.add(m[0].toLowerCase());
    const mine = new Set();
    for (const text of [p.title || "", p.seoTitle || ""]) {
      for (const m of text.matchAll(WORD_RE)) {
        const w = m[0];
        if (w.length >= 4 && /^[A-Z][a-z']+$/.test(w)) mine.add(w.toLowerCase());
      }
    }
    for (const w of mine) count.set(w, (count.get(w) || 0) + 1);
  }
  for (const [w, n] of count) {
    if (n >= 2 && !known(speller, w[0].toUpperCase() + w.slice(1))) names.add(w);
  }
  return [...names].sort();
}

// Vendor names are brands, trust them automatically.
export function seedWords(products, extra = []) {
  const words = new Set(extra.map((w) => w.toLowerCase()));
  for (const p of products) {
    for (const m of (p.vendor || "").matchAll(WORD_RE)) words.add(m[0].toLowerCase());
  }
  return words;
}
