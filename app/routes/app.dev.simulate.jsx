import { authenticate } from "../shopify.server";
import { currentPlan } from "../lib/billing.server";
import { handleProductEvent } from "../lib/events.server";

// Development only: pretends a products/update (or products/create) webhook arrived for one product,
// since a localhost dev session cannot receive real webhooks. Open it inside the app:
//   /app/dev/simulate?product=<numeric id or gid>&event=update|create
// Answers JSON with what the handler did. A 404 in production.

export async function loader({ request }) {
  // eslint-disable-next-line no-undef
  if (process.env.NODE_ENV === "production") throw new Response("Not found", { status: 404 });
  const { admin, session, billing } = await authenticate.admin(request);
  const url = new URL(request.url);
  const raw = (url.searchParams.get("product") || "").trim();
  if (!raw) return Response.json({ ok: false, error: "Add ?product=<numeric id or gid> to the URL." }, { status: 400 });
  const productId = raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
  const created = url.searchParams.get("event") === "create";
  const { plan } = await currentPlan(billing, admin.graphql, session.shop);
  const started = Date.now();
  const outcome = await handleProductEvent(admin.graphql, session.shop, productId, { created, plan });
  return Response.json({ ok: true, shop: session.shop, plan: plan.name, productId, event: created ? "products/create" : "products/update", ...outcome, ms: Date.now() - started });
}
