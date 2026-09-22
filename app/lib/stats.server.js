import prisma from "../db.server";
import { EARLY_BIRD_SEATS } from "./plans";

// Numbers for the app owner, never shown to merchants: installs, scans, fixes, support, digests and
// the Early Bird seats. Printed by the harness stats script on request.
export async function adminStats() {
  const [shops, scans, fixes, undone, support, digests, claims, lapsed] = await Promise.all([
    prisma.session.findMany({ distinct: ["shop"], select: { shop: true } }).then((rows) => rows.length),
    prisma.scan.count(),
    prisma.fixLog.count({ where: { undone: false } }),
    prisma.fixLog.count({ where: { undone: true } }),
    prisma.supportMessage.count(),
    prisma.digestSettings.count({ where: { enabled: true } }),
    prisma.earlyBirdClaim.count(),
    prisma.earlyBirdClaim.count({ where: { status: "lapsed" } }),
  ]);
  return {
    shops,
    scans,
    fixes: { inPlace: fixes, undone },
    supportMessages: support,
    digestSubscribers: digests,
    earlyBird: { seats: EARLY_BIRD_SEATS, claimed: claims, active: claims - lapsed, lapsed, left: Math.max(0, EARLY_BIRD_SEATS - claims) },
  };
}
