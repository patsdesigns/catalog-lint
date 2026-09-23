import prisma from "../db.server";
import { ensureDailySnapshot } from "./snapshots.server";

// One row per saved result. Findings, the rule summary and the list of checks that ran are stored
// as JSON strings so the overview can render instantly without re-reading the catalog. Every save
// is a new row (an older row is what Undo of an ignored check reads), and the rows are pruned: the
// last KEEP_ROWS results and the last KEEP_FULL full scans of a shop stay, the rest go.

const KEEP_ROWS = 20;
const KEEP_FULL = 12;

export async function saveScan(shop, result) {
  const row = await prisma.scan.create({
    data: {
      shop,
      score: result.score,
      total: result.total,
      clean: result.clean,
      durationMs: result.durationMs,
      rules: JSON.stringify(result.rules),
      findings: JSON.stringify(result.findings),
      checks: JSON.stringify(result.checks || []),
      names: JSON.stringify(result.names || []),
      context: JSON.stringify(result.context || {}),
      full: Boolean(result.full),
      catalogTotal: result.catalogTotal ?? result.total,
      readAt: result.readAt ? new Date(result.readAt) : new Date(),
      productIds: JSON.stringify(result.productIds || []),
    },
  });
  // The first result saved on a day is that day's snapshot (clean streak, weekly digest).
  await ensureDailySnapshot(shop, result);
  await pruneScans(shop);
  return toResult(row);
}

async function pruneScans(shop) {
  const [recent, full] = await Promise.all([
    prisma.scan.findMany({ where: { shop }, orderBy: { id: "desc" }, take: KEEP_ROWS, select: { id: true } }),
    prisma.scan.findMany({ where: { shop, full: true }, orderBy: { id: "desc" }, take: KEEP_FULL, select: { id: true } }),
  ]);
  const keep = [...new Set([...recent, ...full].map((r) => r.id))];
  await prisma.scan.deleteMany({ where: { shop, id: { notIn: keep } } });
}

export async function latestScan(shop) {
  const row = await prisma.scan.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });
  return row ? toResult(row) : null;
}

// The latest result without its findings and product ids: what the home page needs, read without
// parsing the big JSON columns. `open` and `high` come from the per-check counts.
export async function latestScanSummary(shop) {
  const row = await prisma.scan.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
    select: { id: true, score: true, total: true, clean: true, durationMs: true, rules: true, checks: true, catalogTotal: true, readAt: true, createdAt: true, full: true },
  });
  if (!row) return null;
  const rules = parse(row.rules, [], row.id, "rules");
  return {
    id: row.id,
    score: row.score,
    total: row.total,
    clean: row.clean,
    durationMs: row.durationMs,
    rules,
    checks: parse(row.checks, [], row.id, "checks"),
    open: rules.reduce((n, r) => n + (r.count || 0), 0),
    high: rules.filter((r) => r.severity === "high").reduce((n, r) => n + (r.count || 0), 0),
    catalogTotal: row.catalogTotal || row.total,
    truncated: (row.catalogTotal || row.total) > row.total,
    readAt: (row.readAt || row.createdAt).toISOString(),
    scannedAt: row.createdAt.toISOString(),
    ignoredCount: 0,
  };
}

// One stored result by id: the row that still holds the findings of an ignored check (checks.server.js).
export async function scanById(shop, id) {
  const row = await prisma.scan.findFirst({ where: { id: Number(id), shop } });
  return row ? toResult(row) : null;
}

// How many results were saved after the given one.
export async function scansSince(shop, id) {
  return prisma.scan.count({ where: { shop, id: { gt: Number(id) } } });
}

// The last few full scans, oldest first, each with its open-problem count. The count comes from
// the small per-check summary rather than the findings JSON, which can run to megabytes on a big
// store.
export async function scanHistory(shop, limit = KEEP_FULL) {
  const rows = await prisma.scan.findMany({
    where: { shop, full: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, rules: true, createdAt: true, total: true },
  });
  return rows.reverse().map((r) => ({
    open: parse(r.rules, [], r.id, "rules").reduce((n, rule) => n + (rule.count || 0), 0),
    total: r.total,
    at: r.createdAt.toISOString(),
  }));
}

// A JSON column, or its fallback when the row is damaged: one bad row must not take the shop's
// pages down. The damage is logged once per read.
function parse(json, fallback, id, column) {
  if (json === null || json === undefined || json === "") return fallback;
  try {
    return JSON.parse(json);
  } catch {
    console.error(`Scan ${id}: the ${column} column is not valid JSON`);
    return fallback;
  }
}

function toResult(row) {
  const findings = parse(row.findings, null, row.id, "findings");
  return {
    id: row.id,
    score: row.score,
    total: row.total,
    clean: row.clean,
    durationMs: row.durationMs,
    rules: parse(row.rules, [], row.id, "rules"),
    findings: findings || [],
    corrupt: findings === null, // the findings could not be read; a new scan replaces them
    checks: parse(row.checks, [], row.id, "checks"), // scans saved before checks were recorded have none
    names: parse(row.names, [], row.id, "names"), // catalog names the title spell check trusts
    context: parse(row.context, {}, row.id, "context"), // what the catalog as a whole suggested (rules.server.js catalogContext)
    full: Boolean(row.full),
    catalogTotal: row.catalogTotal || row.total,
    truncated: (row.catalogTotal || row.total) > row.total, // a plan limit left products unscanned
    readAt: (row.readAt || row.createdAt).toISOString(), // when the catalog was read: new products are those added since
    productIds: parse(row.productIds, [], row.id, "productIds"), // every product the scan covers
    scannedAt: row.createdAt.toISOString(),
  };
}
