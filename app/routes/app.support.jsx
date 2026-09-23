import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { describeError } from "../lib/graphql.server";
import { APP_VERSION } from "../lib/version.server";

// Contact form. Messages are kept per shop in SupportMessage and, when SUPPORT_WEBHOOK_URL is set,
// posted there as well (a Slack incoming webhook, Zapier, Make or any endpoint that takes JSON).

const CATEGORIES = ["General question", "Feature request", "Bug report"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY = { name: "", email: "", category: CATEGORIES[0], subject: "", message: "" };

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop, version: APP_VERSION };
}

// How long each field may be, and how many messages a shop may send in an hour.
const LIMITS = { name: 100, email: 254, subject: 200, message: 5000 };
const MESSAGES_PER_HOUR = 10;

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const field = (name) => String(form.get(name) || "").trim();
  const entry = {
    name: field("name"),
    email: field("email"),
    category: CATEGORIES.includes(field("category")) ? field("category") : CATEGORIES[0],
    subject: field("subject"),
    message: field("message"),
  };
  if (!entry.name || !entry.email || !entry.subject || !entry.message) {
    return { ok: false, error: "Name, email, subject and message are all needed." };
  }
  if (!EMAIL_RE.test(entry.email)) return { ok: false, error: "That email address does not look right." };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (entry[key].length > max) return { ok: false, error: `The ${key} can have up to ${max.toLocaleString("en-US")} characters.` };
  }
  try {
    const recent = await prisma.supportMessage.count({ where: { shop: session.shop, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } });
    if (recent >= MESSAGES_PER_HOUR) return { ok: false, error: "Up to ten messages an hour. Try again later." };
    await prisma.supportMessage.create({ data: { shop: session.shop, ...entry } });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  await forward(session.shop, entry);
  return { ok: true };
}

// Best effort: a failed forward is logged, never shown to the merchant, since the message is stored.
async function forward(shop, entry) {
  // eslint-disable-next-line no-undef
  const url = process.env.SUPPORT_WEBHOOK_URL;
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

export default function SupportPage() {
  const { version } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const [form, setForm] = useState(EMPTY);
  const set = (key) => (e) => setForm((current) => ({ ...current, [key]: e.target.value }));
  // The choice list reports its selection as a list of values on the list element.
  const pickCategory = (e) => {
    const values = e.currentTarget?.values ?? e.target?.values;
    const next = Array.isArray(values) ? values[0] : e.target?.value;
    if (CATEGORIES.includes(next)) setForm((current) => ({ ...current, category: next }));
  };
  const valid = Boolean(form.name.trim() && EMAIL_RE.test(form.email.trim()) && form.subject.trim() && form.message.trim());

  // A sent message clears the form once.
  useEffect(() => {
    if (outcome?.ok && fetcher.state === "idle") setForm(EMPTY);
  }, [outcome, fetcher.state]);

  const send = () => fetcher.submit(form, { method: "post" });

  return (
    <s-page heading="Support">
      <s-link slot="breadcrumb-actions" href="/app">Home</s-link>
      {outcome?.ok ? (
        <s-banner tone="success" heading="Message sent">
          <s-paragraph>Thanks. We will get back to you at the email address you gave.</s-paragraph>
        </s-banner>
      ) : null}
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Could not send">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      <s-section heading="Contact support">
        <s-stack gap="base">
          <s-paragraph>Have a question or need help? Fill out the form below and we will get back to you as soon as possible.</s-paragraph>
          <s-text-field label="Your name" placeholder="Your name" required value={form.name} onInput={set("name")}></s-text-field>
          <s-email-field label="Your email" placeholder="you@example.com" required value={form.email} onInput={set("email")}></s-email-field>
          <s-choice-list label="What is this about?" name="category" onInput={pickCategory} onChange={pickCategory}>
            {CATEGORIES.map((c) => (
              <s-choice key={c} value={c} selected={form.category === c || undefined}>{c}</s-choice>
            ))}
          </s-choice-list>
          <s-text-field label="Subject" placeholder="Brief description of your inquiry" required value={form.subject} onInput={set("subject")}></s-text-field>
          <s-text-area label="Message" placeholder="Describe your question or issue" rows={10} required value={form.message} onInput={set("message")}></s-text-area>
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="primary" onClick={send} disabled={!valid || busy || undefined} loading={busy || undefined}>
              Send message
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="About">
        <s-stack gap="small-200">
          <s-paragraph>TidyUp version {version}</s-paragraph>
          <s-text color="subdued">Mention the version when you report a problem.</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
