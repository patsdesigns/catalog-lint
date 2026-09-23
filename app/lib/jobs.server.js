import prisma from "../db.server";

// One row per background scan (a Shopify bulk operation). At most one is open per shop: running
// while Shopify exports, finishing while the app downloads the export and runs the checks.

export const OPEN_STATUSES = ["running", "finishing"];

export async function activeJob(shop) {
  return prisma.scanJob.findFirst({ where: { shop, status: { in: OPEN_STATUSES } }, orderBy: { createdAt: "desc" } });
}

// The tracked metafields the export query was built with are kept with the job: the export is
// read with the same list, whatever the settings say by the time it finishes.
export async function createJob(shop, operationId, expected, tracked = []) {
  return prisma.scanJob.create({ data: { shop, operationId, expected, tracked: JSON.stringify(tracked) } });
}

export function jobTracked(job) {
  try {
    const list = JSON.parse(job.tracked || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function updateJob(id, data) {
  return prisma.scanJob.update({ where: { id }, data });
}

// Moves a job from one status to another only if it still has the first: the request that wins
// the move does the work, the others keep polling. Returns true for the winner.
export async function claimJob(id, from, to, data = {}) {
  const { count } = await prisma.scanJob.updateMany({ where: { id, status: from }, data: { status: to, ...data } });
  return count === 1;
}

// The shape the page renders. Finishing shows as running with a note.
export function jobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status === "finishing" ? "running" : job.status,
    finishing: job.status === "finishing",
    expected: job.expected,
    objects: job.objects,
    error: job.error,
    startedAt: job.createdAt.toISOString(),
  };
}
