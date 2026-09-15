import prisma from "../db.server";

// One row per scan. Findings, the rule summary and the list of checks that ran are stored as
// JSON strings so the overview can render instantly without re-reading the catalog.

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
    },
  });
  return toResult(row);
}

export async function latestScan(shop) {
  const row = await prisma.scan.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });
  return row ? toResult(row) : null;
}

export async function scanHistory(shop, limit = 12) {
  const rows = await prisma.scan.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { score: true, createdAt: true, total: true },
  });
  return rows.reverse().map((r) => ({
    score: r.score,
    total: r.total,
    at: r.createdAt.toISOString(),
  }));
}

function toResult(row) {
  return {
    id: row.id,
    score: row.score,
    total: row.total,
    clean: row.clean,
    durationMs: row.durationMs,
    rules: JSON.parse(row.rules),
    findings: JSON.parse(row.findings),
    checks: JSON.parse(row.checks || "[]"), // scans saved before checks were recorded have none
    scannedAt: row.createdAt.toISOString(),
  };
}
