// TidyUp plans. Dust Off is the free default for a shop with no subscription. The paid plans are
// named exactly as in the billing config (app/shopify.server.js builds it from PAID_PLANS), so a
// subscription can be matched to a plan by name. No server imports: the pages read this too.

const NONE = {
  inlineEdits: false,
  export: false,
  dictionary: false,
  ignores: false,
  newProductScans: false,
  customRules: false,
  vendorWhitelist: false,
};

export const PLANS = [
  {
    id: "dust_off",
    name: "Dust Off",
    price: 0,
    productLimit: 20,
    features: { ...NONE },
    extras: [],
  },
  {
    id: "quick_clean",
    name: "Quick Clean",
    price: 10,
    productLimit: null,
    features: { ...NONE, inlineEdits: true, export: true, dictionary: true, ignores: true, newProductScans: true },
    extras: [],
  },
  {
    id: "deep_clean",
    name: "Deep Clean",
    price: 20,
    productLimit: null,
    features: {
      ...NONE,
      inlineEdits: true,
      export: true,
      dictionary: true,
      ignores: true,
      newProductScans: true,
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
