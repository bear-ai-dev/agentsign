import { env } from "./env.js";

const resendEmailEndpoint = "https://api.resend.com/emails";
const maxResendAttempts = 5;
let resendSchedule = Promise.resolve();
let nextResendSendAt = 0;
let resendEffectiveEmailsPerSecond: number | null = null;

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function resendIntervalMs() {
  return Math.ceil(1000 / Math.max(1, resendEffectiveEmailsPerSecond ?? env.resendEmailsPerSecond));
}

async function waitForResendSlot() {
  const scheduled = resendSchedule.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextResendSendAt - now);
    await sleep(waitMs);
    nextResendSendAt = Math.max(Date.now(), nextResendSendAt) + resendIntervalMs();
  });
  resendSchedule = scheduled.catch(() => undefined);
  await scheduled;
}

function retryHeaderDelayMs(headers: Headers) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const reset = headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset") ?? headers.get("x-rate-limit-reset");
  if (!reset) return null;

  const numeric = Number(reset);
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (numeric > 1_000_000_000_000) return Math.max(0, numeric - Date.now());
    if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - Date.now());
    return numeric * 1000;
  }

  const dateMs = Date.parse(reset);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function rateLimitCapPerSecond(headers: Headers, result: unknown) {
  const headerValue = headers.get("ratelimit-limit") ?? headers.get("x-ratelimit-limit") ?? headers.get("x-rate-limit-limit");
  const headerCap = headerValue?.match(/\d+/)?.[0];
  if (headerCap) {
    const parsed = Number(headerCap);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }

  const message = typeof result === "object" && result && "message" in result
    ? String((result as { message?: unknown }).message ?? "")
    : "";
  const messageCap = message.match(/only make\s+(\d+)\s+requests?\s+per\s+second/i)?.[1];
  const parsed = Number(messageCap);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function applyResendRateLimitCap(headers: Headers, result: unknown) {
  const cap = rateLimitCapPerSecond(headers, result);
  if (!cap) return false;

  const currentCap = resendEffectiveEmailsPerSecond ?? env.resendEmailsPerSecond;
  resendEffectiveEmailsPerSecond = Math.max(1, Math.min(currentCap, cap));
  return resendEffectiveEmailsPerSecond < currentCap;
}

function cleanDisplayName(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatEmailFrom(senderName?: string, fromEmail = env.emailFrom) {
  const serviceName = cleanDisplayName(env.emailFromName) || "AgentContract";
  const customName = cleanDisplayName(senderName);
  const firstParty = fromEmail.trim().toLowerCase() !== env.emailFrom.trim().toLowerCase();
  const displayName = firstParty
    ? customName || serviceName
    : customName && customName.toLowerCase() !== serviceName.toLowerCase()
    ? `${customName} via ${serviceName}`
    : serviceName;
  return `${displayName} <${fromEmail}>`;
}

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
  replyTo?: string[];
  subject: string;
  html: string;
  text: string;
  logLabel: string;
  fromName?: string;
  fromEmail?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    content_type?: string;
  }>;
}) {
  if (!env.resendApiKey) {
    console.log("[AgentContract email fallback]");
    console.log(`From: ${formatEmailFrom(input.fromName, input.fromEmail)}`);
    console.log(`To: ${input.to.join(", ")}`);
    if (input.cc?.length) console.log(`Cc: ${input.cc.join(", ")}`);
    if (input.replyTo?.length) console.log(`Reply-To: ${input.replyTo.join(", ")}`);
    if (input.attachments?.length) console.log(`Attachments: ${input.attachments.map((attachment) => attachment.filename).join(", ")}`);
    console.log(`Subject: ${input.subject}`);
    console.log(input.text);
    return;
  }

  const payload = JSON.stringify({
    from: formatEmailFrom(input.fromName, input.fromEmail),
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    reply_to: input.replyTo?.length ? input.replyTo : undefined,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments?.length ? input.attachments : undefined
  });

  for (let attempt = 1; attempt <= maxResendAttempts; attempt += 1) {
    await waitForResendSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(resendEmailEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: payload,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`[AgentContract email sent] ${input.logLabel}: ${result.id ?? "accepted"} to ${input.to.join(", ")}${input.cc?.length ? ` cc ${input.cc.join(", ")}` : ""}`);
      return;
    }

    if (response.status === 429 && attempt < maxResendAttempts) {
      const loweredCap = applyResendRateLimitCap(response.headers, result);
      const retryFromHeadersMs = retryHeaderDelayMs(response.headers);
      const retryFloorMs = loweredCap ? Math.max(1000, resendIntervalMs()) : resendIntervalMs();
      const retryMs = Math.max(retryFromHeadersMs ?? Math.max(1000, resendIntervalMs()), retryFloorMs);
      console.warn(`[AgentContract Resend rate limit] ${input.logLabel}: retrying in ${retryMs}ms`);
      await sleep(retryMs);
      continue;
    }

    throw new Error(`Resend email failed: ${result.message ?? response.statusText}`);
  }
}

export async function sendSigningEmail(input: {
  to: string;
  cc?: string[];
  replyTo?: string[];
  senderName?: string;
  fromEmail?: string;
  recipientName: string;
  documentTitle: string;
  signingUrl: string;
  message?: string;
}) {
  const subject = `Signature requested: ${input.documentTitle}`;
  const senderLine = input.message ?? (input.senderName ? `${input.senderName} requested your signature.` : "Please review and sign this agreement.");
  const text = `Hi ${input.recipientName},\n\n${senderLine}\n\n${input.documentTitle}:\n${input.signingUrl}\n\nThank you.`;
  const html = `<p>Hi ${escapeHtml(input.recipientName)},</p><p>${escapeHtml(senderLine)}</p><p>Please review and sign <strong>${escapeHtml(input.documentTitle)}</strong>.</p><p><a href="${escapeHtml(input.signingUrl)}">Open signing link</a></p>`;

  await deliverEmail({ to: [input.to], cc: input.cc, replyTo: input.replyTo, subject, html, text, logLabel: "signing", fromName: input.senderName, fromEmail: input.fromEmail });
}

export async function sendCompletionEmail(input: {
  to: string[];
  senderName?: string;
  fromEmail?: string;
  recipientName: string;
  recipientEmail: string;
  documentTitle: string;
  agreementId: string;
  signedPdfUrl: string;
  signedPdfBase64?: string;
}) {
  if (input.to.length === 0) return;

  const filename = `${input.agreementId}-executed.pdf`;
  const subject = `Executed: ${input.documentTitle}`;
  const text = [
    `${input.documentTitle} is complete. All required signatures have been collected.`,
    "",
    `Recipient: ${input.recipientName} (${input.recipientEmail})`,
    `Agreement: ${input.agreementId}`,
    input.signedPdfBase64 ? `Executed PDF attached: ${filename}` : "Executed PDF attached: unavailable",
    `Signed PDF: ${input.signedPdfUrl}`
  ].join("\n");
  const html = [
    `<p><strong>${escapeHtml(input.documentTitle)}</strong> is complete. All required signatures have been collected.</p>`,
    `<p>Recipient: <strong>${escapeHtml(input.recipientName)}</strong> (${escapeHtml(input.recipientEmail)})</p>`,
    `<p>Agreement: <code>${escapeHtml(input.agreementId)}</code></p>`,
    input.signedPdfBase64 ? `<p>The executed PDF is attached as <strong>${escapeHtml(filename)}</strong>.</p>` : "",
    `<p><a href="${escapeHtml(input.signedPdfUrl)}">Open signed PDF</a></p>`
  ].join("");

  await deliverEmail({
    to: input.to,
    subject,
    html,
    text,
    logLabel: "completion",
    fromName: input.senderName,
    fromEmail: input.fromEmail,
    attachments: input.signedPdfBase64
      ? [{ filename, content: input.signedPdfBase64, content_type: "application/pdf" }]
      : undefined
  });
}

export async function sendCliLoginCodeEmail(input: {
  to: string;
  code: string;
  expiresInMinutes: number;
}) {
  const subject = "Your AgentContract login code";
  const text = [
    "Use this code to finish AgentContract CLI login:",
    "",
    input.code,
    "",
    `This code expires in ${input.expiresInMinutes} minutes.`
  ].join("\n");
  const html = [
    "<p>Use this code to finish AgentContract CLI login:</p>",
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(input.code)}</p>`,
    `<p>This code expires in ${input.expiresInMinutes} minutes.</p>`
  ].join("");

  await deliverEmail({ to: [input.to], subject, html, text, logLabel: "cli-login" });
}
