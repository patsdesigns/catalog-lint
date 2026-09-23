import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, DEFAULT_PLAN, EARLY_BIRD, EARLY_BIRD_SEATS, FEATURE_LABELS, COMING_SOON, ALL_AREAS } from "../lib/plans";
import { PLAN_UNKNOWN, currentPlan, forgetPlan, testCharges, earlyBirdSeatsLeft, earlyBirdClaim, claimEarlyBird, lapseEarlyBird, isEarlyBirdSubscription } from "../lib/billing.server";
import { shopInfo } from "../lib/shop.server";

// The three plans, plus the Early Bird offer while seats remain. Choosing a paid plan sends the
// merchant to Shopify's approval screen and back here; choosing Dust Off cancels the subscription.

export async function loader({ request }) {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  // Read fresh: this page is where the merchant comes back after approving a change.
  const { plan, subscription, planUnknown } = await currentPlan(billing, admin.graphql, shop, { fresh: true });
  let claim = await earlyBirdClaim(shop);
  let notice = planUnknown ? { tone: "warning", heading: "Could not confirm your plan", text: PLAN_UNKNOWN } : null;
  let currentId = plan.id;

  // Back from approving the Early Bird subscription: the seat is claimed now. If the seats ran out
  // between the request and the approval, the subscription is canceled again and nothing is charged.
  if (plan.id === EARLY_BIRD.id && subscription && !claim) {
    try {
      claim = await claimEarlyBird(shop, subscription.id);
    } catch (err) {
      try {
        await billing.cancel({ subscriptionId: subscription.id, isTest: subscription.test, prorate: false });
        forgetPlan(shop);
        currentId = DEFAULT_PLAN.id;
        notice = { tone: "critical", heading: "The Early Bird offer is no longer available", text: `${err.message} The subscription was canceled and nothing is charged.` };
      } catch (cancelErr) {
        notice = { tone: "critical", heading: "The Early Bird offer is no longer available", text: `${err.message} The subscription could not be canceled automatically (${cancelErr.message}); choose Dust Off below.` };
      }
    }
  } else if (claim?.status === "active" && plan.id !== EARLY_BIRD.id && !planUnknown) {
    // The subscription is no longer Early Bird (a plan change replaced it): the seat lapses.
    await lapseEarlyBird(shop);
    claim = await earlyBirdClaim(shop);
  }

  const seatsLeft = await earlyBirdSeatsLeft();
  const earlyBird = {
    seats: EARLY_BIRD_SEATS,
    seatsLeft,
    claimed: EARLY_BIRD_SEATS - seatsLeft,
    status: claim?.status || null,
    // Offered while seats remain and the store never claimed; shown as current while it is the plan.
    show: plan.id === EARLY_BIRD.id || claim?.status === "active" || (!claim && seatsLeft > 0),
    plan: EARLY_BIRD,
  };
  const { locale } = await shopInfo(admin.graphql, shop);
  // Said on the page only where it is true: a development store, or a deployment without real billing.
  const testMode = await testCharges(admin.graphql, shop).catch(() => false);
  return { currentId, plans: PLANS, earlyBird, notice, planUnknown, locale, testMode };
}

export async function action({ request }) {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const wanted = form.get("plan");
  const target = wanted === EARLY_BIRD.id ? EARLY_BIRD : PLANS.find((p) => p.id === wanted);
  if (!target) return { ok: false, error: "That plan does not exist." };
  const { plan, subscription, planUnknown } = await currentPlan(billing, admin.graphql, shop, { fresh: true });
  if (planUnknown) return { ok: false, error: PLAN_UNKNOWN };
  if (target.id === plan.id) return { ok: true, plan: plan.id };
  try {
    forgetPlan(shop);
    if (target.price === 0) {
      if (subscription) await billing.cancel({ subscriptionId: subscription.id, isTest: subscription.test, prorate: false });
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
    // Development stores (Shopify's reviewers, other Partners) get a test charge; see billing.server.js.
    await billing.request({ plan: target.name, isTest: await testCharges(admin.graphql, shop), returnUrl: `${base}/app/plans` });
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

function PlanCard({ plan, current, note, claimed, footnote, busy, choosing, locale, onChoose }) {
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
          <s-text type="strong">{plan.price ? `$${plan.price} every 30 days` : "Free"}</s-text>
          <s-text color="subdued">{plan.productLimit ? `Up to ${plan.productLimit.toLocaleString(locale)} products` : "Unlimited products"}</s-text>
          <s-text color="subdued">{plan.areas.length === ALL_AREAS.length ? `All ${ALL_AREAS.length} check areas` : `${plan.areas.length} of ${ALL_AREAS.length} check areas`}</s-text>
          {note ? <s-text>{note}</s-text> : null}
          {claimed ? <s-text color="subdued">{claimed}</s-text> : null}
        </s-stack>
        <s-unordered-list>
          <s-list-item>Full scans, Fix all and undo</s-list-item>
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
          loading={choosing === plan.id || undefined}
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
  const { currentId, plans, earlyBird, notice, locale, testMode } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const choose = (id) => fetcher.submit({ plan: id }, { method: "post" });
  // The offer sits right after the free plan; the subscription condition is a footnote in its card.
  const cards = earlyBird.show ? [plans[0], earlyBird.plan, ...plans.slice(1)] : plans;
  const offer = `First ${earlyBird.seats} stores get Deep Clean for $${earlyBird.plan.price} every 30 days*`;
  // The plan whose button was pressed, so it shows the wait for the approval screen.
  const choosing = busy ? fetcher.formData?.get("plan") : null;
  const claimed = `${earlyBird.claimed} of ${earlyBird.seats} claimed`;

  return (
    <s-page heading="Plans" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">Home</s-link>
      {notice ? (
        <s-banner tone={notice.tone || "critical"} heading={notice.heading}>
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
          <s-paragraph>The paid subscription has been canceled.</s-paragraph>
        </s-banner>
      ) : null}
      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            Every plan is billed in USD every 30 days, with no one-time charges and no trial.
            {testMode ? " Charges on this store are test charges, so nothing is billed." : ""}
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
                  choosing={choosing}
                  locale={locale}
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
