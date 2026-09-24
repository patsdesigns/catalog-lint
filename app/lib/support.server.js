import { escapeHtml, sendEmail } from "./email.server";
import { APP_VERSION } from "./version.server";

// Where a support form message goes once it is stored: the support inbox by email (SUPPORT_EMAIL,
// hello@patsdesigns.com unless set), with the merchant's address as the reply-to so a reply answers
// them, and SUPPORT_WEBHOOK_URL when set (a Slack incoming webhook, Zapier, Make or any endpoint
// that takes JSON). Both are best effort: the message is already stored, so a failure is logged,
// never shown to the merchant.

// eslint-disable-next-line no-undef
const env = process.env;

export async function deliverSupportMessage(shop, entry) {
  await Promise.all([emailInbox(shop, entry), postWebhook(shop, entry)]);
}

async function emailInbox(shop, entry) {
  const to = env.SUPPORT_EMAIL || "hello@patsdesigns.com";
  const subject = `TidyUp ${entry.category.toLowerCase()}: ${entry.subject}`.replace(/\s+/g, " ");
  const text = `${entry.category} from ${entry.name} <${entry.email}>\nStore: ${shop}\nTidyUp version: ${APP_VERSION}\n\nSubject: ${entry.subject}\n\n${entry.message}\n\nReply to this email to answer ${entry.name}.`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;">
    <p style="margin:0 0 12px;">${escapeHtml(entry.category)} from <strong>${escapeHtml(entry.name)}</strong> &lt;${escapeHtml(entry.email)}&gt;<br>
    Store: ${escapeHtml(shop)}<br>TidyUp version: ${escapeHtml(APP_VERSION)}</p>
    <p style="margin:0 0 8px;"><strong>${escapeHtml(entry.subject)}</strong></p>
    <p style="margin:0 0 16px;white-space:pre-wrap;">${escapeHtml(entry.message)}</p>
    <p style="margin:0;">Reply to this email to answer ${escapeHtml(entry.name)}.</p>
  </div>`;
  try {
    await sendEmail({ to, subject, text, html, replyTo: entry.email });
  } catch (err) {
    console.error(`Support email to the inbox failed: ${err?.message || err}`);
  }
}

async function postWebhook(shop, entry) {
  const url = env.SUPPORT_WEBHOOK_URL;
  if (!url) return;
  const text = `TidyUp support · ${entry.category}\nShop: ${shop}\nFrom: ${entry.name} <${entry.email}>\nSubject: ${entry.subject}\n\n${entry.message}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, shop, ...entry }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`Support webhook responded ${res.status}`);
  } catch (err) {
    // The message only: the error object can carry the webhook address.
    console.error(`Support webhook failed: ${err?.message || err}`);
  }
}
