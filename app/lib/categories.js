// Categories mirror the sections of the Shopify product page, top to bottom, with Product
// Organization pulled up after Inventory so the areas every plan covers come first (plans.js).
// Shared by the server rules and the UI. Keep this file free of server-only imports.
export const CATEGORIES = [
  { id: "description", label: "Title and description", color: "#5c6ac4" },
  { id: "media", label: "Media", color: "#d9822b" },
  { id: "pricing", label: "Pricing", color: "#b8860b" },
  { id: "inventory", label: "Inventory", color: "#0a7ea4" },
  { id: "organization", label: "Product organization", color: "#7b5cd6" },
  { id: "shipping", label: "Shipping", color: "#8e6c3a" },
  { id: "variants", label: "Variants", color: "#c2185b" },
  { id: "seo", label: "Search engine listing", color: "#1f8a70" },
  { id: "status", label: "Status", color: "#4b5563" },
  { id: "publishing", label: "Sales channels", color: "#2c6ecb" },
  { id: "metafields", label: "Metafields", color: "#5f6b7a" },
];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];
}
