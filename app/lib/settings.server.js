import prisma from "../db.server";

// disabledRules: ids of checks the merchant turned off in Settings (see rules.server.js).
const DEFAULTS = { vendorWhitelist: [], metafieldRules: [], disabledRules: [] };

export async function getSettings(shop) {
  const row = await prisma.setting.findUnique({ where: { shop } });
  if (!row) return { ...DEFAULTS };
  return {
    vendorWhitelist: safeParse(row.vendorWhitelist, []),
    metafieldRules: safeParse(row.metafieldRules, []),
    disabledRules: safeParse(row.disabledRules, []),
  };
}

export async function saveSettings(shop, settings) {
  const data = {
    vendorWhitelist: JSON.stringify(settings.vendorWhitelist || []),
    metafieldRules: JSON.stringify(settings.metafieldRules || []),
    disabledRules: JSON.stringify(settings.disabledRules || []),
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
