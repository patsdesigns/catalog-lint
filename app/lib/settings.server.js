import prisma from "../db.server";
import { DEFAULT_PRESET, PRESET_IDS, disabledForPreset } from "./checkGroups";
import { listTracked, migrateMetafieldRules } from "./metafields.server";

// Which checks run is decided by a preset (see checkGroups.js); "custom" uses the merchant's own
// list, stored in disabledRules. getSettings resolves that into `disabledRules`, the effective set,
// which is what the rules and the scan summary read. It also carries the tracked metafields, which
// the rules turn into checks of their own (rules.server.js, trackedRules).
const DEFAULTS = { preset: DEFAULT_PRESET, customDisabled: [] };

export async function getSettings(shop) {
  const row = await prisma.setting.findUnique({ where: { shop } });
  const base = row
    ? {
        preset: PRESET_IDS.has(row.preset) ? row.preset : DEFAULT_PRESET,
        customDisabled: safeParse(row.disabledRules, []),
      }
    : { ...DEFAULTS };
  // Metafield rules from before tracked metafields existed become tracked metafields, once.
  const oldRules = row ? safeParse(row.metafieldRules, []) : [];
  if (oldRules.length) {
    await migrateMetafieldRules(shop, oldRules);
    await prisma.setting.update({ where: { shop }, data: { metafieldRules: "[]" } });
  }
  const trackedMetafields = await listTracked(shop);
  return { ...base, disabledRules: disabledForPreset(base.preset, base.customDisabled), trackedMetafields };
}

export async function saveSettings(shop, settings) {
  const data = {
    preset: PRESET_IDS.has(settings.preset) ? settings.preset : DEFAULT_PRESET,
    disabledRules: JSON.stringify(settings.customDisabled || []),
  };
  await prisma.setting.upsert({ where: { shop }, update: data, create: { shop, ...data } });
}

function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
