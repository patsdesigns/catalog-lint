import prisma from "../db.server";

export function ignoreKey(f) {
  return [f.ruleId, f.productId, f.variantId || "", f.word || ""].join("|");
}

export async function getIgnores(shop) {
  return prisma.ignore.findMany({ where: { shop }, orderBy: { createdAt: "desc" } });
}

export async function getIgnoreKeys(shop) {
  const rows = await prisma.ignore.findMany({ where: { shop }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

export async function addIgnore(shop, f) {
  const key = ignoreKey(f);
  await prisma.ignore.upsert({
    where: { shop_key: { shop, key } },
    update: {},
    create: {
      shop,
      key,
      ruleId: f.ruleId,
      productId: f.productId,
      title: f.productTitle || "",
      detail: f.detail || "",
    },
  });
}

export async function removeIgnore(shop, id) {
  await prisma.ignore.deleteMany({ where: { shop, id: Number(id) } });
}
