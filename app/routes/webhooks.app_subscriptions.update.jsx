import { authenticate } from "../shopify.server";
import { forgetPlan, lapseEarlyBird } from "../lib/billing.server";
import { EARLY_BIRD } from "../lib/plans";

// app_subscriptions/update: the remembered plan is forgotten so the next request reads the new
// one, and when the Early Bird subscription is cancelled or expires, the seat lapses.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  forgetPlan(shop);
  const subscription = payload?.app_subscription;
  const status = String(subscription?.status || "").toUpperCase();
  if (subscription?.name === EARLY_BIRD.name && (status === "CANCELLED" || status === "EXPIRED")) {
    await lapseEarlyBird(shop);
  }
  return new Response();
};
