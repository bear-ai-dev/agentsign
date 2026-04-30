import { env } from "./env.js";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function deliverEmail(input: {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  logLabel: string;
}) {
  if (!env.resendApiKey) {
    console.log("[AgentSign email fallback]");
    console.log(`To: ${input.to.join(", ")}`);
    if (input.cc?.length) console.log(`Cc: ${input.cc.join(", ")}`);
    console.log(`Subject: ${input.subject}`);
    console.log(input.text);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `${env.emailFromName} <${env.emailFrom}>`,
      to: input.to,
      cc: input.cc?.length ? input.cc : undefined,
      subject: input.subject,
      html: input.html,
      text: input.text
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend email failed: ${result.message ?? response.statusText}`);
  }
  console.log(`[AgentSign email sent] ${input.logLabel}: ${result.id ?? "accepted"} to ${input.to.join(", ")}${input.cc?.length ? ` cc ${input.cc.join(", ")}` : ""}`);
}

export async function sendSigningEmail(input: {
  to: string;
  cc?: string[];
  recipientName: string;
  documentTitle: string;
  signingUrl: string;
}) {
  const subject = `Signature requested: ${input.documentTitle}`;
  const text = `Hi ${input.recipientName},\n\nPlease review and sign ${input.documentTitle}:\n${input.signingUrl}\n\nThank you.`;
  const html = `<p>Hi ${escapeHtml(input.recipientName)},</p><p>Please review and sign <strong>${escapeHtml(input.documentTitle)}</strong>.</p><p><a href="${escapeHtml(input.signingUrl)}">Open signing link</a></p>`;

  await deliverEmail({ to: [input.to], cc: input.cc, subject, html, text, logLabel: "signing" });
}

export async function sendCompletionEmail(input: {
  to: string[];
  recipientName: string;
  recipientEmail: string;
  documentTitle: string;
  agreementId: string;
  signedPdfUrl: string;
}) {
  if (input.to.length === 0) return;

  const subject = `Signed: ${input.documentTitle}`;
  const text = [
    `${input.recipientName} (${input.recipientEmail}) signed ${input.documentTitle}.`,
    "",
    `Agreement: ${input.agreementId}`,
    `Signed PDF: ${input.signedPdfUrl}`
  ].join("\n");
  const html = [
    `<p><strong>${escapeHtml(input.recipientName)}</strong> (${escapeHtml(input.recipientEmail)}) signed <strong>${escapeHtml(input.documentTitle)}</strong>.</p>`,
    `<p>Agreement: <code>${escapeHtml(input.agreementId)}</code></p>`,
    `<p><a href="${escapeHtml(input.signedPdfUrl)}">Open signed PDF</a></p>`
  ].join("");

  await deliverEmail({ to: input.to, subject, html, text, logLabel: "completion" });
}
