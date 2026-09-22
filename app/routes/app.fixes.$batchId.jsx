import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fixBatch, undoFix } from "../lib/fixes.server";
import { refreshAfter } from "../lib/rescan.server";
import { currentPlan } from "../lib/billing.server";
import { adminUrl, timeAgo } from "../lib/format";

// One recent fix: the products it changed, each of which can be undone on its own.

export async function loader({ request, params }) {
  const { session } = await authenticate.admin(request);
  return { batch: await fixBatch(session.shop, params.batchId) };
}

// Undo one product's changes (productId) or every change in the batch.
export async function action({ request, params }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const form = await request.formData();
  try {
    const undo = await undoFix(admin.graphql, session.shop, params.batchId, form.get("productId") || null);
    if (undo.productIds.length) await refreshAfter(admin.graphql, session.shop, { kind: "products", ids: undo.productIds }, plan.productLimit);
    return { ok: true, undo };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const MAX_ROWS = 100;
const FIELD_LABELS = {
  alt: "alt text",
  vendor: "vendor",
  compareAt: "compare-at price",
  price: "price",
  sku: "SKU",
  barcode: "barcode",
  weight: "weight",
  cost: "cost per item",
  title: "title",
  descriptionHtml: "description",
  seoTitle: "SEO title",
  seoDescription: "meta description",
  tags: "tags",
  productType: "product type",
};
const n = (v) => Number(v || 0).toLocaleString("en-US");

function describe(p) {
  const fields = p.fields.map((f) => FIELD_LABELS[f] || f).join(", ");
  return `${n(p.changes)} ${p.changes === 1 ? "change" : "changes"} · ${fields}`;
}

export default function FixBatchPage() {
  const { batch } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const [query, setQuery] = useState("");
  const undo = (productId) => fetcher.submit(productId ? { productId } : {}, { method: "post" });

  const notices = (
    <>
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Could not undo">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      {outcome?.undo ? (
        <s-banner tone={outcome.undo.errors.length ? "warning" : "success"} heading={`${n(outcome.undo.undone)} ${outcome.undo.undone === 1 ? "change" : "changes"} reverted`}>
          {outcome.undo.errors.length ? <s-paragraph>{outcome.undo.errors.slice(0, 2).join("; ")}</s-paragraph> : null}
        </s-banner>
      ) : null}
    </>
  );

  if (!batch) {
    return (
      <s-page heading="Recent fix" inlineSize="large">
        <s-link slot="breadcrumb-actions" href="/app">Issues</s-link>
        <s-button slot="secondary-actions" href="/app">Back to issues</s-button>
        {notices}
        <s-section>
          <s-stack alignItems="center" gap="small" paddingBlock="large">
            <s-icon type="check-circle" tone="success" />
            <s-heading>Nothing left to undo</s-heading>
            <s-text color="subdued">Every change in this fix has been put back the way it was.</s-text>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? batch.products.filter((p) => p.title.toLowerCase().includes(q)) : batch.products;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;
  const products = `${n(batch.products.length)} ${batch.products.length === 1 ? "product" : "products"}`;

  return (
    <s-page heading={batch.label} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">Issues</s-link>
      <s-button slot="secondary-actions" href="/app">Back to issues</s-button>
      <s-button slot="secondary-actions" onClick={() => undo(null)} disabled={busy || undefined}>Undo all</s-button>
      {notices}
      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="small">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>{n(batch.count)} {batch.count === 1 ? "change" : "changes"} on {products}</s-heading>
              <s-text color="subdued">{timeAgo(batch.at)}</s-text>
            </s-stack>
            <s-text color="subdued">Undo a product to put its previous values back, or undo everything at once.</s-text>
          </s-stack>
        </s-box>
        <s-query-container>
          <s-table loading={busy || undefined}>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="labeled">Changes</s-table-header>
              <s-table-header listSlot="inline">Action</s-table-header>
            </s-table-header-row>
            <s-search-field
              slot="filters"
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search products"
              value={query}
              onInput={(e) => setQuery(e.target.value)}
            ></s-search-field>
            <s-table-body>
              {rows.map((p) => (
                <s-table-row key={p.productId}>
                  <s-table-cell>
                    <s-link href={adminUrl(p.productId)} target="_blank" accessibilityLabel={`${p.title}, opens in Shopify admin in a new tab`}>
                      {p.title}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{describe(p)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="secondary" onClick={() => undo(p.productId)} disabled={busy || undefined} accessibilityLabel={`Undo the changes to ${p.title}`}>
                      Undo
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-query-container>
        {rows.length === 0 ? (
          <s-box padding="base"><s-text color="subdued">No products match your search.</s-text></s-box>
        ) : null}
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-button variant="tertiary" icon="arrow-left" href="/app">Back to issues</s-button>
            {hidden > 0 ? <s-text color="subdued">Showing {n(rows.length)} of {n(filtered.length)}. Use search to narrow down.</s-text> : null}
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
