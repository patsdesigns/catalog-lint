import { authenticate } from "../shopify.server";
import db from "../db.server";

// Privacy (GDPR) webhooks, mandatory for a public app. TidyUp keeps no customer data, so the two
// customer topics have nothing to return or erase; shop/redact, sent 48 hours after an uninstall,
// removes everything kept for the shop. authenticate.webhook rejects a bad HMAC with a 401.

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await db.$transaction([
      db.scan.deleteMany({ where: { shop } }),
      db.scanJob.deleteMany({ where: { shop } }),
      db.fixLog.deleteMany({ where: { shop } }),
      db.ignore.deleteMany({ where: { shop } }),
      db.dictionaryWord.deleteMany({ where: { shop } }),
      db.setting.deleteMany({ where: { shop } }),
      db.supportMessage.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
