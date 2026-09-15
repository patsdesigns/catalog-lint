import prisma from "../db.server";

// One row per background scan (a Shopify bulk operation). At most one is running per shop.

export async function activeJob(shop) {
  return prisma.scanJob.findFirst({ where: { shop, status: "running" }, orderBy: { createdAt: "desc" } });
}

export async function createJob(shop, operationId, expected) {
  return prisma.scanJob.create({ data: { shop, operationId, expected } });
}

export async function updateJob(id, data) {
  return prisma.scanJob.update({ where: { id }, data });
}

// The shape the page renders.
export function jobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    expected: job.expected,
    objects: job.objects,
    error: job.error,
    startedAt: job.createdAt.toISOString(),
  };
}
