// The IANA time zone of the store, so dates and times read the way the merchant expects. Cached
// per shop for an hour: it changes about never, and every page that shows a time would ask.

const QUERY = `#graphql
  query ShopTimeZone {
    shop {
      ianaTimezone
    }
  }`;

const TTL = 60 * 60 * 1000;
const cache = new Map();

export async function shopTimeZone(graphql, shop) {
  const hit = cache.get(shop);
  if (hit && hit.until > Date.now()) return hit.zone;
  try {
    const response = await graphql(QUERY);
    const { data } = await response.json();
    const zone = data?.shop?.ianaTimezone || "UTC";
    cache.set(shop, { zone, until: Date.now() + TTL });
    return zone;
  } catch {
    return hit?.zone || "UTC";
  }
}
