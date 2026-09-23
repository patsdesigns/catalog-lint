import { authenticate } from "../shopify.server";
import db from "../db.server";

// app/scopes_update: the session remembers the scopes the merchant has granted.
export const action = async ({ request }) => {
  const { payload, session } = await authenticate.webhook(request);
  const current = payload?.current;

  if (session && current) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }

  return new Response();
};
