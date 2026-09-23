// How the stored scan is kept current.
//
// A full scan reads the whole catalog: inline for small catalogs, through a background bulk
// operation for large ones. After a merchant action (fix, edit, ignore, learn) the stored scan is
// refreshed incrementally whatever the catalog size, so a click never waits on a full re-read.
// Only Refresh on an issue page and Undo ask for a full rescan, and only a small catalog gets one.

import {
  SYNC_LIMIT,
  countProducts,
  scanCatalog,
  scanProducts,
  startBulkScan,
  bulkScanStatus,
  cancelBulkScan,
  downloadBulkCatalog,
  recheckProducts,
} from "./scan.server";

// A background job is given up after this long, whatever Shopify says about the export.
const STALE_JOB_MS = 24 * 60 * 60 * 1000;
// Polls and downloads that fail this many times in a row fail the job; fewer are retried next load.
const MAX_JOB_ERRORS = 5;
import { saveScan, latestScan } from "./scans.server";
import { summarizeFindings, knownFindings, capFindings } from "./rules.server";
import { ignoreKey } from "./ignores.server";
import { getSettings } from "./settings.server";
import { activeJob, createJob, updateJob, jobView } from "./jobs.server";

// Starts a full scan. Returns the running job for a large catalog, or null when the scan already
// completed inline.
// limit: the plan's product limit (null for unlimited); the scan covers at most that many products.
export async function startScan(graphql, shop, limit = null) {
  const running = await activeJob(shop);
  if (running) return jobView(running);
  const count = await countProducts(graphql);
  const toScan = limit ? Math.min(count, limit) : count;
  if (toScan <= SYNC_LIMIT) {
    await saveScan(shop, await scanCatalog(graphql, shop, limit));
    return null;
  }
  const operationId = await startBulkScan(graphql, (await getSettings(shop)).trackedMetafields || []);
  return jobView(await createJob(shop, operationId, count));
}

// Called from the page loader: moves the running job along. Finishes it (downloads the export,
// runs the rules, saves the scan) once Shopify is done. Returns the job to show, or null.
export async function advanceJob(graphql, shop, limit = null) {
  const job = await activeJob(shop);
  if (!job) return null;

  const fail = (error) => updateJob(job.id, { status: "failed", error }).then(jobView);
  // A passing error (a throttled poll, a download that did not finish) is kept and retried on the
  // next page load; only a run of them fails the job.
  const stumble = async (err) => {
    const errors = (job.errors || 0) + 1;
    const error = err.message || String(err);
    if (errors >= MAX_JOB_ERRORS) return fail(error);
    return jobView(await updateJob(job.id, { errors, error }));
  };

  if (Date.now() - job.createdAt.getTime() > STALE_JOB_MS) {
    try {
      await cancelBulkScan(graphql, job.operationId);
    } catch {
      // The export may already be gone; the job is given up either way.
    }
    return fail("The export took more than a day and was stopped. Run the scan again.");
  }

  let op;
  try {
    op = await bulkScanStatus(graphql, job.operationId);
  } catch (err) {
    return stumble(err);
  }
  if (!op) return fail("Shopify no longer has this export.");

  if (op.status === "COMPLETED") {
    try {
      const all = op.url ? await downloadBulkCatalog(op.url, (await getSettings(shop)).trackedMetafields || []) : [];
      const products = limit ? all.slice(0, limit) : all;
      const result = await scanProducts(products, graphql, shop, job.createdAt.getTime(), all.length);
      await saveScan(shop, result);
      await updateJob(job.id, { status: "done", objects: Number(op.objectCount || 0) });
      return null;
    } catch (err) {
      return stumble(err);
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
//   { kind: "products", ids, ruleId, full } products that were changed, and the rule acted on;
//                                          full: rescan a small catalog instead of re-checking ids
//   { kind: "settings" }                   checks were turned on or off
//   { kind: "saved", key, batchId, value } an edit saved from an issue page: mark its finding
//   { kind: "unsaved", key }               that edit was undone: clear the mark
// limit: the plan's product limit, for the small-catalog rescan.
export async function refreshAfter(graphql, shop, change, limit = null) {
  const latest = await latestScan(shop);
  if (!latest) return;

  // Turning a check off removes its findings right away; one turned back on reports on the next scan.
  if (change.kind === "settings") {
    const settings = await getSettings(shop);
    const off = new Set(settings.disabledRules || []);
    // A finding of a tracked metafield goes when the metafield was untracked or the setting behind
    // the finding (required, pattern) was turned off; withFindings drops checks that no longer exist.
    const tracked = new Map((settings.trackedMetafields || []).map((t) => [t.fullKey, t]));
    const stillChecked = (f) => {
      if (f.ruleId === "metafield_required") return Boolean(tracked.get(f.field)?.required);
      if (f.ruleId === "metafield_pattern") return Boolean(tracked.get(f.field)?.pattern);
      return true;
    };
    await saveScan(shop, withFindings(latest, latest.findings.filter((f) => !off.has(f.ruleId) && stillChecked(f)), settings));
    return;
  }

  // A saved edit keeps its finding, marked, until the issue page is refreshed or the catalog is
  // rescanned; undoing the edit clears the mark. Nothing is re-checked here.
  if (change.kind === "saved" || change.kind === "unsaved") {
    const settings = await getSettings(shop);
    const findings = latest.findings.map((f) => {
      if (ignoreKey(f) !== change.key) return f;
      const next = { ...f };
      delete next.saved;
      if (change.kind === "saved") next.saved = { batchId: change.batchId, value: change.value, at: new Date().toISOString(), quick: Boolean(change.quick) };
      return next;
    });
    await saveScan(shop, withFindings(latest, findings, settings));
    return;
  }

  // A small catalog is rescanned in full only when the change asks for it: exact for catalog-wide
  // rules, but it costs a re-read of every product, so Ignore, Trust word, edits and fixes take the
  // incremental path below instead.
  if (change.full && latest.total <= SYNC_LIMIT) {
    await saveScan(shop, await scanCatalog(graphql, shop, limit));
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

export function withFindings(latest, findings, settings, ignoredDelta = 0) {
  const kept = capFindings(knownFindings(findings));
  const summary = summarizeFindings(latest.total, kept, settings);
  return {
    ...summary,
    findings: kept,
    names: latest.names || [],
    context: latest.context || {},
    catalogTotal: latest.catalogTotal || latest.total,
    readAt: latest.readAt,
    productIds: latest.productIds || [],
    ignoredCount: (latest.ignoredCount || 0) + ignoredDelta,
    scannedAt: new Date().toISOString(),
    durationMs: 0,
  };
}
