import { digestRecipients, sendDigest } from "../lib/digest.server";

// Sends the weekly email to every shop that turned it on. Called by the host's scheduler once a
// week (GET or POST) with the CRON_SECRET, as a bearer token or an X-Cron-Secret header.

async function run(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: "CRON_SECRET is not set." }, { status: 503 });
  const given = request.headers.get("x-cron-secret") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (given !== secret) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const sent = [];
  const failed = [];
  for (const { shop, email } of await digestRecipients()) {
    try {
      await sendDigest(shop, email);
      sent.push(shop);
    } catch (err) {
      failed.push({ shop, error: err.message || String(err) });
    }
  }
  console.log(`Weekly digest: ${sent.length} sent, ${failed.length} failed`);
  return Response.json({ ok: true, sent, failed });
}

export const loader = ({ request }) => run(request);
export const action = ({ request }) => run(request);
