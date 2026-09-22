// TidyUp plans. Dust Off is the free default for a shop with no subscription. The paid plans are
// named exactly as in the billing config (app/shopify.server.js builds it from PAID_PLANS), so a
// subscription can be matched to a plan by name. No server imports: the pages read this too.

import { CATEGORIES } from "./categories";

// Check areas (the home page cards) by id. Dust Off and Quick Clean cover the core five; Deep Clean
// covers every area. The scan runs every check regardless, so counts stay accurate.
export const ALL_AREAS = CATEGORIES.map((c) => c.id);
const CORE_AREAS = ["description", "media", "pricing", "inventory", "organization"];

const NONE = {
  inlineEdits: false,
  export: false,
  dictionary: false,
  ignores: false,
  newProductScans: false,
  autoRescan: false,
  weeklyDigest: false,
  customRules: false,
  vendorWhitelist: false,
};

export const PLANS = [
  {
    id: "dust_off",
    name: "Dust Off",
    price: 0,
    productLimit: 20,
    areas: CORE_AREAS,
    features: { ...NONE },
    extras: [],
  },
  {
    id: "quick_clean",
    name: "Quick Clean",
    price: 10,
    productLimit: null,
    areas: CORE_AREAS,
    features: { ...NONE, inlineEdits: true, export: true, dictionary: true, ignores: true, newProductScans: true, autoRescan: true, weeklyDigest: true },
    extras: [],
  },
  {
    id: "deep_clean",
    name: "Deep Clean",
    price: 20,
    productLimit: null,
    areas: ALL_AREAS,
    features: {
      ...NONE,
      inlineEdits: true,
      export: true,
      dictionary: true,
      ignores: true,
      newProductScans: true,
      autoRescan: true,
      weeklyDigest: true,
      customRules: true,
      vendorWhitelist: true,
    },
    extras: ["Priority support"],
  },
];

export const DEFAULT_PLAN = PLANS[0];
export const PAID_PLANS = PLANS.filter((p) => p.price > 0);

// What each feature is called on the Plans page.
export const FEATURE_LABELS = {
  inlineEdits: "Inline edits on issue pages",
  export: "Export issues (coming soon)",
  dictionary: "Spelling dictionary",
  ignores: "Ignore findings",
  newProductScans: "Scan newly added products",
  autoRescan: "Automatic re-check when products change",
  weeklyDigest: "Weekly email digest",
  customRules: "Custom metafield rules",
  vendorWhitelist: "Approved vendor list",
};

// Features a plan includes but that are not built yet; the Plans page lists them last.
export const COMING_SOON = new Set(["export"]);

export function planById(id) {
  return PLANS.find((p) => p.id === id) || null;
}

export function planByName(name) {
  return PLANS.find((p) => p.name === name) || null;
}

// The cheapest plan that includes a feature, for "Upgrade to ..." links.
export function planFor(feature) {
  return PLANS.find((p) => p.features[feature]) || null;
}

// The areas a plan does not cover, and the cheapest plan that covers every area.
export function lockedAreas(plan) {
  return ALL_AREAS.filter((id) => !plan.areas.includes(id));
}
export function areaLocked(plan, category) {
  return !plan.areas.includes(category);
}
export function allAreasPlan() {
  return PLANS.find((p) => p.areas.length === ALL_AREAS.length) || PLANS[PLANS.length - 1];
}
