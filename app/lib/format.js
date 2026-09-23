// Small display helpers shared by the pages. No server imports, so the client bundle can use them.
// Every number and date takes the store locale (from shopInfo, default "en"), so the server and
// the browser render the same text.

export function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}

export function truncate(text, n) {
  const t = String(text ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// A BCP 47 tag Intl accepts, or "en" when the store locale is not one.
function tag(locale) {
  try {
    return Intl.getCanonicalLocales(locale || "en")[0] || "en";
  } catch {
    return "en";
  }
}

export function formatNumber(value, locale = "en") {
  return new Intl.NumberFormat(tag(locale)).format(Number(value || 0));
}

// "Sep 22, 2:15 PM", with the year added outside the current one, in the given IANA time zone
// (the store time zone, so the merchant reads the time they know). Assembled from parts: newer ICU
// versions put a narrow space before AM/PM, and the server and the browser must render the same text.
const WHEN = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };

function whenParts(date, timeZone, locale) {
  const parts = new Intl.DateTimeFormat(tag(locale), { ...WHEN, timeZone }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

export function formatWhen(iso, timeZone = "UTC", now = Date.now(), locale = "en") {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let p;
  let year;
  try {
    p = whenParts(date, timeZone, locale);
    year = whenParts(new Date(now), timeZone, locale).year;
  } catch {
    // An unknown time zone name: fall back to UTC rather than fail the page.
    p = whenParts(date, "UTC", locale);
    year = whenParts(new Date(now), "UTC", locale).year;
  }
  const time = p.dayPeriod ? `${p.hour}:${p.minute} ${p.dayPeriod}` : `${p.hour}:${p.minute}`;
  return `${p.month} ${p.day}${p.year === year ? "" : `, ${p.year}`}, ${time}`;
}

// "3 minutes ago", "2 hours ago", "5 days ago", in the store language; "just now" under a minute.
export function timeAgo(iso, locale = "en") {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return tag(locale).startsWith("en") ? "just now" : relative(0, "minute", locale);
  if (mins < 60) return relative(-mins, "minute", locale);
  const hours = Math.round(mins / 60);
  if (hours < 24) return relative(-hours, "hour", locale);
  return relative(-Math.round(hours / 24), "day", locale);
}

function relative(value, unit, locale) {
  try {
    return new Intl.RelativeTimeFormat(tag(locale), { numeric: "always" }).format(value, unit);
  } catch {
    const n = Math.abs(value);
    return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
}
