// Small display helpers shared by the pages. No server imports, so the client bundle can use them.

export function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}

export function truncate(text, n) {
  const t = String(text ?? "");
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

// "Sep 22, 2:15 PM", with the year added outside the current one, in the given IANA time zone
// (the store time zone, so the merchant reads the time they know). Assembled from parts: newer ICU
// versions put a narrow space before AM/PM, and the server and the browser must render the same text.
const WHEN = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };

function whenParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { ...WHEN, timeZone }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

export function formatWhen(iso, timeZone = "UTC", now = Date.now()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let p;
  let year;
  try {
    p = whenParts(date, timeZone);
    year = whenParts(new Date(now), timeZone).year;
  } catch {
    // An unknown time zone name: fall back to UTC rather than fail the page.
    p = whenParts(date, "UTC");
    year = whenParts(new Date(now), "UTC").year;
  }
  return `${p.month} ${p.day}${p.year === year ? "" : `, ${p.year}`}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

export function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// "$1,234" or "CA$1,234": whole units in the store currency, en-US digits. Without a currency, the
// bare number.
export function formatMoney(amount, currency) {
  const value = Math.round(Number(amount) || 0);
  if (!currency) return value.toLocaleString("en-US");
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value.toLocaleString("en-US")} ${currency}`;
  }
}
