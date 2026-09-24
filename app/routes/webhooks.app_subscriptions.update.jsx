import { forgetPlan, lapseEarlyBird } from "../lib/billing.server";
import { EARLY_BIRD } from "../lib/plans";
import { verifyWebhook } from "../lib/webhooks.server";

// app_subscriptions/update: the remembered plan is forgotten so the next request reads the new
// one, and when the Early Bird subscription is cancelled or expires, the seat lapses. Uninstalling
// cancels the subscription, so this also arrives after an uninstall: it is verified without the
// library's session handling (webhooks.server.js).
export const action = async ({ request }) => {
  const { shop, payload } = await verifyWebhook(request);
  forgetPlan(shop);
  const subscription = payload?.app_subscription;
  const status = String(subscription?.status || "").toUpperCase();
  if (subscription?.name === EARLY_BIRD.name && (status === "CANCELLED" || status === "EXPIRED")) {
    await lapseEarlyBird(shop);
  }
  return new Response();
};
