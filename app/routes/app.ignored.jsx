import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getIgnores, removeIgnore } from "../lib/ignores.server";
import { refreshAfter } from "../lib/rescan.server";
import { shopInfo } from "../lib/shop.server";
import { describeError } from "../lib/graphql.server";
import { RULE_CATALOG } from "../lib/rules.server";
import { currentPlan, PLAN_UNKNOWN } from "../lib/billing.server";
import { planFor } from "../lib/plans";
import { adminUrl, formatWhen, timeAgo, truncate } from "../lib/format";
import { PlanUnknown } from "../lib/ui";

// Ignored findings: the single findings that Ignore on an issue page hid. Its own page, so a long
// list does not crowd Settings. Restore removes the ignore and re-checks the product, so the
// finding is back on the home page right away if it still applies.

const MAX_ROWS = 200;

export async function loader({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, admin.graphql, session.shop);
  // The rows are only sent to a plan that includes them.
  if (planUnknown || !plan.features.ignores) return { ignores: [], plan, planUnknown, timeZone: "UTC", locale: "en" };
  const [rows, info] = await Promise.all([getIgnores(session.shop), shopInfo(admin.graphql, session.shop)]);
  const { timeZone, locale } = info;
  const labels = new Map(RULE_CATALOG.map((r) => [r.id, r.label]));
  const ignores = rows.map((i) => ({
    id: i.id,
    productId: i.productId,
    title: i.title,
    check: labels.get(i.ruleId) || i.ruleId.replace(/_/g, " "),
    detail: i.detail,
    at: i.createdAt.toISOString(),
  }));
  return { ignores, plan, planUnknown, timeZone, locale };
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, admin.graphql, session.shop);
  if (planUnknown) return { ok: false, error: PLAN_UNKNOWN };
  if (!plan.features.ignores) {
    return { ok: false, error: `Ignored findings are part of the ${planFor("ignores").name} plan and up.` };
  }
  const form = await request.formData();
  if (form.get("intent") !== "restore") return { ok: true };
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { ok: false, error: "That finding was not understood. Reload the page and try again." };
  let row;
  try {
    row = (await getIgnores(session.shop)).find((i) => i.id === id);
    if (!row) return { ok: true, restored: null };
    await removeIgnore(session.shop, id);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  try {
    // The product is re-checked so the finding is back on the home page if it still applies.
    await refreshAfter(admin.graphql, session.shop, { kind: "products", ids: [row.productId] }, plan.productLimit);
    return { ok: true, restored: { title: row.title, rechecked: true } };
  } catch (err) {
    // The ignore is gone either way; the finding then returns with the next scan.
    return { ok: true, restored: { title: row.title, rechecked: false, error: describeError(err) } };
  }
}

export default function IgnoredPage() {
  const { ignores, plan, planUnknown, timeZone, locale } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const [query, setQuery] = useState("");
  const restore = (id) => fetcher.submit({ intent: "restore", id }, { method: "post" });

  if (planUnknown) return <PlanUnknown heading="Ignored findings" />;
  if (!plan.features.ignores) {
    const needed = planFor("ignores");
    return (
      <s-page heading="Ignored findings">
        <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
        <s-section heading="Not included in your plan">
          <s-paragraph>
            Ignoring findings is part of the {needed.name} plan and up. <s-link href="/app/plans">Upgrade to {needed.name}</s-link>
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (i) => `${i.title} ${i.check} ${i.detail}`.toLowerCase().includes(q);
  const shown = (q ? ignores.filter(matches) : ignores).slice(0, MAX_ROWS);
  const restored = outcome?.ok ? outcome.restored : null;

  return (
    <s-page heading="Ignored findings" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Not included in your plan">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      {restored ? (
        <s-banner tone="success" heading={`${restored.title || "The finding"} is back`}>
          <s-paragraph>
            {restored.rechecked
              ? "The product was re-checked, so the finding is on the home page again if it still applies."
              : `The product could not be re-checked now (${restored.error}). The finding returns with the next scan.`}
          </s-paragraph>
        </s-banner>
      ) : null}
      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="small">
            <s-heading>
              {ignores.length} ignored {ignores.length === 1 ? "finding" : "findings"}
            </s-heading>
            <s-text color="subdued">
              Ignore on an issue page hides one finding and lists it here. Restore puts it back and re-checks the product.
            </s-text>
            {ignores.length > 20 ? (
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search products, checks or details"
                value={query}
                onInput={(e) => setQuery(e.target.value)}
              ></s-search-field>
            ) : null}
          </s-stack>
        </s-box>
        {ignores.length === 0 ? (
          <s-box padding="base" paddingBlockStart="none">
            <s-text color="subdued">Nothing ignored.</s-text>
          </s-box>
        ) : shown.length === 0 ? (
          <s-box padding="base" paddingBlockStart="none">
            <s-text color="subdued">No ignored findings match your search.</s-text>
          </s-box>
        ) : (
          <s-table loading={busy || undefined}>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Check</s-table-header>
              <s-table-header listSlot="inline">Detail</s-table-header>
              <s-table-header listSlot="kicker">Ignored</s-table-header>
              <s-table-header listSlot="secondary">Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {shown.map((i) => (
                <s-table-row key={i.id}>
                  <s-table-cell>
                    <s-link href={adminUrl(i.productId)} target="_blank" accessibilityLabel={`${i.title || "Product"}, opens in Shopify admin in a new tab`}>
                      {truncate(i.title, 70) || "Untitled product"}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{i.check}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{truncate(i.detail, 80)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-text fontVariantNumeric="tabular-nums">{formatWhen(i.at, timeZone, undefined, locale)}</s-text>
                      <s-text color="subdued">{timeAgo(i.at, locale)}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="secondary"
                      onClick={() => restore(i.id)}
                      disabled={busy || undefined}
                      accessibilityLabel={`Restore ${i.check} on ${i.title || "this product"}`}
                    >
                      Restore
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {shown.length === MAX_ROWS && ignores.length > MAX_ROWS ? (
          <s-box padding="base">
            <s-text color="subdued">
              Showing {MAX_ROWS} of {ignores.length}. Use search to narrow down.
            </s-text>
          </s-box>
        ) : null}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
