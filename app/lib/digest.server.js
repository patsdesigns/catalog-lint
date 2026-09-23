import { Resend } from "resend";
import prisma from "../db.server";
import { latestScan } from "./scans.server";
import { snapshotDaysAgo } from "./snapshots.server";
import { categoryOf } from "./categories";
import { formatNumber } from "./format";

// The weekly email: potential problems, the change over the last seven days (from DailySnapshot),
// the five Start Here issues and a link to the app. Sent with Resend (RESEND_API_KEY), from
// DIGEST_FROM or the Resend onboarding sender.

const SEVERITY_WEIGHT = { high: 3, medium: 1.5, low: 0.5 };
// eslint-disable-next-line no-undef
const env = process.env;

export async function getDigestSettings(shop) {
  const row = await prisma.digestSettings.findUnique({ where: { shop } });
  return { enabled: Boolean(row?.enabled), email: row?.email || "" };
}

export async function saveDigestSettings(shop, { enabled, email }) {
  const data = { enabled: Boolean(enabled), email: String(email || "").trim() };
  await prisma.digestSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return data;
}

// Where the app lives in this store's admin.
export function appUrl(shop) {
  const store = String(shop).replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/apps/${env.SHOPIFY_API_KEY}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function buildDigest(shop, locale = "en") {
  const n = (v) => formatNumber(v, locale);
  const latest = await latestScan(shop);
  const open = latest ? latest.findings.length : 0;
  const weekAgo = await snapshotDaysAgo(shop, 7);
  const change = weekAgo ? open - weekAgo.potentialProblems : null;
  const top = latest
    ? [...latest.rules]
        .sort((a, b) => SEVERITY_WEIGHT[b.severity] * b.count - SEVERITY_WEIGHT[a.severity] * a.count || b.count - a.count)
        .slice(0, 5)
    : [];
  const url = appUrl(shop);
  const store = String(shop).replace(".myshopify.com", "");

  const changeText = change == null ? "No snapshot from a week ago yet." : change === 0 ? "No change since last week." : `${change < 0 ? "Down" : "Up"} ${n(Math.abs(change))} since last week.`;
  const subject = latest
    ? `TidyUp weekly for ${store}: ${n(open)} potential ${open === 1 ? "problem" : "problems"}${change ? ` (${change < 0 ? "down" : "up"} ${n(Math.abs(change))})` : ""}`
    : `TidyUp weekly for ${store}: run your first scan`;

  const lines = [
    `TidyUp weekly digest for ${store}`,
    "",
    latest ? `Potential problems: ${n(open)} across ${n(latest.total)} products. ${changeText}` : "No scan yet. Open TidyUp and run a full scan to get started.",
    "",
  ];
  if (top.length) {
    lines.push("Start here:");
    for (const r of top) lines.push(`- ${r.label} (${categoryOf(r.category).label}): ${n(r.count)} ${r.count === 1 ? "finding" : "findings"}, ${r.severity} severity`);
    lines.push("");
  }
  lines.push(`Open TidyUp: ${url}`);
  const text = lines.join("\n");

  const rows = top
    .map(
      (r) =>
        `<tr><td style="padding:6px 12px 6px 0;">${escapeHtml(r.label)} <span style="color:#616161;">(${escapeHtml(categoryOf(r.category).label)})</span></td><td style="padding:6px 0;text-align:right;white-space:nowrap;">${n(r.count)} · ${escapeHtml(r.severity)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#303030;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <p style="margin:0 0 4px;color:#616161;font-size:13px;">TidyUp weekly digest · ${escapeHtml(store)}</p>
    ${
      latest
        ? `<p style="margin:0;font-size:40px;font-weight:650;line-height:1;">${n(open)}</p>
    <p style="margin:4px 0 16px;color:#616161;">potential ${open === 1 ? "problem" : "problems"} across ${n(latest.total)} products. ${escapeHtml(changeText)}</p>`
        : `<p style="margin:0 0 16px;">No scan yet. Open TidyUp and run a full scan to get started.</p>`
    }
    ${rows ? `<p style="margin:0 0 4px;font-weight:600;">Start here</p><table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>` : ""}
    <p style="margin:20px 0 0;"><a href="${url}" style="display:inline-block;background:#303030;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">Open TidyUp</a></p>
    <p style="margin:16px 0 0;color:#8a8a8a;font-size:12px;">You get this because the weekly email is on in TidyUp settings for ${escapeHtml(store)}.</p>
  </div>
</body></html>`;

  return { subject, text, html, open, change, top, url };
}

// Builds and sends the digest to one address. Throws when Resend is not configured or rejects it.
export async function sendDigest(shop, to, locale = "en") {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set, so emails cannot be sent yet.");
  const digest = await buildDigest(shop, locale);
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.DIGEST_FROM || "TidyUp <onboarding@resend.dev>",
    to,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
  });
  if (error) throw new Error(error.message || String(error));
  return digest;
}

// Every shop with the weekly email on and an address, for the cron route.
export async function digestRecipients() {
  return prisma.digestSettings.findMany({ where: { enabled: true, NOT: { email: "" } }, select: { shop: true, email: true } });
}
