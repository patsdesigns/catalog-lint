import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, DEFAULT_PLAN, EARLY_BIRD, EARLY_BIRD_SEATS, FEATURE_LABELS, COMING_SOON, ALL_AREAS } from "../lib/plans";
import { BILLING_TEST, currentPlan, earlyBirdSeatsLeft, earlyBirdClaim, claimEarlyBird, lapseEarlyBird, isEarlyBirdSubscription } from "../lib/billing.server";

// The three plans, plus the Early Bird offer while seats remain. Choosing a paid plan sends the
// merchant to Shopify's approval screen and back here; choosing Dust Off cancels the subscription.

export async function loader({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const { plan, subscription } = await currentPlan(billing);
  let claim = await earlyBirdClaim(shop);
  let notice = null;
  let currentId = plan.id;

  // Back from approving the Early Bird subscription: the seat is claimed now. If the seats ran out
  // between the request and the approval, the subscription is cancelled again and nothing is charged.
  if (plan.id === EARLY_BIRD.id && subscription && !claim) {
    try {
      claim = await claimEarlyBird(shop, subscription.id);
    } catch (err) {
      await billing.cancel({ subscriptionId: subscription.id, isTest: BILLING_TEST, prorate: false });
      currentId = DEFAULT_PLAN.id;
      notice = { heading: "The Early Bird offer is no longer available", text: `${err.message} The subscription was cancelled and nothing is charged.` };
    }
  }

  const seatsLeft = await earlyBirdSeatsLeft();
  const earlyBird = {
    seats: EARLY_BIRD_SEATS,
    seatsLeft,
    claimed: EARLY_BIRD_SEATS - seatsLeft,
    status: claim?.status || null,
    // Offered while seats remain and the store never claimed; shown as current while its claim is active.
    show: claim?.status === "active" || (!claim && seatsLeft > 0),
    plan: EARLY_BIRD,
  };
  return { currentId, plans: PLANS, earlyBird, notice };
}

export async function action({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const wanted = form.get("plan");
  const target = wanted === EARLY_BIRD.id ? EARLY_BIRD : PLANS.find((p) => p.id === wanted);
  if (!target) return { ok: false, error: "That plan does not exist." };
  const { plan, subscription } = await currentPlan(billing);
  if (target.id === plan.id) return { ok: true, plan: plan.id };
  try {
    if (target.price === 0) {
      if (subscription) await billing.cancel({ subscriptionId: subscription.id, isTest: BILLING_TEST, prorate: false });
      if (isEarlyBirdSubscription(subscription)) await lapseEarlyBird(shop);
      return { ok: true, plan: target.id };
    }
    if (target.earlyBird) {
      // Seats are checked here and again, inside a transaction, when the claim is recorded.
      if (await earlyBirdClaim(shop)) return { ok: false, error: "This store has already used the Early Bird offer." };
      if ((await earlyBirdSeatsLeft()) <= 0) return { ok: false, error: "All Early Bird seats are taken." };
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

const THREE_COLUMNS = "@container (inline-size > 900px) 1fr 1fr 1fr, (inline-size > 560px) and (inline-size <= 900px) 1fr 1fr, 1fr";
const FOUR_COLUMNS = "@container (inline-size > 1000px) 1fr 1fr 1fr 1fr, (inline-size > 560px) and (inline-size <= 1000px) 1fr 1fr, 1fr";
const FEATURE_ORDER = Object.keys(FEATURE_LABELS);

function PlanCard({ plan, current, note, claimed, footnote, busy, onChoose }) {
  const included = FEATURE_ORDER.filter((key) => plan.features[key] && !COMING_SOON.has(key));
  const later = FEATURE_ORDER.filter((key) => plan.features[key] && COMING_SOON.has(key));
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
            <s-heading>{plan.name}</s-heading>
            {current ? <s-badge tone="success">Current plan</s-badge> : plan.earlyBird ? <s-badge tone="info">Limited offer</s-badge> : null}
          </s-stack>
          <s-text type="strong">{plan.price ? `$${plan.price} / month` : "Free"}</s-text>
          <s-text color="subdued">{plan.productLimit ? `Up to ${plan.productLimit.toLocaleString("en-US")} products` : "Unlimited products"}</s-text>
          <s-text color="subdued">{plan.areas.length === ALL_AREAS.length ? `All ${ALL_AREAS.length} check areas` : `${plan.areas.length} of ${ALL_AREAS.length} check areas`}</s-text>
          {note ? <s-text>{note}</s-text> : null}
          {claimed ? <s-text color="subdued">{claimed}</s-text> : null}
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
          {current ? "Current plan" : plan.price ? `Choose ${plan.earlyBird ? "Early Bird" : plan.name}` : "Switch to Dust Off"}
        </s-button>
        {footnote ? <s-text color="subdued">{footnote}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export default function PlansPage() {
  const { currentId, plans, earlyBird, notice } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const choose = (id) => fetcher.submit({ plan: id }, { method: "post" });
  // The offer sits right after the free plan; the subscription condition is a footnote in its card.
  const cards = earlyBird.show ? [plans[0], earlyBird.plan, ...plans.slice(1)] : plans;
  const offer = `First ${earlyBird.seats} stores get Deep Clean for $${earlyBird.plan.price} a month*`;
  const claimed = `${earlyBird.claimed} of ${earlyBird.seats} claimed`;

  return (
    <s-page heading="Plans" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">Home</s-link>
      {notice ? (
        <s-banner tone="critical" heading={notice.heading}>
          <s-paragraph>{notice.text}</s-paragraph>
        </s-banner>
      ) : null}
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
            <s-grid gridTemplateColumns={cards.length > 3 ? FOUR_COLUMNS : THREE_COLUMNS} gap="base">
              {cards.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  current={plan.id === currentId}
                  note={plan.earlyBird ? offer : null}
                  claimed={plan.earlyBird ? claimed : null}
                  footnote={plan.earlyBird ? "* Keep it as long as you stay subscribed." : null}
                  busy={busy}
                  onChoose={choose}
                />
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
