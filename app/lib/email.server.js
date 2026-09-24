import { Resend } from "resend";

// Every email the app sends goes through Resend (RESEND_API_KEY), from EMAIL_FROM: the sender once
// its domain is verified in Resend, such as "TidyUp <hello@patsdesigns.com>". Unset, it is the
// Resend onboarding sender, which only delivers to the address the Resend account was opened with.

// eslint-disable-next-line no-undef
const env = process.env;
const SEND_TIMEOUT_MS = 10_000;

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Sends one email. Throws when Resend is not configured, rejects it or does not answer in time.
export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set, so emails cannot be sent yet.");
  const resend = new Resend(env.RESEND_API_KEY);
  const send = resend.emails.send({
    from: env.EMAIL_FROM || "TidyUp <onboarding@resend.dev>",
    to,
    subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Resend did not answer within 10 seconds.")), SEND_TIMEOUT_MS);
  });
  try {
    const { error } = await Promise.race([send, late]);
    if (error) throw new Error(error.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}
