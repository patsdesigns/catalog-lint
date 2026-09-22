import { authenticate } from "../shopify.server";
import { lapseEarlyBird } from "../lib/billing.server";
import { EARLY_BIRD } from "../lib/plans";

// app_subscriptions/update: when the Early Bird subscription is cancelled or expires, the seat
// lapses. Other subscriptions need nothing; plan checks read live subscriptions.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const subscription = payload?.app_subscription;
  const status = String(subscription?.status || "").toUpperCase();
  console.log(`Received ${topic} webhook for ${shop}: ${subscription?.name || "?"} ${status}`);
  if (subscription?.name === EARLY_BIRD.name && (status === "CANCELLED" || status === "EXPIRED")) {
    await lapseEarlyBird(shop);
  }
  return new Response();
};
