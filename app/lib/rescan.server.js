// How the stored scan is kept current.
//
// A full scan reads the whole catalog: inline for small catalogs, through a background bulk
// operation for large ones. After a merchant action (fix, undo, edit, ignore, learn) a small
// catalog is simply rescanned; a large one is refreshed incrementally so that one edit never
// waits on a full re-read.

import {
  SYNC_LIMIT,
  countProducts,
  scanCatalog,
  scanProducts,
  startBulkScan,
  bulkScanStatus,
  downloadBulkCatalog,
  recheckProducts,
} from "./scan.server";
import { saveScan, latestScan } from "./scans.server";
import { summarizeFindings } from "./rules.server";
import { ignoreKey } from "./ignores.server";
import { getSettings } from "./settings.server";
import { activeJob, createJob, updateJob, jobView } from "./jobs.server";

// Starts a full scan. Returns the running job for a large catalog, or null when the scan already
// completed inline.
export async function startScan(graphql, shop) {
  const running = await activeJob(shop);
  if (running) return jobView(running);
  const count = await countProducts(graphql);
  if (count <= SYNC_LIMIT) {
    await saveScan(shop, await scanCatalog(graphql, shop));
    return null;
  }
  const operationId = await startBulkScan(graphql);
  return jobView(await createJob(shop, operationId, count));
}

// Called from the page loader: moves the running job along. Finishes it (downloads the export,
// runs the rules, saves the scan) once Shopify is done. Returns the job to show, or null.
export async function advanceJob(graphql, shop) {
  const job = await activeJob(shop);
  if (!job) return null;

  const fail = (error) => updateJob(job.id, { status: "failed", error }).then(jobView);

  let op;
  try {
    op = await bulkScanStatus(graphql, job.operationId);
  } catch (err) {
    return fail(err.message || String(err));
  }
  if (!op) return fail("Shopify no longer has this export.");

  if (op.status === "COMPLETED") {
    try {
      const products = op.url ? await downloadBulkCatalog(op.url) : [];
      const result = await scanProducts(products, graphql, shop, job.createdAt.getTime());
      await saveScan(shop, result);
      await updateJob(job.id, { status: "done", objects: Number(op.objectCount || 0) });
      return null;
    } catch (err) {
      return fail(err.message || String(err));
    }
  }
  if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
    return fail(`Shopify ${op.status.toLowerCase()} the export${op.errorCode ? ` (${op.errorCode})` : ""}.`);
  }
  // CREATED, RUNNING, CANCELING: keep polling.
  return jobView(await updateJob(job.id, { objects: Number(op.objectCount || 0) }));
}

// Brings the stored scan up to date after an action.
//   { kind: "ignore", finding }            the finding the merchant chose to ignore
//   { kind: "learn", word }                a word added to the dictionary
//   { kind: "products", ids, ruleId }      products that were changed, and the rule acted on
export async function refreshAfter(graphql, shop, change) {
  const latest = await latestScan(shop);
  if (!latest) return;

  // Small catalogs: a full rescan is quick and keeps catalog-wide rules exact.
  if (latest.total <= SYNC_LIMIT) {
    await saveScan(shop, await scanCatalog(graphql, shop));
    return;
  }

  const settings = await getSettings(shop);
  let next;
  if (change.kind === "ignore") {
    const key = ignoreKey(change.finding);
    next = withFindings(latest, latest.findings.filter((f) => ignoreKey(f) !== key), settings, 1);
  } else if (change.kind === "learn") {
    const word = String(change.word || "").toLowerCase();
    next = withFindings(latest, latest.findings.filter((f) => !(f.ruleId === "spelling" && (f.word || "").toLowerCase() === word)), settings);
  } else if (change.ids?.length) {
    next = await recheckProducts(graphql, shop, latest, change.ids, change.ruleId || null);
  } else {
    return;
  }
  await saveScan(shop, next);
}

function withFindings(latest, findings, settings, ignoredDelta = 0) {
  return {
    ...summarizeFindings(latest.total, findings, settings),
    findings,
    ignoredCount: (latest.ignoredCount || 0) + ignoredDelta,
    scannedAt: new Date().toISOString(),
    durationMs: 0,
  };
}
