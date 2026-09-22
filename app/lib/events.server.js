import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { latestScan, saveScan } from "./scans.server";
import { recheckProducts } from "./scan.server";
import { planForShop } from "./billing.server";

// The products/create and products/update routes: verify the webhook, work out the plan from the
// shop's subscription and apply the event. Always answers 200, so Shopify does not retry.
export async function productWebhook(request, { created }) {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const productId = payload?.admin_graphql_api_id;
  if (!admin || !productId) return new Response();
  try {
    const plan = await planForShop(admin.graphql);
    const outcome = await handleProductEvent(admin.graphql, shop, productId, { created, plan });
    console.log(`${topic} for ${shop}: ${productId} ${outcome.mode}`);
  } catch (err) {
    console.error(`${topic} for ${shop} failed`, err);
  }
  return new Response();
}

// Product webhooks (products/create, products/update) keep the stored scan current one product at a
// time. Quick Clean and up re-check the product at once; Dust Off queues it (PendingProduct) for the
// Scan New Products button.

// One shop's updates run one after another: two webhooks for the same shop would otherwise read the
// same stored scan and the second write would lose the first.
const locks = new Map();
export function withShopLock(shop, fn) {
  const previous = locks.get(shop) || Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.finally(() => {
    if (locks.get(shop) === settled) locks.delete(shop);
  });
  locks.set(shop, settled);
  return next;
}

// A product was created or updated. Returns what happened: processed (the scan was updated),
// pending (queued for the button), or no-scan (nothing to update yet).
export async function handleProductEvent(graphql, shop, productId, { created = false, plan }) {
  if (!plan.features.autoRescan) {
    await prisma.pendingProduct.upsert({
      where: { shop_productId: { shop, productId } },
      update: { created: created || undefined },
      create: { shop, productId, created },
    });
    return { mode: "pending" };
  }
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
