import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { DEFAULT_PLAN, PAID_PLANS, EARLY_BIRD, EARLY_BIRD_SEATS } from "./plans";
import { request } from "./graphql.server";

// Test charges (the only kind a development store accepts) unless BILLING_TEST=false, which a
// production deployment sets once real billing is wanted. Without the variable, production means
// real charges and everything else means test charges. Any other value is a mistake, not a choice.
// eslint-disable-next-line no-undef
const env = process.env;
const TEST_FLAG = String(env.BILLING_TEST || "").trim().toLowerCase();
if (TEST_FLAG && !["1", "true", "yes", "0", "false", "no"].includes(TEST_FLAG)) {
  throw new Error(`BILLING_TEST must be true or false, not "${env.BILLING_TEST}".`);
}
export const BILLING_TEST = TEST_FLAG ? ["1", "true", "yes"].includes(TEST_FLAG) : env.NODE_ENV !== "production";

export const PLAN_UNKNOWN = "Could not confirm your plan with Shopify. Try again in a moment.";

// The plan is read from Shopify on every request; a minute of memory per shop spares the billing
// call on every click. The Plans page reads fresh, and a plan change forgets the entry.
const PLAN_TTL = 60 * 1000;
const planCache = new Map();
export function forgetPlan(shop) {
  planCache.delete(shop);
}

// The shop's plan and its subscription, for code that has already authenticated the request.
// A paid plan needs an active subscription named after it; anything else is Dust Off. When
// Shopify cannot answer, the result is Dust Off with `planUnknown` set, so pages can say so and
// actions that write or scan can wait rather than run on the wrong plan.
export async function currentPlan(billing, shop = null, { fresh = false } = {}) {
  if (shop && !fresh) {
    const hit = planCache.get(shop);
    if (hit && hit.until > Date.now()) return hit.value;
  }
  let value;
  try {
    const { hasActivePayment, appSubscriptions } = await billing.check({
      plans: PAID_PLANS.map((p) => p.name),
      isTest: BILLING_TEST,
    });
    const subscription = hasActivePayment
      ? (appSubscriptions || []).find((s) => PAID_PLANS.some((p) => p.name === s.name)) || null
      : null;
    const plan = (subscription && PAID_PLANS.find((p) => p.name === subscription.name)) || DEFAULT_PLAN;
    value = {
      plan,
      subscription: subscription ? { id: subscription.id, name: subscription.name, test: Boolean(subscription.test) } : null,
      planUnknown: false,
    };
  } catch (err) {
    // An expired token makes the library throw a Response that sends the merchant back through
    // auth: that one must get through. Anything else is Shopify not answering.
    if (err instanceof Response) throw err;
    console.error(`Plan check failed for ${shop || "?"}: ${err?.message || err}`);
    return { plan: DEFAULT_PLAN, subscription: null, planUnknown: true };
  }
  if (shop) planCache.set(shop, { value, until: Date.now() + PLAN_TTL });
  return value;
}

// The shop's plan from a webhook or background context, which has an Admin API client but no
// billing helper: the active subscriptions are read directly.
const SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions { currentAppInstallation { activeSubscriptions { name status test } } }
`;
export async function planForShop(graphql) {
  const data = await request(graphql, SUBSCRIPTIONS_QUERY);
  // No installation in the answer means the read failed, not that the shop is on the free plan.
  if (!data?.currentAppInstallation) throw new Error("Could not read the subscription.");
  const active = (data.currentAppInstallation.activeSubscriptions || []).filter((s) => s.status === "ACTIVE" && (BILLING_TEST || !s.test));
  const sub = active.find((s) => PAID_PLANS.some((p) => p.name === s.name));
  return (sub && PAID_PLANS.find((p) => p.name === sub.name)) || DEFAULT_PLAN;
}

// The shop's plan for a request: a paid plan with an active subscription, or Dust Off.
export async function getCurrentPlan(request) {
  const { billing, session } = await authenticate.admin(request);
  return (await currentPlan(billing, session.shop)).plan;
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
// The seat number is unique in the database, so a 51st claim cannot slip through a race.
export async function claimEarlyBird(shop, subscriptionId) {
  const claim = await prisma.$transaction(async (tx) => {
    const claims = await tx.earlyBirdClaim.count();
    if (claims >= EARLY_BIRD_SEATS) throw new Error("All Early Bird seats are taken.");
    const existing = await tx.earlyBirdClaim.findUnique({ where: { shop } });
    if (existing) throw new Error("This store has already claimed the Early Bird offer.");
    return tx.earlyBirdClaim.create({ data: { shop, subscriptionId, status: "active", seat: claims + 1 } });
  });
  console.log(`Early Bird claimed by ${shop}: seat ${claim.seat} of ${EARLY_BIRD_SEATS} (${subscriptionId})`);
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

// Keeps the claim in step with the live subscription: an approved Early Bird subscription with no
// claim gets one (the merchant may never come back to the Plans page), and an active claim whose
// subscription is no longer Early Bird lapses (a plan change replaces the subscription, and the
// webhook that says so may not arrive). Returns an error message when the seat could not be
// claimed, for the caller to act on; never throws.
export async function syncEarlyBird(shop, plan, subscription) {
  try {
    const claim = await earlyBirdClaim(shop);
    if (plan.id === EARLY_BIRD.id && subscription && !claim) await claimEarlyBird(shop, subscription.id);
    else if (claim?.status === "active" && plan.id !== EARLY_BIRD.id) await lapseEarlyBird(shop);
    return null;
  } catch (err) {
    return err.message || String(err);
  }
}
