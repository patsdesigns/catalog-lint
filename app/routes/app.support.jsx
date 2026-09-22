import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Contact form. Messages are kept per shop in SupportMessage until an inbox or email is wired up.

const CATEGORIES = ["General Question", "Bug Report", "Feature Request", "Billing", "Something Else"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY = { name: "", email: "", category: CATEGORIES[0], subject: "", message: "" };

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
}

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
  await prisma.supportMessage.create({ data: { shop: session.shop, ...entry } });
  return { ok: true };
}

export default function SupportPage() {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const [form, setForm] = useState(EMPTY);
  const set = (key) => (e) => setForm((current) => ({ ...current, [key]: e.target.value }));
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
      <s-section heading="Contact Support">
        <s-stack gap="base">
          <s-paragraph>Have a question or need help? Fill out the form below and we will get back to you as soon as possible.</s-paragraph>
          <s-text-field label="Your Name" placeholder="Your name" required value={form.name} onInput={set("name")}></s-text-field>
          <s-text-field label="Your Email" type="email" placeholder="your@email.com" required value={form.email} onInput={set("email")}></s-text-field>
          <s-select label="Category" value={form.category} onInput={set("category")} onChange={set("category")}>
            {CATEGORIES.map((c) => (
              <s-option key={c} value={c}>{c}</s-option>
            ))}
          </s-select>
          <s-text-field label="Subject" placeholder="Brief description of your inquiry" required value={form.subject} onInput={set("subject")}></s-text-field>
          <s-text-area label="Message" placeholder="Please describe your question or issue in detail..." rows={10} required value={form.message} onInput={set("message")}></s-text-area>
          <s-stack direction="inline" justifyContent="end">
            <s-button variant="primary" onClick={send} disabled={!valid || busy || undefined} loading={busy || undefined}>
              Send Message
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
