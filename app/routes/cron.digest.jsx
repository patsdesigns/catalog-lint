import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { unauthenticated } from "../shopify.server";
import { digestRecipients, sendDigest } from "../lib/digest.server";
import { planForShop } from "../lib/billing.server";
import { shopInfo } from "../lib/shop.server";

// Sends the weekly email to every shop that turned it on and whose plan includes it. Called by the
// host's scheduler once a week (GET or POST) with the CRON_SECRET, as a bearer token or an
// X-Cron-Secret header.

function secretMatches(given, secret) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(secret));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: "CRON_SECRET is not set." }, { status: 503 });
  const given = request.headers.get("x-cron-secret") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secretMatches(given, secret)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const sent = [];
  const skipped = [];
  const failed = [];
  for (const { shop, email } of await digestRecipients()) {
    try {
      // A shop with no session was uninstalled; one whose plan lost the email is skipped.
      let admin;
      try {
        ({ admin } = await unauthenticated.admin(shop));
      } catch {
        skipped.push({ shop, reason: "not installed" });
        continue;
      }
      const plan = await planForShop(admin.graphql, shop);
      if (!plan.features.weeklyDigest) {
        skipped.push({ shop, reason: `not in the ${plan.name} plan` });
        continue;
      }
      const info = await shopInfo(admin.graphql, shop);
      await sendDigest(shop, email, info.locale);
      sent.push(shop);
    } catch (err) {
      failed.push({ shop, error: err.message || String(err) });
    }
  }
  console.log(`Weekly email: ${sent.length} sent, ${skipped.length} skipped, ${failed.length} failed`);
  return Response.json({ ok: true, sent, skipped, failed });
}

export const loader = ({ request }) => run(request);
export const action = ({ request }) => run(request);
