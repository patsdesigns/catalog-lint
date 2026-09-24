import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies a webhook from Shopify without touching the shop's session. The library's
// authenticate.webhook also loads the shop's offline session and, when its token has expired (they
// last an hour), renews it first. Shopify refuses that renewal once the app is uninstalled, so
// app/uninstalled and the privacy webhooks that follow it failed with a 500 and were retried in vain
// (seen with the App Store review stores on 2026-09-24). The webhooks that only need the shop and the
// topic use this instead: the same HMAC check over the raw body, then the headers. Like the library,
// it throws a Response: 405 for anything but POST, 401 for a bad signature, 400 for a malformed call.

// eslint-disable-next-line no-undef
const env = process.env;

export async function verifyWebhook(request) {
  if (request.method !== "POST") throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
  const rawBody = await request.text();
  const secret = env.SHOPIFY_API_SECRET || "";
  const given = Buffer.from(request.headers.get("x-shopify-hmac-sha256") || "");
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"));
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  }
  // "app/uninstalled" becomes "APP_UNINSTALLED", the form the library uses.
  const topic = (request.headers.get("x-shopify-topic") || "").toUpperCase().replace(/\//g, "_");
  const shop = request.headers.get("x-shopify-shop-domain") || "";
  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = null;
  }
  // The signature covers the body only, so a body that names its shop must name this one.
  const named = payload?.shop_domain || payload?.myshopify_domain;
  if (!shop || !topic || payload === null || (named && named !== shop)) {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }
  return { shop, topic, payload };
}
