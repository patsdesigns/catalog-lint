import { authenticate } from "../shopify.server";
import { DEFAULT_PLAN, PAID_PLANS } from "./plans";

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

// The shop's plan for a request: a paid plan with an active subscription, or Dust Off.
export async function getCurrentPlan(request) {
  const { billing } = await authenticate.admin(request);
  return (await currentPlan(billing)).plan;
}
