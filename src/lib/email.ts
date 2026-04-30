import { env } from "./env.js";

export async function sendSigningEmail(input: {
  to: string;
  cc?: string[];
  recipientName: string;
  documentTitle: string;
  signingUrl: string;
}) {
  const subject = `Signature requested: ${input.documentTitle}`;
  const text = `Hi ${input.recipientName},\n\nPlease review and sign ${input.documentTitle}:\n${input.signingUrl}\n\nThank you.`;
  const html = `<p>Hi ${input.recipientName},</p><p>Please review and sign <strong>${input.documentTitle}</strong>.</p><p><a href="${input.signingUrl}">Open signing link</a></p>`;

  if (!env.resendApiKey) {
    console.log("[AgentInk email fallback]");
    console.log(`To: ${input.to}`);
    if (input.cc?.length) console.log(`Cc: ${input.cc.join(", ")}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
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
      to: [input.to],
      cc: input.cc?.length ? input.cc : undefined,
      subject,
      html,
      text
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend email failed: ${result.message ?? response.statusText}`);
  }
  console.log(`[AgentInk email sent] ${result.id ?? "accepted"} to ${input.to}${input.cc?.length ? ` cc ${input.cc.join(", ")}` : ""}`);
}
