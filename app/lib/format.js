// Small display helpers shared by the pages. No server imports, so the client bundle can use them.

export function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}

export function truncate(text, n) {
  const t = String(text ?? "");
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

export function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
