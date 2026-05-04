import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { get, getAuditEvents, parseJson, run } from "./db.js";
import { renderCompletedPDFResult } from "./pdf.js";
import { originalPdfBufferForAgreement } from "./originalPdf.js";
import { isMultiPartySignedFields, signedFieldsForRole } from "./signing.js";
import type { Agreement, FieldDefinition, SignedFields } from "./types.js";

export const signedPdfRendererVersion = "signature-font-v1";

export function pdfSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function metadataWithSignedPdfRendererVersion(metadataJson: string | null | undefined) {
  const metadata = parseJson<Record<string, unknown>>(metadataJson, {});
  metadata.signed_pdf_renderer_version = signedPdfRendererVersion;
  return JSON.stringify(metadata);
}

function typedSignatureValue(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0 && !value.startsWith("data:image/");
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (typeof record.typed_name === "string" && record.typed_name.trim().length > 0)
    || record.method === "typed";
}

function signedFieldsContainTypedSignature(signedFields: SignedFields | undefined, fields: FieldDefinition[]) {
  if (!signedFields) return false;

  const signatureFields = fields.filter((field) => field.type === "signature" || field.type === "initials");
  if (!signatureFields.length) return false;

  const roleFields = isMultiPartySignedFields(signedFields)
    ? [signedFieldsForRole(signedFields, "recipient"), signedFieldsForRole(signedFields, "sender")]
    : [signedFields];

  return signatureFields.some((field) => roleFields.some((values) => values && typedSignatureValue(values[field.id])));
}

function signedPdfCacheIsCurrent(agreement: Agreement, signedFields: SignedFields | undefined, fields: FieldDefinition[]) {
  if (!signedFieldsContainTypedSignature(signedFields, fields)) return true;
  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  return metadata.signed_pdf_renderer_version === signedPdfRendererVersion;
}

export async function saveSignedPdfToAgreement(input: {
  agreementId: string;
  path: string;
  buffer: Buffer;
}) {
  const existing = await get<{ metadata_json: string | null }>("SELECT metadata_json FROM agreements WHERE id = ?", input.agreementId);
  await run(
    `UPDATE agreements
     SET signed_pdf_path = ?,
         signed_pdf_base64 = ?,
         signed_pdf_sha256 = ?,
         signed_pdf_bytes = ?,
         metadata_json = ?
     WHERE id = ?`,
    input.path,
    input.buffer.toString("base64"),
    pdfSha256(input.buffer),
    input.buffer.byteLength,
    metadataWithSignedPdfRendererVersion(existing?.metadata_json),
    input.agreementId
  );
}

export async function pdfBufferForAgreement(agreement: Agreement) {
  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  const signedFields = parseJson<SignedFields | undefined>(agreement.signed_fields_json, undefined);
  const cacheIsCurrent = signedPdfCacheIsCurrent(agreement, signedFields, fields);

  if (agreement.status === "completed" && agreement.signed_pdf_base64 && cacheIsCurrent) {
    const buffer = Buffer.from(agreement.signed_pdf_base64, "base64");
    if (agreement.signed_pdf_bytes !== null && buffer.byteLength !== Number(agreement.signed_pdf_bytes)) {
      throw new Error(`Stored signed PDF byte length mismatch for ${agreement.id}`);
    }
    if (agreement.signed_pdf_sha256 && pdfSha256(buffer) !== agreement.signed_pdf_sha256) {
      throw new Error(`Stored signed PDF hash mismatch for ${agreement.id}`);
    }
    return buffer;
  }

  if (agreement.signed_pdf_path && existsSync(agreement.signed_pdf_path) && cacheIsCurrent) {
    const buffer = readFileSync(agreement.signed_pdf_path);
    if (agreement.status === "completed") {
      await saveSignedPdfToAgreement({ agreementId: agreement.id, path: agreement.signed_pdf_path, buffer });
    }
    return buffer;
  }

  const rendered = await renderCompletedPDFResult({
    agreementId: agreement.id,
    markdown: agreement.document_markdown,
    originalPdf: originalPdfBufferForAgreement(agreement) ?? undefined,
    fields,
    signedFields,
    auditEvents: await getAuditEvents(agreement.id)
  });

  if (agreement.status === "completed") {
    await saveSignedPdfToAgreement({ agreementId: agreement.id, path: rendered.path, buffer: rendered.buffer });
  }

  return rendered.buffer;
}
