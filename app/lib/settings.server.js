import prisma from "../db.server";
import { DEFAULT_PRESET, PRESET_IDS, disabledForPreset } from "./checkGroups";

// Which checks run is decided by a preset (see checkGroups.js); "custom" uses the merchant's own
// list, stored in disabledRules. getSettings resolves that into `disabledRules`, the effective set,
// which is what the rules and the scan summary read.
const DEFAULTS = { vendorWhitelist: [], metafieldRules: [], preset: DEFAULT_PRESET, customDisabled: [] };

export async function getSettings(shop) {
  const row = await prisma.setting.findUnique({ where: { shop } });
  const base = row
    ? {
        vendorWhitelist: safeParse(row.vendorWhitelist, []),
        metafieldRules: safeParse(row.metafieldRules, []),
        preset: PRESET_IDS.has(row.preset) ? row.preset : DEFAULT_PRESET,
        customDisabled: safeParse(row.disabledRules, []),
      }
    : { ...DEFAULTS };
  return { ...base, disabledRules: disabledForPreset(base.preset, base.customDisabled) };
}

export async function saveSettings(shop, settings) {
  const data = {
    vendorWhitelist: JSON.stringify(settings.vendorWhitelist || []),
    metafieldRules: JSON.stringify(settings.metafieldRules || []),
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
