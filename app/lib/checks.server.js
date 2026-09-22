// Ignoring a whole check, from a home page row or an issue page, and taking that back.
import { latestScan, saveScan, scanById } from "./scans.server";
import { getSettings, saveSettings } from "./settings.server";
import { refreshAfter, withFindings } from "./rescan.server";
import { RULE_CATALOG } from "./rules.server";
import { SYNC_LIMIT } from "./scan.server";

function ruleOrThrow(ruleId) {
  const rule = RULE_CATALOG.find((r) => r.id === ruleId);
  if (!rule) throw new Error("That check does not exist.");
  return rule;
}

// Turns the check off in Settings, where its switch shows unchecked, and drops its findings from
// the stored result. Every save is a new Scan row, so the row that still holds the findings is
// returned for Undo.
export async function ignoreCheck(graphql, shop, ruleId, limit = null) {
  const rule = ruleOrThrow(ruleId);
  const before = await latestScan(shop);
  const current = await getSettings(shop);
  const customDisabled = [...new Set([...current.disabledRules, ruleId])];
  await saveSettings(shop, { ...current, preset: "custom", customDisabled });
  await refreshAfter(graphql, shop, { kind: "settings" }, limit);
  const count = before ? before.findings.filter((f) => f.ruleId === ruleId).length : 0;
  return { ruleId, label: rule.label, count, scanId: before?.id ?? null };
}

// Turns the check back on. Its findings come straight back from the row Ignore left behind when
// the catalog has not been read again since; otherwise a small catalog is scanned again now and a
// large one reports the check on its next scan.
export async function restoreCheck(graphql, shop, ruleId, scanId, limit = null) {
  const rule = ruleOrThrow(ruleId);
  const current = await getSettings(shop);
  const customDisabled = current.disabledRules.filter((id) => id !== ruleId);
  await saveSettings(shop, { ...current, preset: "custom", customDisabled });
  const latest = await latestScan(shop);
  const kept = latest && scanId ? await scanById(shop, scanId) : null;
  if (latest && kept && kept.readAt === latest.readAt) {
    const back = kept.findings.filter((f) => f.ruleId === ruleId);
    const settings = await getSettings(shop);
    const findings = [...latest.findings.filter((f) => f.ruleId !== ruleId), ...back];
    await saveScan(shop, withFindings(latest, findings, settings));
    return { ruleId, label: rule.label, count: back.length, rescan: false };
  }
  const rescan = Boolean(latest) && latest.total <= SYNC_LIMIT;
  if (rescan) await refreshAfter(graphql, shop, { kind: "products", ids: [], full: true }, limit);
  return { ruleId, label: rule.label, count: null, rescan };
}
