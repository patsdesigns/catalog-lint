import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { fetchCatalog } from "./scan.server";
import { setProductField, setVariantField, setAlt, revert } from "./writes.server";

// Every fix re-reads the catalog first so it never acts on stale data.
// Every change is logged with its previous value so a whole batch can be undone.

const MAX_MUTATIONS_PER_RUN = 100;

async function fixVendorCasing(graphql, products, log) {
  const groups = new Map();
  for (const p of products) {
    const raw = (p.vendor || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase().replace(/\s+/g, " ");
    if (!groups.has(key)) groups.set(key, new Map());
    const counts = groups.get(key);
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }

  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;

  for (const [key, counts] of groups) {
    if (counts.size < 2) continue;
    const canonical = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const p of products) {
      const raw = (p.vendor || "").trim();
      if (raw.toLowerCase().replace(/\s+/g, " ") !== key || raw === canonical) continue;
      if (budget-- <= 0) {
        result.skipped += 1;
        continue;
      }
      const errs = await setProductField(graphql, p.id, "vendor", canonical);
      if (errs.length) result.errors.push(`${p.title}: ${errs.join(", ")}`);
      else {
        result.fixed += 1;
        log({ field: "vendor", targetId: p.id, productId: p.id, title: p.title, before: raw, after: canonical });
      }
    }
  }
  return result;
}

async function fixMissingAltText(graphql, products, log) {
  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;

  for (const p of products) {
    const missing = p.images.filter((img) => !(img.alt || "").trim());
    for (const img of missing) {
      if (budget-- <= 0) {
        result.skipped += 1;
        continue;
      }
      const errs = await setAlt(graphql, p.id, img.id, p.title);
      if (errs.length) result.errors.push(`${p.title}: ${errs.join(", ")}`);
      else {
        result.fixed += 1;
        log({ field: "alt", targetId: img.id, productId: p.id, title: p.title, before: img.alt || "", after: p.title });
      }
    }
  }
  return result;
}

async function fixCompareAt(graphql, products, log) {
  const result = { fixed: 0, skipped: 0, errors: [] };
  let budget = MAX_MUTATIONS_PER_RUN;
  for (const p of products) {
    const bad = p.variants.filter(
      (v) =>
        v.compareAtPrice !== null &&
        v.compareAtPrice !== undefined &&
        Number(v.compareAtPrice) <= Number(v.price),
    );
    for (const v of bad) {
      if (budget-- <= 0) {
        result.skipped += 1;
        continue;
      }
      const errs = await setVariantField(graphql, p.id, v.id, "compareAt", "");
      if (errs.length) result.errors.push(`${p.title} / ${v.title}: ${errs.join(", ")}`);
      else {
        result.fixed += 1;
        log({
          field: "compareAt",
          targetId: v.id,
          productId: p.id,
          title: `${p.title} / ${v.title}`,
          before: v.compareAtPrice,
          after: "",
        });
      }
    }
  }
  return result;
}

const FIXERS = {
  vendor_casing: fixVendorCasing,
  missing_alt_text: fixMissingAltText,
  compare_at_not_higher: fixCompareAt,
};

export async function applyFix(graphql, shop, ruleId) {
  const fixer = FIXERS[ruleId];
  if (!fixer) throw new Error(`No fix available for ${ruleId}`);

  const products = await fetchCatalog(graphql);
  const batchId = randomUUID();
  const entries = [];
  const log = (e) => entries.push(e);

  const result = await fixer(graphql, products, log);

  if (entries.length) {
    await prisma.fixLog.createMany({
      data: entries.map((e) => ({
        shop,
        batchId,
        ruleId,
        field: e.field,
        targetId: e.targetId,
        productId: e.productId,
        title: e.title,
        before: JSON.stringify(e.before),
        after: JSON.stringify(e.after),
      })),
    });
  }

  return { ...result, batchId: entries.length ? batchId : null };
}

export async function undoFix(graphql, shop, batchId) {
  const entries = await prisma.fixLog.findMany({
    where: { shop, batchId, undone: false },
  });
  const result = { undone: 0, errors: [] };

  for (const e of entries) {
    const errs = await revert(graphql, e);
    if (errs.length) result.errors.push(`${e.title}: ${errs.join(", ")}`);
    else {
      result.undone += 1;
      await prisma.fixLog.update({ where: { id: e.id }, data: { undone: true } });
    }
  }
  return result;
}

export async function recentFixes(shop, limit = 5) {
  const rows = await prisma.fixLog.groupBy({
    by: ["batchId", "ruleId"],
    where: { shop, undone: false },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: limit,
  });
  return rows.map((r) => ({
    batchId: r.batchId,
    ruleId: r.ruleId,
    count: r._count._all,
    at: r._max.createdAt.toISOString(),
  }));
}

export async function fixedCount(shop, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return prisma.fixLog.count({ where: { shop, undone: false, createdAt: { gte: since } } });
}
