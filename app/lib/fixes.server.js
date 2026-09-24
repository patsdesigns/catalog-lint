import { RULE_CATALOG } from "./rules.server";
import { FIX_NAMES } from "./checkLabels";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { fetchProductsByIds } from "./scan.server";
import { setProductField, setVariantField, revert } from "./writes.server";

// Every fix re-reads the products it touches first so it never acts on stale data, a few at a
// time and only as far as the budget of one run reaches. Every change is logged as soon as it is
// made, with its previous value, so a whole batch can be undone even when a later write fails.

export const MAX_MUTATIONS_PER_RUN = 100;
const READ_BATCH = 20;

// A fixer walks the re-read products and spends the shared budget. `result.skipped` counts
// products that changed since the scan, `result.overBudget` the writes left for the next run.

// The canonical spelling was decided at scan time (the most common casing across the catalog) and
// travels with each finding as edit.suggested, so only the flagged products need re-reading.
async function fixVendorCasing(graphql, products, log, findingsByProduct, budget, result) {
  for (const p of products) {
    const edit = (findingsByProduct.get(p.id) || []).map((f) => f.edit).find((e) => e && e.suggested);
    const raw = (p.vendor || "").trim();
    if (!edit || raw === edit.suggested) continue; // already the spelling to keep
    if (raw !== edit.current) {
      result.skipped += 1; // changed since the scan
      continue;
    }
    if (budget.left <= 0) {
      result.overBudget += 1;
      continue;
    }
    budget.left -= 1;
    const errs = await setProductField(graphql, p.id, "vendor", edit.suggested);
    if (errs.length) result.errors.push(`${p.title}: ${errs.join(", ")}`);
    else {
      result.fixed += 1;
      await log({ field: "vendor", targetId: p.id, productId: p.id, title: p.title, before: raw, after: edit.suggested });
    }
  }
}

async function fixCompareAt(graphql, products, log, findingsByProduct, budget, result) {
  for (const p of products) {
    const bad = p.variants.filter(
      (v) => v.compareAtPrice !== null && v.compareAtPrice !== undefined && Number(v.compareAtPrice) <= Number(v.price),
    );
    for (const v of bad) {
      if (budget.left <= 0) {
        result.overBudget += 1;
        continue;
      }
      budget.left -= 1;
      const errs = await setVariantField(graphql, p.id, v.id, "compareAt", "");
      if (errs.length) result.errors.push(`${p.title} / ${v.title}: ${errs.join(", ")}`);
      else {
        result.fixed += 1;
        await log({
          field: "compareAt",
          targetId: v.id,
          productId: p.id,
          title: `${p.title} / ${v.title}`,
          before: v.compareAtPrice,
          after: null,
        });
      }
    }
  }
}

const FIXERS = {
  vendor_casing: fixVendorCasing,
  compare_at_not_higher: fixCompareAt,
};

// findings: the latest scan's findings. Only the products this rule flagged are read and touched,
// READ_BATCH at a time, and reading stops once the budget is spent.
export async function applyFix(graphql, shop, ruleId, findings) {
  const fixer = FIXERS[ruleId];
  if (!fixer) throw new Error(`No fix available for ${ruleId}`);

  const findingsByProduct = new Map();
  for (const f of findings) {
    if (f.ruleId !== ruleId) continue;
    if (!findingsByProduct.has(f.productId)) findingsByProduct.set(f.productId, []);
    findingsByProduct.get(f.productId).push(f);
  }
  const ids = [...findingsByProduct.keys()];
  const batchId = randomUUID();
  const entries = [];
  const log = async (e) => {
    entries.push(e);
    await prisma.fixLog.create({
      data: {
        shop,
        batchId,
        ruleId,
        field: e.field,
        targetId: e.targetId,
        productId: e.productId,
        title: e.title,
        before: JSON.stringify(e.before),
        after: JSON.stringify(e.after),
      },
    });
  };
  const budget = { left: MAX_MUTATIONS_PER_RUN };
  const result = { fixed: 0, skipped: 0, overBudget: 0, perRun: MAX_MUTATIONS_PER_RUN, errors: [] };

  for (let i = 0; i < ids.length; i += READ_BATCH) {
    if (budget.left <= 0) {
      result.overBudget += ids.length - i; // products not even read this run
      break;
    }
    const products = await fetchProductsByIds(graphql, ids.slice(i, i + READ_BATCH));
    await fixer(graphql, products, log, findingsByProduct, budget, result);
  }

  return { ...result, batchId: entries.length ? batchId : null, productIds: [...new Set(entries.map((e) => e.productId))] };
}

// Reverts a batch, or only one product of it when productId is given. An entry whose field no
// longer holds what the fix wrote (changed since, or gone) is left as it is and closed.
export async function undoFix(graphql, shop, batchId, productId = null) {
  const entries = await prisma.fixLog.findMany({
    where: { shop, batchId, undone: false, ...(productId ? { productId } : {}) },
  });
  const result = { undone: 0, stale: 0, errors: [] };

  for (const e of entries) {
    const { errors, stale } = await revert(graphql, e);
    if (stale) {
      result.stale += 1;
      result.errors.push(`${e.title}: ${errors.join(", ")}`);
      await prisma.fixLog.update({ where: { id: e.id }, data: { undone: true } });
    } else if (errors.length) {
      result.errors.push(`${e.title}: ${errors.join(", ")}`);
    } else {
      result.undone += 1;
      await prisma.fixLog.update({ where: { id: e.id }, data: { undone: true } });
    }
  }
  return { ...result, productIds: [...new Set(entries.map((e) => e.productId))] };
}

// The latest batches still in place. A batch that touched one product carries its title; the
// batch page (fixBatch) lists the products of bigger ones.
export async function recentFixes(shop, limit = 5) {
  const rows = await prisma.fixLog.groupBy({
    by: ["batchId", "ruleId"],
    where: { shop, undone: false },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: limit,
  });
  const perProduct = rows.length
    ? await prisma.fixLog.groupBy({
        by: ["batchId", "productId"],
        where: { shop, undone: false, batchId: { in: rows.map((r) => r.batchId) } },
        _max: { title: true },
      })
    : [];
  const titles = new Map();
  for (const p of perProduct) {
    if (!titles.has(p.batchId)) titles.set(p.batchId, []);
    titles.get(p.batchId).push(p._max.title || "");
  }
  return rows.map((r) => {
    const products = titles.get(r.batchId) || [];
    return {
      batchId: r.batchId,
      ruleId: r.ruleId,
      label: fixLabel(r.ruleId),
      count: r._count._all,
      productCount: products.length,
      productTitle: products.length === 1 ? products[0] : null,
      at: r._max.createdAt.toISOString(),
    };
  });
}

// One batch still in place: its products, each with how many changes and which fields, or null
// once everything in it has been undone.
export async function fixBatch(shop, batchId) {
  const entries = await prisma.fixLog.findMany({
    where: { shop, batchId, undone: false },
    select: { ruleId: true, productId: true, title: true, field: true, createdAt: true },
    orderBy: { id: "asc" },
  });
  if (!entries.length) return null;
  const products = new Map();
  for (const e of entries) {
    const p = products.get(e.productId) || { productId: e.productId, title: e.title, changes: 0, fields: [] };
    p.changes += 1;
    if (!p.fields.includes(e.field)) p.fields.push(e.field);
    products.set(e.productId, p);
  }
  return {
    batchId,
    ruleId: entries[0].ruleId,
    label: fixLabel(entries[0].ruleId),
    count: entries.length,
    at: entries[0].createdAt.toISOString(),
    products: [...products.values()].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

// What a fix is called in the Recent fixes card and on its page: a short name for the bulk fixes
// (checkLabels.js), the check label for saved edits.
export function fixLabel(ruleId) {
  if (FIX_NAMES[ruleId]) return FIX_NAMES[ruleId];
  const rule = RULE_CATALOG.find((r) => r.id === ruleId);
  if (rule) return rule.label;
  return ruleId === "edit" ? "Edit" : ruleId.replace(/_/g, " ");
}

// Fixes still in place (bulk fixes and saved edits alike): within the last `days`, or ever.
export async function fixedCount(shop, days) {
  const where = { shop, undone: false };
  if (days) where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  return prisma.fixLog.count({ where });
}
