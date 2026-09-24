// What the app accepts from a form before it writes anything: a value for a field, and the key
// that names a finding. Everything else the browser sends is looked up server-side.
import { RULE_CATALOG } from "./rules.server";

const GID = /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_IDS = new Set(RULE_CATALOG.map((r) => r.id));

export const PRODUCT_STATUSES = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);
export const INVENTORY_POLICIES = new Set(["DENY", "CONTINUE"]);

const isGid = (v) => typeof v === "string" && GID.test(v);
const short = (v, max) => typeof v === "string" && v.length <= max;

// The fields of a finding that name it (see ignoreKey): a plain object with known, bounded parts,
// or null when the browser sent anything else.
export function findingKey(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { ruleId, productId, variantId, word, field } = raw;
  if (!RULE_IDS.has(ruleId) || !isGid(productId)) return null;
  if (variantId !== undefined && variantId !== null && variantId !== "" && !isGid(variantId)) return null;
  if (word !== undefined && word !== null && !short(word, 100)) return null;
  if (field !== undefined && field !== null && !short(field, 100)) return null;
  return { ruleId, productId, variantId: variantId || "", word: word || "", field: field || "" };
}

function moneyError(value, what, allowEmpty) {
  const v = String(value ?? "").trim();
  if (v === "") return allowEmpty ? null : `Enter a ${what}.`;
  return MONEY.test(v) ? null : `Enter a ${what} as a number with up to two decimals, for example 19.99.`;
}

function metafieldError(type, value) {
  const v = String(value ?? "");
  switch (type) {
    case "number_integer":
      return /^-?\d+$/.test(v.trim()) ? null : "Enter a whole number.";
    case "number_decimal":
      return /^-?\d+(\.\d+)?$/.test(v.trim()) ? null : "Enter a number.";
    case "boolean":
      return /^(true|false)$/i.test(v.trim()) ? null : "Enter true or false.";
    case "url":
      return /^https?:\/\/\S+$/i.test(v.trim()) ? null : "Enter a web address starting with http:// or https://.";
    case "date":
      return DATE.test(v.trim()) ? null : "Enter a date as YYYY-MM-DD.";
    case "date_time":
      return Number.isNaN(Date.parse(v.trim())) ? "Enter a date and time, for example 2026-09-23T10:00:00Z." : null;
    case "json":
      try {
        JSON.parse(v);
        return null;
      } catch {
        return "Enter valid JSON.";
      }
    case "single_line_text_field":
      if (/[\r\n]/.test(v)) return "A single-line field cannot contain line breaks.";
      return v.length <= 5000 ? null : "That value is too long.";
    default:
      return v.length <= 65535 ? null : "That value is too long.";
  }
}

// The reason a value cannot be written for an edit, or null when it can.
export function valueError(edit, value) {
  const v = value === undefined || value === null ? "" : String(value);
  switch (edit.kind) {
    case "product":
      if (edit.field === "title") return v.trim() ? (v.length <= 255 ? null : "The title can have up to 255 characters.") : "Enter a title.";
      if (edit.field === "status") return PRODUCT_STATUSES.has(v) ? null : "Choose active, draft or archived.";
      if (edit.field === "descriptionHtml") return v.length <= 65535 ? null : "The description is too long.";
      if (edit.field === "seoDescription") return v.length <= 1000 ? null : "The meta description can have up to 1,000 characters.";
      return v.length <= 255 ? null : "That value can have up to 255 characters.";
    case "word":
      if (!v.trim()) return "Enter the word to use instead.";
      return /[\r\n]/.test(v) || v.length > 100 ? "Enter a single word or a short phrase." : null;
    case "variant":
      if (edit.field === "price") return moneyError(v, "price", false);
      if (edit.field === "compareAt") return moneyError(v, "compare-at price", true);
      if (edit.field === "inventoryPolicy") return INVENTORY_POLICIES.has(v) ? null : "Choose whether to continue selling when out of stock.";
      return v.length <= 255 ? null : "That value can have up to 255 characters.";
    case "policy":
      return INVENTORY_POLICIES.has(v) ? null : "Choose whether to continue selling when out of stock.";
    case "weight": {
      const n = Number(v.trim());
      return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? null : "Enter a weight of zero or more.";
    }
    case "cost":
      return moneyError(v, "cost", true);
    case "inventory":
      return /^-?\d+$/.test(v.trim()) ? null : "Enter a whole number of items.";
    case "option":
      return v.trim() && v.length <= 255 ? null : "Enter an option value of up to 255 characters.";
    case "metafield":
      return metafieldError(edit.type, v);
    case "publish":
      return null;
    default:
      return "This finding cannot be edited here.";
  }
}
