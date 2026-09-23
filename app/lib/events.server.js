import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { latestScan, saveScan } from "./scans.server";
import { recheckProducts } from "./scan.server";
import { planForShop } from "./billing.server";
import { withShopLock } from "./lock.server";

// The products/create and products/update routes: verify the webhook, answer 200 at once (Shopify
// expects an answer within five seconds and retries otherwise), then work out the plan from the
// shop's subscription and apply the event. The work is safe to repeat: it re-reads the product.
export async function productWebhook(request, { created }) {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const productId = payload?.admin_graphql_api_id;
  if (!admin || !productId) return new Response();
  void processProductEvent(admin.graphql, shop, productId, { created, topic }).catch((err) => {
    console.error(`${topic} for ${shop} failed: ${err?.message || err}`);
  });
  return new Response();
}

async function processProductEvent(graphql, shop, productId, { created, topic }) {
  let plan = null;
  try {
    plan = await planForShop(graphql, shop);
  } catch (err) {
    // The plan could not be read (a throttle, an outage): the product is queued rather than lost.
    console.error(`${topic} for ${shop}: could not read the plan, queued ${productId}: ${err.message}`);
  }
  if (plan) await handleProductEvent(graphql, shop, productId, { created, plan });
  else await queueProduct(shop, productId, created);
}

// Remembers a changed product for the Scan changed products button.
async function queueProduct(shop, productId, created) {
  await prisma.pendingProduct.upsert({
    where: { shop_productId: { shop, productId } },
    update: { created: created || undefined },
    create: { shop, productId, created },
  });
  return { mode: "pending" };
}

// Product webhooks (products/create, products/update) keep the stored scan current one product at a
// time. Quick Clean and up re-check the product at once; Dust Off queues it (PendingProduct) for the
// Scan New Products button.

// One shop's updates run one after another (lock.server.js): two webhooks for the same shop would
// otherwise read the same stored scan and the second write would lose the first.

// A product was created or updated. Returns what happened: processed (the scan was updated),
// pending (queued for the button), or no-scan (nothing to update yet).
export async function handleProductEvent(graphql, shop, productId, { created = false, plan }) {
  if (!plan.features.autoRescan) return queueProduct(shop, productId, created);
  return withShopLock(shop, async () => {
    const latest = await latestScan(shop);
    if (!latest) return { mode: "no-scan" };
    const next = await recheckProducts(graphql, shop, latest, [productId]);
    await saveScan(shop, next);
    const findings = next.findings.filter((f) => f.productId === productId).length;
    return { mode: "processed", findings, open: next.findings.length, total: next.total };
  });
}

export async function pendingCount(shop) {
  return prisma.pendingProduct.count({ where: { shop } });
}

// Dust Off: re-checks the products queued by webhooks in one go. Products the scan already knows
// are always re-checked; new ones only while the plan's product limit leaves room, and the rest stay
// queued. Returns null when nothing is queued.
export async function scanPendingProducts(graphql, shop, latest, plan) {
  const rows = await prisma.pendingProduct.findMany({ where: { shop }, orderBy: { id: "asc" }, take: 500 });
  if (!rows.length) return null;
  const known = new Set(latest.productIds || []);
  const room = plan.productLimit ? Math.max(0, plan.productLimit - latest.total) : Infinity;
  const updates = rows.filter((r) => known.has(r.productId));
  const creates = rows.filter((r) => !known.has(r.productId)).slice(0, room);
  const ids = [...updates, ...creates].map((r) => r.productId);
  let next = null;
  if (ids.length) {
    next = await recheckProducts(graphql, shop, latest, ids);
    await saveScan(shop, next);
    await prisma.pendingProduct.deleteMany({ where: { shop, productId: { in: ids } } });
  }
  return { scanned: ids.length, held: rows.length - ids.length, next };
}
