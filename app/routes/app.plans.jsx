import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, DEFAULT_PLAN, EARLY_BIRD, EARLY_BIRD_SEATS, FEATURE_LABELS, COMING_SOON, ALL_AREAS } from "../lib/plans";
import { PLAN_UNKNOWN, EARLY_BIRD_PAYING_ONLY, currentPlan, forgetPlan, testCharges, earlyBirdSeatsLeft, earlyBirdClaim, settleEarlyBird, lapseEarlyBird, isEarlyBirdSubscription, SEATS_TAKEN } from "../lib/billing.server";
import { shopInfo } from "../lib/shop.server";

// The three plans, plus the Early Bird offer while seats remain. Choosing a paid plan sends the
// merchant to Shopify's approval screen and back to Home; choosing Dust Off cancels the subscription.

export async function loader({ request }) {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  // Read fresh: the merchant may have just changed plans.
  const { plan, subscription, planUnknown } = await currentPlan(billing, admin.graphql, shop, { fresh: true });
  let notice = planUnknown ? { tone: "warning", heading: "Could not confirm your plan", text: PLAN_UNKNOWN } : null;
  let currentId = plan.id;

  // The Early Bird seat follows the subscription: claimed, lapsed, or the subscription canceled
  // again when the seats ran out during the approval (Home does the same; approvals return there).
  if (!planUnknown) {
    const settled = await settleEarlyBird(billing, shop, plan, subscription);
    if (settled) notice = settled;
    if (settled?.canceled) currentId = DEFAULT_PLAN.id;
  }
  const claim = await earlyBirdClaim(shop);

  // Test charges on this store: a development store, or a deployment without real billing. Said on
  // the page only where it is true, and it keeps the Early Bird offer out of reach. Unknown counts as
  // test here, so a failed check never opens the offer to a test store.
  const testMode = await testCharges(admin.graphql, shop).catch(() => null);
  const seatsLeft = await earlyBirdSeatsLeft();
  const earlyBird = {
    seats: EARLY_BIRD_SEATS,
    seatsLeft,
    claimed: EARLY_BIRD_SEATS - seatsLeft,
    status: claim?.status || null,
    // Offered while seats remain and the store never claimed; shown as current while it is the plan.
    // Test stores see the offer (Shopify's reviewers should see what the listing describes) but
    // cannot choose it.
    show: plan.id === EARLY_BIRD.id || claim?.status === "active" || (!claim && seatsLeft > 0),
    available: testMode === false,
    unavailableText: EARLY_BIRD_PAYING_ONLY,
    plan: EARLY_BIRD,
  };
  const { locale } = await shopInfo(admin.graphql, shop);
  return { currentId, plans: PLANS, earlyBird, notice, planUnknown, locale, testMode: testMode === true };
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
      // For paying stores only: never on a store whose charges are test charges.
      if (await testCharges(admin.graphql, shop)) return { ok: false, error: EARLY_BIRD_PAYING_ONLY };
      // Seats are checked here and again, inside a transaction, when the claim is recorded.
      if (await earlyBirdClaim(shop)) return { ok: false, error: "This store has already used the Early Bird offer." };
      if ((await earlyBirdSeatsLeft()) <= 0) return { ok: false, error: SEATS_TAKEN };
    }
    // Throws a redirect to the approval screen. Shopify then brings the merchant back to Home inside
    // the admin, the library's default return URL. A URL on the app's own host would open the app
    // outside the admin, where it cannot tell which store it is in.
    // Development stores (Shopify's reviewers, other Partners) get a test charge; see billing.server.js.
    await billing.request({ plan: target.name, isTest: await testCharges(admin.graphql, shop) });
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

// `unavailable`: why the plan cannot be chosen here; the button is disabled and the reason shown.
function PlanCard({ plan, current, note, claimed, footnote, unavailable, busy, choosing, locale, onChoose }) {
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
          disabled={current || busy || Boolean(unavailable) || undefined}
          loading={choosing === plan.id || undefined}
          onClick={() => onChoose(plan.id)}
          accessibilityLabel={current ? `${plan.name} is your current plan` : `Choose ${plan.name}`}
        >
          {current ? "Current plan" : plan.price ? `Choose ${plan.earlyBird ? "Early Bird" : plan.name}` : "Switch to Dust Off"}
        </s-button>
        {unavailable && !current ? <s-text color="subdued">{unavailable}</s-text> : null}
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
                  unavailable={plan.earlyBird && !earlyBird.available ? earlyBird.unavailableText : null}
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
