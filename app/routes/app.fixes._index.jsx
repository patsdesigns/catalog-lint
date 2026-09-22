import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { undoFix, recentFixes, fixedCount } from "../lib/fixes.server";
import { refreshAfter } from "../lib/rescan.server";
import { currentPlan } from "../lib/billing.server";
import { formatWhen, timeAgo, truncate } from "../lib/format";
import { shopTimeZone } from "../lib/shop.server";
import { ruleLabel, Notices } from "../lib/ui";

// Recent fixes: every bulk fix and saved edit still in place, newest first, each undoable here. A
// fix that touched several products links to its own page, where they can be undone one at a time.

const LIMIT = 50;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [fixes, fixedWeek, fixedTotal, timeZone] = await Promise.all([
    recentFixes(shop, LIMIT),
    fixedCount(shop, 7),
    fixedCount(shop),
    shopTimeZone(admin.graphql, shop),
  ]);
  return { fixes, fixedWeek, fixedTotal, timeZone };
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const form = await request.formData();
  try {
    const undo = await undoFix(admin.graphql, session.shop, form.get("batchId"));
    // A full rescan on a small catalog brings catalog-wide findings back for the reverted products.
    if (undo.productIds.length) await refreshAfter(admin.graphql, session.shop, { kind: "products", ids: undo.productIds, full: true }, plan.productLimit);
    return { ok: true, undo };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const n = (v) => Number(v || 0).toLocaleString("en-US");

export default function RecentFixesPage() {
  const { fixes, fixedWeek, fixedTotal, timeZone } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const undo = (batchId) => fetcher.submit({ intent: "undo", batchId }, { method: "post" });
  const back = () => navigate("/app");

  return (
    <s-page heading="Recent Fixes" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">Home</s-link>
      <s-button slot="secondary-actions" onClick={back}>Back to issues</s-button>
      <Notices data={fetcher.data} onUndo={undo} busy={busy} />
      <s-section padding="none">
        <s-box padding="base">
          <s-stack gap="small">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-heading>{n(fixedTotal)} {fixedTotal === 1 ? "change" : "changes"} in place</s-heading>
              <s-text color="subdued">{fixedWeek ? `${n(fixedWeek)} this week` : "None this week"}</s-text>
            </s-stack>
            <s-text color="subdued">
              Bulk fixes and saved edits, newest first. Undo puts the previous values back; a fix on several products
              opens a page where each can be undone alone.
            </s-text>
          </s-stack>
        </s-box>
        {fixes.length === 0 ? (
          <s-box padding="base" paddingBlockStart="none">
            <s-text color="subdued">No fixes yet. Fixes you apply or save on an issue page show up here.</s-text>
          </s-box>
        ) : (
          <s-table loading={busy || undefined}>
            <s-table-header-row>
              <s-table-header listSlot="kicker">Date and time</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Changes</s-table-header>
              <s-table-header listSlot="primary">Fix</s-table-header>
              <s-table-header listSlot="secondary">Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {fixes.map((f) => (
                <s-table-row key={f.batchId}>
                  <s-table-cell>
                    {/* In the store time zone, with how long ago underneath. */}
                    <s-stack gap="small-500">
                      <s-text fontVariantNumeric="tabular-nums">{formatWhen(f.at, timeZone)}</s-text>
                      <s-text color="subdued">{timeAgo(f.at)}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">{f.count}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {/* One product: its name. Several: a link to the batch page, where each can be undone alone. */}
                    <s-stack gap="small-500">
                      <s-text>{f.label || ruleLabel(f.ruleId)}</s-text>
                      {f.productCount === 1 ? (
                        <s-text color="subdued">{truncate(f.productTitle, 70)}</s-text>
                      ) : f.productCount > 1 ? (
                        <s-link href={`/app/fixes/${f.batchId}`}>{f.productCount} products</s-link>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="secondary" onClick={() => undo(f.batchId)} disabled={busy || undefined} accessibilityLabel={`Undo ${f.label || ruleLabel(f.ruleId)}, ${f.count} changes`}>
                      Undo
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-button variant="tertiary" icon="arrow-left" onClick={back}>Back to issues</s-button>
            {fixes.length >= LIMIT ? <s-text color="subdued">Showing the latest {LIMIT}.</s-text> : null}
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
