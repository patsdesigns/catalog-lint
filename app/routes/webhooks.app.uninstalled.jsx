import db from "../db.server";
import { forgetPlan, lapseEarlyBird } from "../lib/billing.server";
import { verifyWebhook } from "../lib/webhooks.server";

// app/uninstalled: the shop can no longer be reached, so everything that would act on its behalf
// stops. Its data stays until shop/redact, 48 hours later. Webhooks can arrive more than once, so
// every step here is safe to repeat. Verified without the library's session handling
// (webhooks.server.js): renewing the shop's expired token is exactly what fails after an uninstall.
export const action = async ({ request }) => {
  const { shop } = await verifyWebhook(request);

  await db.session.deleteMany({ where: { shop } });
  forgetPlan(shop);
  // Uninstalling ends the subscription, and with it the Early Bird seat.
  await lapseEarlyBird(shop);
  // No weekly email, no queued products, no export to finish.
  await db.digestSettings.updateMany({ where: { shop }, data: { enabled: false } });
  await db.pendingProduct.deleteMany({ where: { shop } });
  await db.scanJob.updateMany({ where: { shop, status: "running" }, data: { status: "failed", error: "The app was uninstalled." } });

  return new Response();
};
