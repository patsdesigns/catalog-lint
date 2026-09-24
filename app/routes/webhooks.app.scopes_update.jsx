import db from "../db.server";
import { verifyWebhook } from "../lib/webhooks.server";

// app/scopes_update: the stored session remembers the scopes the merchant has granted. Verified
// without the library's session handling (webhooks.server.js), since only the scopes change here.
export const action = async ({ request }) => {
  const { shop, payload } = await verifyWebhook(request);
  const current = payload?.current;

  if (current) {
    await db.session.updateMany({
      where: { shop, isOnline: false },
      data: { scope: current.toString() },
    });
  }

  return new Response();
};
