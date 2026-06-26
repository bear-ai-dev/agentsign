import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { env } from "./env.js";
import { documentHash } from "./audit.js";
import type { AuditEvent, FieldDefinition, SignedFields } from "./types.js";

export const signatureFontFaceCss = `
@font-face {
  font-family: "AgentContractSignature";
  font-style: normal;
  font-weight: 400;
  src: url("https://fonts.gstatic.com/s/allura/v23/9oRPNYsQpS4zjuAPjA.ttf") format("truetype");
}`;

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

function typedSignatureSvg(value: string) {
  const text = value.trim().slice(0, 300);
  const width = Math.min(520, Math.max(220, text.length * 22 + 96));
  const safeText = escapeHtml(text);
  return `<svg class="typed-signature" viewBox="0 0 ${width} 82" width="${width}" height="82" role="img" aria-label="Signature: ${safeText}" preserveAspectRatio="xMinYMid meet"><text class="typed-signature-text" x="12" y="52">${safeText}</text><path class="typed-signature-line" d="M8 68 H ${width - 8}" /></svg>`;
}

function signatureHtml(value: unknown) {
  const dataUrl = fieldDataUrl(value);
  if (dataUrl) return signatureImageHtml(dataUrl);

  const typed = typedSignatureText(value);
  if (typed) return typedSignatureSvg(typed);

  return "";
}

function fieldValuePresent(value: unknown) {
  return value !== undefined && value !== null && value !== "" && value !== false;
}

function isStoredSignatureValue(value: unknown) {
  return Boolean(
    fieldDataUrl(value)
    || (value && typeof value === "object" && "typed_name" in value && typeof value.typed_name === "string")
  );
}

function renderedFieldHtml(field: FieldDefinition | undefined, value: unknown) {
  if (!fieldValuePresent(value)) return `<span class="signed-inline empty"></span>`;
  if (field?.type === "signature" || field?.type === "initials" || isStoredSignatureValue(value)) {
    return signatureHtml(value) || `<span class="signed-inline empty"></span>`;
  }
  return `<span class="signed-inline">${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</span>`;
}

function renderSignedFieldPlaceholders(markdown: string, fields: FieldDefinition[], signedFields?: SignedFields) {
  const renderedFieldIds = new Set<string>();
  const htmlByToken = new Map<string, string>();

  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const renderedMarkdown = markdown.replace(
    /\{\{\s*(?:signed|signed_field|field)\s*:\s*([A-Za-z][A-Za-z0-9_-]{0,79})\s*\}\}/g,
    (_match, fieldId: string) => {
      renderedFieldIds.add(fieldId);
      const token = `AGENTCONTRACT_SIGNED_FIELD_${htmlByToken.size}_${fieldId}`;
      htmlByToken.set(token, renderedFieldHtml(fieldsById.get(fieldId), signedFields?.[fieldId]));
      return token;
    }
  );

  return { markdown: renderedMarkdown, renderedFieldIds, htmlByToken };
}

function signedFieldsHtml(fields: FieldDefinition[], signedFields?: SignedFields, renderedFieldIds = new Set<string>()) {
  if (!signedFields) return "";
  const rows = fields.filter((field) => !renderedFieldIds.has(field.id)).map((field) => {
    const value = signedFields[field.id];
    const rendered = field.type === "signature" || field.type === "initials"
      ? signatureHtml(value)
      : escapeHtml(typeof value === "object" ? JSON.stringify(value) : value);
    return `<tr><th>${escapeHtml(field.label)}</th><td>${rendered || "&mdash;"}</td></tr>`;
  }).join("");
  if (!rows) return "";

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
  const fields = input.fields ?? [];
  const { body, renderedFieldIds } = renderContractBodyHtml({
    markdown: input.markdown,
    fields,
    signedFields: input.signedFields
  });
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    ${signatureFontFaceCss}
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
    .signed-inline { display: inline-block; min-width: 150px; padding: 0 8px 2px; border-bottom: 1px solid #111827; line-height: 1.25; color: #0b1220; overflow-wrap: anywhere; }
    .signed-inline.empty { min-height: 1.25em; }
    .signed-fields { margin-top: 40px; padding-top: 22px; border-top: 2px solid #111827; }
    .signature-image { max-width: 320px; max-height: 120px; border: 1px solid #d7dde5; background: #fff; display: block; }
    .typed-signature { display: inline-block; max-width: 100%; vertical-align: middle; overflow: visible; }
    .typed-signature-text { font-family: "AgentContractSignature", "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive; font-size: 52px; fill: #0b1220; }
    .typed-signature-line { stroke: #111827; stroke-width: 1.4; stroke-linecap: round; }
    .page-break { break-before: page; page-break-before: always; }
  </style>
</head>
<body>
  <main>
    ${body}
    ${signedFieldsHtml(fields, input.signedFields, renderedFieldIds)}
    ${auditPageHtml(input.markdown, input.auditEvents ?? [], input.signedFields)}
  </main>
</body>
</html>`;
}

export function renderContractBodyHtml(input: {
  markdown: string;
  fields?: FieldDefinition[];
  signedFields?: SignedFields;
}) {
  const fields = input.fields ?? [];
  const rendered = renderSignedFieldPlaceholders(input.markdown, fields, input.signedFields);
  let body = marked.parse(rendered.markdown, { async: false }) as string;
  for (const [token, html] of rendered.htmlByToken) {
    body = body.replaceAll(token, html);
  }
  return { body, renderedFieldIds: rendered.renderedFieldIds };
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
    await page.evaluate(() => document.fonts.ready);
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
