// What the store is like, for reading numbers and dates the way the merchant expects: the IANA
// time zone, the currency and the primary language. Cached per shop for an hour: they change
// about never, and every page that shows a time or a price would ask.
import { request } from "./graphql.server";

const SHOP_QUERY = `#graphql
  query ShopInfo {
    shop {
      ianaTimezone
      currencyCode
    }
  }`;

// Its own request: it needs the read_locales scope, and a store that has not granted it yet
// must still get its time zone and currency.
const LOCALES_QUERY = `#graphql
  query PrimaryLocale {
    shopLocales(published: true) { locale primary }
  }`;

const TTL = 60 * 60 * 1000;
const cache = new Map();
export const DEFAULT_SHOP_INFO = { timeZone: "UTC", currency: "USD", locale: "en" };

// A language tag Intl accepts (so toLocaleString never throws on it), or null.
function safeLocale(locale) {
  try {
    return locale ? Intl.getCanonicalLocales(locale)[0] || null : null;
  } catch {
    return null;
  }
}

export async function shopInfo(graphql, shop) {
  const hit = cache.get(shop);
  if (hit && hit.until > Date.now()) return hit.info;
  const info = { ...DEFAULT_SHOP_INFO };
  let complete = true;
  try {
    const data = await request(graphql, SHOP_QUERY);
    info.timeZone = data?.shop?.ianaTimezone || info.timeZone;
    info.currency = data?.shop?.currencyCode || info.currency;
  } catch {
    complete = false;
  }
  try {
    const data = await request(graphql, LOCALES_QUERY);
    info.locale = safeLocale((data?.shopLocales || []).find((l) => l.primary)?.locale) || info.locale;
  } catch {
    complete = false;
  }
  // An incomplete answer is used for this request but not remembered.
  if (complete) cache.set(shop, { info, until: Date.now() + TTL });
  return hit?.info || info;
}

export async function shopTimeZone(graphql, shop) {
  return (await shopInfo(graphql, shop)).timeZone;
}
