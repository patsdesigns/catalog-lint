import prisma from "../db.server";

// One DailySnapshot per shop per day: potential problems, high-severity problems and the fixes in
// place, written by the first saved result of the day (a scan, an action or a webhook). The
// overview's clean streak and the weekly digest read them.

const day = (date = new Date()) => date.toISOString().slice(0, 10);

function previousDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return day(d);
}

// Records today's snapshot from a scan result unless one exists. Two saves racing for the first
// slot both end up with the one row (the unique constraint settles it).
export async function ensureDailySnapshot(shop, result) {
  const date = day();
  const existing = await prisma.dailySnapshot.findUnique({ where: { shop_date: { shop, date } } });
  if (existing) return existing;
  const findings = result.findings || [];
  const fixed = await prisma.fixLog.count({ where: { shop, undone: false } });
  try {
    return await prisma.dailySnapshot.create({
      data: {
        shop,
        date,
        potentialProblems: findings.length,
        highSeverityProblems: findings.filter((f) => f.severity === "high").length,
        fixed,
      },
    });
  } catch (err) {
    if (err?.code === "P2002") return prisma.dailySnapshot.findUnique({ where: { shop_date: { shop, date } } });
    throw err;
  }
}

// How many consecutive days, ending at the latest snapshot, had no high-severity problems.
export async function cleanStreak(shop) {
  const rows = await prisma.dailySnapshot.findMany({ where: { shop }, orderBy: { date: "desc" }, take: 366 });
  let days = 0;
  let expected = null;
  for (const row of rows) {
    if (row.highSeverityProblems !== 0) break;
    if (expected && row.date !== expected) break;
    days += 1;
    expected = previousDay(row.date);
  }
  return days;
}

// The most recent snapshot on or before `daysAgo` days ago, for "change since last week".
export async function snapshotDaysAgo(shop, daysAgo) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysAgo);
  return prisma.dailySnapshot.findFirst({ where: { shop, date: { lte: day(cutoff) } }, orderBy: { date: "desc" } });
}
