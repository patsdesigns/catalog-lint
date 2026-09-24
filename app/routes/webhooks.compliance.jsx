import db from "../db.server";
import { verifyWebhook } from "../lib/webhooks.server";

// Privacy (GDPR) webhooks, mandatory for a public app. TidyUp keeps no customer data, so the two
// customer topics have nothing to return or erase; shop/redact, sent 48 hours after an uninstall,
// removes everything kept for the shop. verifyWebhook rejects a bad HMAC with a 401, and never
// touches the shop's session, which is gone or expired by the time these arrive.

export const action = async ({ request }) => {
  const { shop, topic } = await verifyWebhook(request);

  if (topic === "SHOP_REDACT") await redactShop(shop);

  return new Response();
};

// Every row that carries the shop, in one transaction. The Early Bird claim keeps its seat (the
// offer counts fifty stores, and a store claims once) but loses the shop domain.
async function redactShop(shop) {
  await db.$transaction(async (tx) => {
    await tx.scan.deleteMany({ where: { shop } });
    await tx.scanJob.deleteMany({ where: { shop } });
    await tx.fixLog.deleteMany({ where: { shop } });
    await tx.ignore.deleteMany({ where: { shop } });
    await tx.dictionaryWord.deleteMany({ where: { shop } });
    await tx.setting.deleteMany({ where: { shop } });
    await tx.supportMessage.deleteMany({ where: { shop } });
    await tx.pendingProduct.deleteMany({ where: { shop } });
    await tx.dailySnapshot.deleteMany({ where: { shop } });
    await tx.digestSettings.deleteMany({ where: { shop } });
    await tx.trackedMetafield.deleteMany({ where: { shop } });
    await tx.session.deleteMany({ where: { shop } });
    const claim = await tx.earlyBirdClaim.findUnique({ where: { shop } });
    if (claim) await tx.earlyBirdClaim.update({ where: { id: claim.id }, data: { shop: `redacted-${claim.id}`, subscriptionId: "", status: "lapsed" } });
  });
}
