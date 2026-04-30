import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { env } from "./env.js";
import { documentHash } from "./audit.js";
import type { AuditEvent, FieldDefinition, SignedFields } from "./types.js";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function signatureImageHtml(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return "";
  return `<img class="signature-image" src="${escapeHtml(value)}" alt="Signature" />`;
}

function fieldDataUrl(value: unknown) {
  if (typeof value === "string" && value.startsWith("data:image/")) return value;
  if (value && typeof value === "object" && "data_url" in value && typeof value.data_url === "string") return value.data_url;
  return null;
}

function typedSignatureText(value: unknown) {
  if (typeof value === "string" && !value.startsWith("data:image/")) return value;
  if (value && typeof value === "object" && "typed_name" in value && typeof value.typed_name === "string") return value.typed_name;
  return null;
}

function signatureHtml(value: unknown) {
  const dataUrl = fieldDataUrl(value);
  if (dataUrl) return signatureImageHtml(dataUrl);

  const typed = typedSignatureText(value);
  if (typed) return `<div class="typed-signature">${escapeHtml(typed)}</div>`;

  return "";
}

function signedFieldsHtml(fields: FieldDefinition[], signedFields?: SignedFields) {
  if (!signedFields) return "";
  const rows = fields.map((field) => {
    const value = signedFields[field.id];
    const rendered = field.type === "signature" || field.type === "initials"
      ? signatureHtml(value)
      : escapeHtml(typeof value === "object" ? JSON.stringify(value) : value);
    return `<tr><th>${escapeHtml(field.label)}</th><td>${rendered || "&mdash;"}</td></tr>`;
  }).join("");

  return `
    <section class="signed-fields">
      <h2>Signed Fields</h2>
      <table>${rows}</table>
    </section>
  `;
}

function auditPageHtml(markdown: string, events: AuditEvent[], signedFields?: SignedFields) {
  if (!signedFields) return "";
  const signature = Object.values(signedFields).map(signatureHtml).find(Boolean);
  const rows = events.map((event) => `
    <tr>
      <td>${escapeHtml(event.created_at)}</td>
      <td>${escapeHtml(event.event_type)}</td>
      <td>${escapeHtml(event.ip_address ?? "")}</td>
      <td>${escapeHtml(event.user_agent ?? "")}</td>
    </tr>
  `).join("");

  return `
    <section class="audit page-break">
      <h1>Audit Trail</h1>
      <p><strong>Document SHA-256:</strong> <code>${documentHash(markdown)}</code></p>
      ${signature ?? ""}
      <table>
        <thead><tr><th>Timestamp</th><th>Event</th><th>IP</th><th>User Agent</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

export function renderDocumentHtml(input: {
  markdown: string;
  fields?: FieldDefinition[];
  signedFields?: SignedFields;
  auditEvents?: AuditEvent[];
}) {
  const body = marked.parse(input.markdown, { async: false }) as string;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172026; line-height: 1.65; margin: 0; padding: 40px 24px; background: #fff; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 30px; line-height: 1.15; margin: 0 0 28px; color: #0b1220; }
    h2 { font-size: 20px; margin: 28px 0 10px; color: #111827; }
    h3 { font-size: 16px; margin: 22px 0 8px; }
    p { margin: 0 0 14px; }
    hr { border: 0; border-top: 1px solid #d7dde5; margin: 28px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
    th, td { border: 1px solid #d7dde5; padding: 8px; text-align: left; vertical-align: top; }
    th { width: 34%; background: #f6f8fb; }
    code { overflow-wrap: anywhere; }
    .signed-fields { margin-top: 40px; padding-top: 22px; border-top: 2px solid #111827; }
    .signature-image { max-width: 320px; max-height: 120px; border: 1px solid #d7dde5; background: #fff; display: block; }
    .typed-signature { display: inline-block; min-width: 260px; max-width: 100%; padding: 14px 16px 10px; border-bottom: 1px solid #111827; font-family: "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive; font-size: 34px; line-height: 1.1; color: #0b1220; overflow-wrap: anywhere; }
    .page-break { break-before: page; page-break-before: always; }
  </style>
</head>
<body>
  <main>
    ${body}
    ${signedFieldsHtml(input.fields ?? [], input.signedFields)}
    ${auditPageHtml(input.markdown, input.auditEvents ?? [], input.signedFields)}
  </main>
</body>
</html>`;
}

export async function renderPDFResult(input: {
  agreementId: string;
  markdown: string;
  fields: FieldDefinition[];
  signedFields?: SignedFields;
  auditEvents?: AuditEvent[];
}) {
  mkdirSync(env.pdfOutputDir, { recursive: true });
  const html = renderDocumentHtml(input);
  const browser = await puppeteer.launch({
    args: env.isVercel ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: env.isVercel ? await chromium.executablePath() : process.env.CHROME_EXECUTABLE_PATH,
    channel: env.isVercel || process.env.CHROME_EXECUTABLE_PATH ? undefined : "chrome",
    headless: true
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.45in", right: "0.35in", bottom: "0.45in", left: "0.35in" } });
    const buffer = Buffer.from(pdf);
    const path = join(env.pdfOutputDir, `${input.agreementId}.pdf`);
    writeFileSync(path, buffer);
    return { path, buffer };
  } finally {
    await browser.close();
  }
}

export async function renderPDF(input: {
  agreementId: string;
  markdown: string;
  fields: FieldDefinition[];
  signedFields?: SignedFields;
  auditEvents?: AuditEvent[];
}) {
  return (await renderPDFResult(input)).path;
}
