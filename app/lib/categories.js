// Categories mirror the sections of the Shopify product page, top to bottom, with Product
// organization pulled up after Inventory so the areas every plan covers come first (plans.js).
// Shared by the server rules and the UI. Keep this file free of server-only imports.
//
// Each area has a color of its own for the stripe, wash and dot on its card. Every value is a color
// from the Polaris palette, the admin's own design tokens (the `--p-color-*` values that the Polaris
// web components runtime ships), named beside it; nothing here is a color of our own. The tokens are
// not exposed to apps as CSS variables, so the values are written out.
export const CATEGORIES = [
  { id: "description", label: "Title and description", color: "#5700d1" }, // text-ai
  { id: "media", label: "Media", color: "#ffb800" }, // bg-fill-warning
  { id: "pricing", label: "Pricing", color: "#998a00" }, // icon-caution-accent
  { id: "inventory", label: "Inventory", color: "#007cb4" }, // text-info-secondary
  { id: "organization", label: "Product organization", color: "#8051ff" }, // icon-ai
  { id: "shipping", label: "Shipping", color: "#5e4200" }, // text-warning
  { id: "variants", label: "Variants", color: "#c530c5" }, // avatar-one-bg-fill
  { id: "seo", label: "Search engine listing", color: "#047b5d" }, // bg-fill-success
  { id: "status", label: "Status", color: "#4a4a4a" }, // icon
  { id: "publishing", label: "Sales channels", color: "#004299" }, // text-link-hover
  { id: "metafields", label: "Metafields", color: "#8a8a8a" }, // icon-secondary
];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];
}
