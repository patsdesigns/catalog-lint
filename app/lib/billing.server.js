import prisma from "../db.server";
import { DEFAULT_PLAN, PAID_PLANS, EARLY_BIRD, EARLY_BIRD_SEATS } from "./plans";
import { request } from "./graphql.server";

// Test charges everywhere unless BILLING_TEST=false, which a production deployment sets once real
// billing is wanted. Without the variable, production means real charges and everything else means
// test charges. Any other value is a mistake, not a choice. Development stores get test charges
// whatever this says (see testCharges below).
// eslint-disable-next-line no-undef
const env = process.env;
const TEST_FLAG = String(env.BILLING_TEST || "").trim().toLowerCase();
if (TEST_FLAG && !["1", "true", "yes", "0", "false", "no"].includes(TEST_FLAG)) {
  throw new Error(`BILLING_TEST must be true or false, not "${env.BILLING_TEST}".`);
}
export const BILLING_TEST = TEST_FLAG ? ["1", "true", "yes"].includes(TEST_FLAG) : env.NODE_ENV !== "production";

export const PLAN_UNKNOWN = "Could not confirm your plan with Shopify. Try again in a moment.";

// ---------- test charges ----------
// A development store accepts only test charges, and development stores are where Shopify's
// reviewers and other Partners try the app. So a charge is a test charge when BILLING_TEST says so
// or when the store is a development store, and a test subscription counts on exactly those
// stores. A development store transferred to a merchant stops being one once it moves to a paid
// plan (the answer is kept for an hour); its test subscription then stops counting.
const DEV_STORE_QUERY = `#graphql
  query DevelopmentStore { shop { plan { partnerDevelopment } } }
`;
const DEV_STORE_TTL = 60 * 60 * 1000;
const devStores = new Map();

export async function isDevelopmentStore(graphql, shop = null) {
  const hit = shop ? devStores.get(shop) : null;
  if (hit && hit.until > Date.now()) return hit.value;
  let data;
  try {
    data = await request(graphql, DEV_STORE_QUERY);
  } catch (err) {
    // An expired token surfaces as a Response, which must reach the router: it re-authenticates.
    if (err?.cause instanceof Response) throw err.cause;
    throw err;
  }
  const value = data?.shop?.plan?.partnerDevelopment;
  if (typeof value !== "boolean") throw new Error("Could not tell whether this is a development store.");
  if (shop) devStores.set(shop, { value, until: Date.now() + DEV_STORE_TTL });
  return value;
}

// Whether a charge created for this store is a test charge.
export async function testCharges(graphql, shop) {
  if (BILLING_TEST) return true;
  return isDevelopmentStore(graphql, shop);
}

// The active paid subscription that counts for this store, or null. A test subscription counts
// only where charges are test charges; the store is only looked up when there is one to judge.
async function countingSubscription(subscriptions, graphql, shop) {
  const paid = (subscriptions || []).filter((s) => PAID_PLANS.some((p) => p.name === s.name));
  const allowTest = paid.some((s) => s.test) && (await testCharges(graphql, shop));
  return paid.find((s) => allowTest || !s.test) || null;
}

// The features of the plan each shop was last seen on, for code that runs without a request (a
// scan started from a page, a webhook): what a downgrade pauses (tracked metafields) is decided
// from this. Unknown until the shop's first request; then it never expires.
const lastFeatures = new Map();
export function rememberFeatures(shop, plan) {
  if (shop && plan?.features) lastFeatures.set(shop, plan.features);
}
export function planFeatures(shop) {
  return lastFeatures.get(shop) || null;
}

// The plan is read from Shopify on every request; a minute of memory per shop spares the billing
// call on every click. The Plans page reads fresh, and a plan change forgets the entry.
const PLAN_TTL = 60 * 1000;
const planCache = new Map();
export function forgetPlan(shop) {
  planCache.delete(shop);
}

// The shop's plan and its subscription, for code that has already authenticated the request
// (billing and graphql come from authenticate.admin). A paid plan needs an active subscription
// named after it that counts for this store; anything else is Dust Off. When Shopify cannot
// answer, the result is Dust Off with `planUnknown` set, so pages can say so and actions that
// write or scan can wait rather than run on the wrong plan.
export async function currentPlan(billing, graphql, shop = null, { fresh = false } = {}) {
  if (shop && !fresh) {
    const hit = planCache.get(shop);
    if (hit && hit.until > Date.now()) return hit.value;
  }
  let value;
  try {
    // Every active subscription, test or not: which ones count depends on the store.
    const { appSubscriptions } = await billing.check({ plans: PAID_PLANS.map((p) => p.name), isTest: true });
    const subscription = await countingSubscription(appSubscriptions, graphql, shop);
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
  rememberFeatures(shop, value.plan);
  return value;
}

// The shop's plan from a webhook or background context, which has an Admin API client but no
// billing helper: the active subscriptions are read directly.
const SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions { currentAppInstallation { activeSubscriptions { name status test } } }
`;
export async function planForShop(graphql, shop = null) {
  const data = await request(graphql, SUBSCRIPTIONS_QUERY);
  // No installation in the answer means the read failed, not that the shop is on the free plan.
  if (!data?.currentAppInstallation) throw new Error("Could not read the subscription.");
  const active = (data.currentAppInstallation.activeSubscriptions || []).filter((s) => s.status === "ACTIVE");
  const sub = await countingSubscription(active, graphql, shop);
  const plan = (sub && PAID_PLANS.find((p) => p.name === sub.name)) || DEFAULT_PLAN;
  rememberFeatures(shop, plan);
  return plan;
}

// ---------- Early Bird ----------
// Deep Clean at the Quick Clean price for the first EARLY_BIRD_SEATS paying stores. A claim is
// recorded once the subscription is approved and lapses when it is cancelled or the app is
// uninstalled; a store claims at most once, whatever the status. The offer is for paying stores
// only: a test store cannot choose it (Plans page) and a test subscription never takes a seat.
export const EARLY_BIRD_PAYING_ONLY = "Early Bird is for paying stores, so it is not available on a test store.";

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
    // Only a real, paid subscription takes a seat.
    if (plan.id === EARLY_BIRD.id && subscription && !subscription.test && !claim) await claimEarlyBird(shop, subscription.id);
    else if (claim?.status === "active" && plan.id !== EARLY_BIRD.id) await lapseEarlyBird(shop);
    return null;
  } catch (err) {
    return err.message || String(err);
  }
}
