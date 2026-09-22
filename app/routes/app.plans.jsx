import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, FEATURE_LABELS, COMING_SOON, ALL_AREAS } from "../lib/plans";
import { BILLING_TEST, currentPlan } from "../lib/billing.server";

// The three plans. Choosing a paid one sends the merchant to Shopify's approval screen and back;
// choosing Dust Off cancels the current subscription.

export async function loader({ request }) {
  const { billing } = await authenticate.admin(request);
  const { plan, subscription } = await currentPlan(billing);
  return { currentId: plan.id, subscription, plans: PLANS };
}

export async function action({ request }) {
  const { billing } = await authenticate.admin(request);
  const form = await request.formData();
  const target = PLANS.find((p) => p.id === form.get("plan"));
  if (!target) return { ok: false, error: "That plan does not exist." };
  const { plan, subscription } = await currentPlan(billing);
  if (target.id === plan.id) return { ok: true, plan: plan.id };
  try {
    if (target.price === 0) {
      if (subscription) await billing.cancel({ subscriptionId: subscription.id, isTest: BILLING_TEST, prorate: false });
      return { ok: true, plan: target.id };
    }
    // Throws a redirect to the approval screen; Shopify sends the merchant back to this page after.
    // The app URL (https) is the base: the request URL behind the dev proxy is plain http.
    // eslint-disable-next-line no-undef
    const base = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
    await billing.request({ plan: target.name, isTest: BILLING_TEST, returnUrl: `${base}/app/plans` });
    return { ok: true };
  } catch (err) {
    // The redirect itself is thrown as a Response; anything else is a billing error to show.
    if (err instanceof Response) throw err;
    const detail = (err?.errorData || []).map((e) => e.message).filter(Boolean).join("; ");
    return { ok: false, error: detail || err?.message || String(err) };
  }
}

const PLAN_COLUMNS = "@container (inline-size > 900px) 1fr 1fr 1fr, (inline-size > 560px) and (inline-size <= 900px) 1fr 1fr, 1fr";
const FEATURE_ORDER = Object.keys(FEATURE_LABELS);

function PlanCard({ plan, current, busy, onChoose }) {
  const included = FEATURE_ORDER.filter((key) => plan.features[key] && !COMING_SOON.has(key));
  const later = FEATURE_ORDER.filter((key) => plan.features[key] && COMING_SOON.has(key));
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
            <s-heading>{plan.name}</s-heading>
            {current ? <s-badge tone="success">Current plan</s-badge> : null}
          </s-stack>
          <s-text type="strong">{plan.price ? `$${plan.price} / month` : "Free"}</s-text>
          <s-text color="subdued">{plan.productLimit ? `Up to ${plan.productLimit.toLocaleString("en-US")} products` : "Unlimited products"}</s-text>
          <s-text color="subdued">{plan.areas.length === ALL_AREAS.length ? `All ${ALL_AREAS.length} check areas` : `${plan.areas.length} of ${ALL_AREAS.length} check areas`}</s-text>
        </s-stack>
        <s-unordered-list>
          <s-list-item>Full scan, fix-all buttons and undo</s-list-item>
          {included.map((key) => (
            <s-list-item key={key}>{FEATURE_LABELS[key]}</s-list-item>
          ))}
          {plan.extras.map((extra) => (
            <s-list-item key={extra}>{extra}</s-list-item>
          ))}
          {later.map((key) => (
            <s-list-item key={key}>{FEATURE_LABELS[key]}</s-list-item>
          ))}
        </s-unordered-list>
        <s-button
          variant={current ? "secondary" : "primary"}
          disabled={current || busy || undefined}
          onClick={() => onChoose(plan.id)}
          accessibilityLabel={current ? `${plan.name} is your current plan` : `Choose ${plan.name}`}
        >
          {current ? "Current plan" : plan.price ? `Choose ${plan.name}` : "Switch to Dust Off"}
        </s-button>
      </s-stack>
    </s-box>
  );
}

export default function PlansPage() {
  const { currentId, plans } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const choose = (id) => fetcher.submit({ plan: id }, { method: "post" });

  return (
    <s-page heading="Plans" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">Home</s-link>
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Could not change plan">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      {outcome?.ok && outcome.plan === "dust_off" ? (
        <s-banner tone="success" heading="You are on Dust Off">
          <s-paragraph>The paid subscription has been cancelled.</s-paragraph>
        </s-banner>
      ) : null}
      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            Every plan is billed in USD every 30 days, with no one-time charges and no trial. While TidyUp is in
            development, charges are test charges.
          </s-paragraph>
          <s-query-container>
            <s-grid gridTemplateColumns={PLAN_COLUMNS} gap="base">
              {plans.map((plan) => (
                <PlanCard key={plan.id} plan={plan} current={plan.id === currentId} busy={busy} onChoose={choose} />
              ))}
            </s-grid>
          </s-query-container>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
