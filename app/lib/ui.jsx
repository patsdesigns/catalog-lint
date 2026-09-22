// Presentational pieces shared by the home and issue pages. Client-safe: no server imports.
import { categoryOf } from "./categories";
import { PASS_LABELS } from "./checkLabels";

export const TONE = { high: "critical", medium: "warning", low: "neutral" };

// Short names for the bulk fixes, used in notices and the Recent Fixes card.
const RULE_LABELS = {
  vendor_casing: "Vendor spelling",
  missing_weight: "Shipping weight",
  missing_alt_text: "Image alt text",
  compare_at_not_higher: "Sale price",
  zero_price: "Price",
  missing_sku: "SKU",
  duplicate_sku: "Duplicate SKU",
};
export function ruleLabel(id) {
  return RULE_LABELS[id] || id.replace(/_/g, " ");
}

// Passing-state sentence for a rule: "Passes when every product has a description."
export function passesWhen(ruleId, fallback) {
  const label = PASS_LABELS[ruleId] || fallback;
  // The first letter is lowercased unless the label opens with an acronym (SKUs, SEO, URL).
  return `Passes when ${/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}.`;
}

// Polaris has no primitive that takes an arbitrary hex color, and the category colors mirror the
// Shopify product page (app/lib/categories.js), so the dot is the one place that uses an inline
// style for color. The label next to it stays in the default text color for AA contrast.
export function Dot({ color, size = 10 }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color, flexShrink: 0 }}
    />
  );
}

export function CategoryChip({ id, color = "base" }) {
  const cat = categoryOf(id);
  return (
    <s-grid gridTemplateColumns="auto auto" gap="small-200" alignItems="center">
      <Dot color={cat.color} size={8} />
      <s-text color={color}>{cat.label}</s-text>
    </s-grid>
  );
}

// Banners for the outcome of the last action: a bulk fix (with Undo), an undo, a refresh, a failed
// save, or any error.
export function Notices({ data, onUndo, busy }) {
  if (!data) return null;
  if (!data.ok) {
    return (
      <s-banner tone="critical" heading="Something went wrong">
        <s-paragraph>{data.error}</s-paragraph>
      </s-banner>
    );
  }
  const { fix, undo, edit, refresh, scanNew } = data;
  return (
    <>
      {fix ? (
        <s-banner tone={fix.errors.length ? "warning" : "success"} heading={`${ruleLabel(fix.ruleId)}: ${fix.fixed} fixed`}>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-paragraph>
              {[
                fix.skipped > 0 ? `${fix.skipped} skipped, no safe value to use` : null,
                fix.errors.length > 0 ? `${fix.errors.length} failed: ${fix.errors.slice(0, 2).join("; ")}` : null,
              ]
                .filter(Boolean)
                .join(". ") || "Products re-checked."}
            </s-paragraph>
            {fix.batchId ? (
              <s-button variant="secondary" onClick={() => onUndo(fix.batchId)} disabled={busy || undefined}>Undo</s-button>
            ) : null}
          </s-stack>
        </s-banner>
      ) : null}
      {undo ? (
        <s-banner tone={undo.errors.length ? "warning" : "success"} heading={`${undo.undone} changes reverted`}>
          {undo.errors.length ? <s-paragraph>{undo.errors.slice(0, 2).join("; ")}</s-paragraph> : null}
        </s-banner>
      ) : null}
      {refresh ? (
        <s-banner tone="success" heading={refresh.products ? `Re-checked ${refresh.products} ${refresh.products === 1 ? "product" : "products"}` : "Nothing to re-check"}>
          <s-paragraph>
            {refresh.before > refresh.after
              ? `${refresh.before - refresh.after} ${refresh.before - refresh.after === 1 ? "finding" : "findings"} resolved, ${refresh.after} still open.`
              : refresh.after
                ? `${refresh.after} still open.`
                : "All clear."}
          </s-paragraph>
        </s-banner>
      ) : null}
      {scanNew ? (
        <s-banner tone="success" heading={scanNew.added ? `Scanned ${scanNew.added} new ${scanNew.added === 1 ? "product" : "products"}` : "No new products since the last scan"}>
          {scanNew.added ? (
            <s-paragraph>
              {scanNew.findings} {scanNew.findings === 1 ? "finding" : "findings"} added to the list.
            </s-paragraph>
          ) : null}
        </s-banner>
      ) : null}
      {edit && !edit.ok ? (
        <s-banner tone="critical" heading="Could not save">
          <s-paragraph>{edit.error}</s-paragraph>
        </s-banner>
      ) : null}
    </>
  );
}
