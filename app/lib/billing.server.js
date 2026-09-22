import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { DEFAULT_PLAN, PAID_PLANS, EARLY_BIRD, EARLY_BIRD_SEATS } from "./plans";

// Test charges (the only kind a development store accepts) unless BILLING_TEST=false, which a
// production deployment sets once real billing is wanted. Without the variable, production means
// real charges and everything else means test charges.
// eslint-disable-next-line no-undef
const env = process.env;
export const BILLING_TEST = env.BILLING_TEST ? env.BILLING_TEST === "true" : env.NODE_ENV !== "production";

// The shop's plan and its subscription, for code that has already authenticated the request.
// A paid plan needs an active subscription named after it; anything else is Dust Off.
export async function currentPlan(billing) {
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: PAID_PLANS.map((p) => p.name),
    isTest: BILLING_TEST,
  });
  const subscription = hasActivePayment
    ? (appSubscriptions || []).find((s) => PAID_PLANS.some((p) => p.name === s.name)) || null
    : null;
  const plan = (subscription && PAID_PLANS.find((p) => p.name === subscription.name)) || DEFAULT_PLAN;
  return {
    plan,
    subscription: subscription ? { id: subscription.id, name: subscription.name, test: Boolean(subscription.test) } : null,
  };
}

// The shop's plan from a webhook or background context, which has an Admin API client but no
// billing helper: the active subscriptions are read directly.
const SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions { currentAppInstallation { activeSubscriptions { name status test } } }
`;
export async function planForShop(graphql) {
  const response = await graphql(SUBSCRIPTIONS_QUERY);
  const { data } = await response.json();
  const active = (data?.currentAppInstallation?.activeSubscriptions || []).filter((s) => s.status === "ACTIVE" && (BILLING_TEST || !s.test));
  const sub = active.find((s) => PAID_PLANS.some((p) => p.name === s.name));
  return (sub && PAID_PLANS.find((p) => p.name === sub.name)) || DEFAULT_PLAN;
}

// The shop's plan for a request: a paid plan with an active subscription, or Dust Off.
export async function getCurrentPlan(request) {
  const { billing } = await authenticate.admin(request);
  return (await currentPlan(billing)).plan;
}

// ---------- Early Bird ----------
// Deep Clean at the Quick Clean price for the first EARLY_BIRD_SEATS stores. A claim is recorded
// once the subscription is approved and lapses when it is cancelled or the app is uninstalled; a
// store claims at most once, whatever the status.

export async function earlyBirdSeatsLeft() {
  const claims = await prisma.earlyBirdClaim.count();
  return Math.max(0, EARLY_BIRD_SEATS - claims);
}

export async function earlyBirdClaim(shop) {
  return prisma.earlyBirdClaim.findUnique({ where: { shop } });
}

// Records the claim inside a transaction: only while seats remain and the store never claimed.
export async function claimEarlyBird(shop, subscriptionId) {
  const claim = await prisma.$transaction(async (tx) => {
    const claims = await tx.earlyBirdClaim.count();
    if (claims >= EARLY_BIRD_SEATS) throw new Error("All Early Bird seats are taken.");
    const existing = await tx.earlyBirdClaim.findUnique({ where: { shop } });
    if (existing) throw new Error("This store has already claimed the Early Bird offer.");
    return tx.earlyBirdClaim.create({ data: { shop, subscriptionId, status: "active" } });
  });
  const taken = await prisma.earlyBirdClaim.count();
  console.log(`Early Bird claimed by ${shop}: seat ${taken} of ${EARLY_BIRD_SEATS} (${subscriptionId})`);
  return claim;
}

export async function lapseEarlyBird(shop) {
  const { count } = await prisma.earlyBirdClaim.updateMany({ where: { shop, status: "active" }, data: { status: "lapsed" } });
  if (count) console.log(`Early Bird lapsed for ${shop}`);
  return count;
}

export function isEarlyBirdSubscription(subscription) {
  return Boolean(subscription && subscription.name === EARLY_BIRD.name);
}
