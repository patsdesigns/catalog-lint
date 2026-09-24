// Categories mirror the sections of the Shopify product page, top to bottom, with Product
// organization pulled up after Inventory so the areas every plan covers come first (plans.js).
// Shared by the server rules and the UI. Keep this file free of server-only imports.
//
// Each area has a color of its own for the stripe, wash and dot on its card. Every value is a color
// from the Polaris palette, the admin's own design tokens (the `--p-color-*` values that the Polaris
// web components runtime ships), named beside it; nothing here is a color of our own. The tokens are
// not exposed to apps as CSS variables, so the values are written out.
// Chosen to be told apart at a glance: one color family each, except a light and a dark blue and a
// light and a dark green; none close to the red, orange and yellow that mean severity; and ordered
// so neighboring cards contrast. The closest pair (magenta and pink) is more than 19 apart in
// CIEDE2000, against 15 for the closest pair of the colors this replaced.
export const CATEGORIES = [
  { id: "description", label: "Title and description", color: "#005bd3" }, // icon-highlight-accent (blue)
  { id: "media", label: "Media", color: "#fd4b92" }, // avatar-five-bg-fill (pink)
  { id: "pricing", label: "Pricing", color: "#047b5d" }, // bg-fill-success (green)
  { id: "inventory", label: "Inventory", color: "#51c0ff" }, // avatar-four-bg-fill (light blue)
  { id: "organization", label: "Product organization", color: "#5700d1" }, // text-ai (purple)
  { id: "shipping", label: "Shipping", color: "#5e4200" }, // text-warning (brown)
  { id: "variants", label: "Variants", color: "#25e82b" }, // avatar-six-bg-fill (lime)
  { id: "seo", label: "Search engine listing", color: "#c530c5" }, // avatar-one-bg-fill (magenta)
  { id: "status", label: "Status", color: "#8a8a8a" }, // icon-secondary (grey)
  { id: "publishing", label: "Sales channels", color: "#2ce0d4" }, // avatar-three-bg-fill (turquoise)
  { id: "metafields", label: "Metafields", color: "#998a00" }, // icon-caution-accent (olive)
];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];
}
