// Categories mirror the sections of the Shopify product page, top to bottom, with Product
// organization pulled up after Inventory so the areas every plan covers come first (plans.js).
// Shared by the server rules and the UI. Keep this file free of server-only imports.
export const CATEGORIES = [
  { id: "description", label: "Title and description" },
  { id: "media", label: "Media" },
  { id: "pricing", label: "Pricing" },
  { id: "inventory", label: "Inventory" },
  { id: "organization", label: "Product organization" },
  { id: "shipping", label: "Shipping" },
  { id: "variants", label: "Variants" },
  { id: "seo", label: "Search engine listing" },
  { id: "status", label: "Status" },
  { id: "publishing", label: "Sales channels" },
  { id: "metafields", label: "Metafields" },
];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];
}
