import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { PDFDocument } from "pdf-lib";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { env } from "./env.js";
import { signatureFontFaceCss } from "./signatureFont.js";
import { documentHash } from "./audit.js";
import { isMultiPartySignedFields, signedFieldsForRole, signerRoleLabel } from "./signing.js";
import type { AuditEvent, FieldDefinition, SignedFields, SignerRole } from "./types.js";

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
  const typed = typedSignatureText(value);
  if (typed) return `<div class="typed-signature">${escapeHtml(typed)}</div>`;

  const dataUrl = fieldDataUrl(value);
  if (dataUrl) return signatureImageHtml(dataUrl);

  return "";
}

function signedFieldRowsHtml(fields: FieldDefinition[], roleFields: SignedFields) {
  return fields.map((field) => {
    const value = roleFields[field.id];
    const rendered = field.type === "signature" || field.type === "initials"
      ? signatureHtml(value)
      : escapeHtml(typeof value === "object" ? JSON.stringify(value) : value);
    return `<tr><th>${escapeHtml(field.label)}</th><td>${rendered || "&mdash;"}</td></tr>`;
  }).join("");
}

function signedFieldsSectionHtml(title: string, fields: FieldDefinition[], roleFields: SignedFields) {
  return `
    <section class="signed-fields">
      <h2>${escapeHtml(title)}</h2>
      <table>${signedFieldRowsHtml(fields, roleFields)}</table>
    </section>
  `;
}

function signedFieldsHtml(fields: FieldDefinition[], signedFields?: SignedFields) {
  if (!signedFields) return "";

  if (isMultiPartySignedFields(signedFields)) {
    return (["recipient", "sender"] as SignerRole[])
      .map((role) => {
        const roleFields = signedFieldsForRole(signedFields, role);
        return roleFields ? signedFieldsSectionHtml(`${signerRoleLabel(role)} Signed Fields`, fields, roleFields) : "";
      })
      .join("");
  }

  return signedFieldsSectionHtml("Signed Fields", fields, signedFields);
}

function signatureValues(signedFields: SignedFields) {
  if (isMultiPartySignedFields(signedFields)) {
    return (["recipient", "sender"] as SignerRole[])
      .flatMap((role) => Object.values(signedFieldsForRole(signedFields, role) ?? {}));
  }
  return Object.values(signedFields);
}

function auditPageHtml(markdown: string, events: AuditEvent[], signedFields?: SignedFields) {
  if (!signedFields) return "";
  const signatures = signatureValues(signedFields).map(signatureHtml).filter(Boolean).join("");
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
      <div class="audit-signatures">${signatures}</div>
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
  const signatureFontCss = signatureFontFaceCss();
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    ${signatureFontCss ?? ""}
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
    .signature-image { max-width: 360px; max-height: 120px; padding: 4px 8px 0; border-bottom: 1px solid #111827; background: #fff; display: block; }
    .typed-signature { display: inline-block; min-width: 260px; max-width: 100%; padding: 10px 16px 8px; border-bottom: 1px solid #111827; font-family: "AgentContract Signature", "Brush Script MT", "Segoe Script", "Snell Roundhand", "Apple Chancery", cursive; font-size: 48px; font-style: normal; font-weight: 400; line-height: 1.05; color: #0b1220; overflow-wrap: anywhere; }
    .audit-signatures { display: grid; gap: 10px; margin: 14px 0; }
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

async function appendPdfBuffers(primary: Buffer, appendix: Buffer) {
  const output = await PDFDocument.create();
  for (const buffer of [primary, appendix]) {
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  return Buffer.from(await output.save());
}

export async function renderCompletedPDFResult(input: {
  agreementId: string;
  markdown: string;
  originalPdf?: Buffer;
  fields: FieldDefinition[];
  signedFields?: SignedFields;
  auditEvents?: AuditEvent[];
}) {
  if (!input.originalPdf) return renderPDFResult(input);

  mkdirSync(env.pdfOutputDir, { recursive: true });
  const appendix = await renderPDFResult({
    agreementId: `${input.agreementId}-certificate`,
    markdown: input.markdown,
    fields: input.fields,
    signedFields: input.signedFields,
    auditEvents: input.auditEvents
  });
  const buffer = await appendPdfBuffers(input.originalPdf, appendix.buffer);
  const path = join(env.pdfOutputDir, `${input.agreementId}.pdf`);
  writeFileSync(path, buffer);
  return { path, buffer };
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
