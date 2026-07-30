import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { getAuditEvents, parseJson, run } from "./db.js";
import { renderAgreementPdfResult } from "./pdf.js";
import type { Agreement, FieldDefinition, SignedFields } from "./types.js";

export function pdfSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sourcePdfBufferForAgreement(agreement: Agreement) {
  if (!agreement.source_pdf_base64) return null;
  const buffer = Buffer.from(agreement.source_pdf_base64, "base64");
  if (agreement.source_pdf_bytes !== null && buffer.byteLength !== Number(agreement.source_pdf_bytes)) {
    throw new Error(`Stored source PDF byte length mismatch for ${agreement.id}`);
  }
  if (agreement.source_pdf_sha256 && pdfSha256(buffer) !== agreement.source_pdf_sha256) {
    throw new Error(`Stored source PDF hash mismatch for ${agreement.id}`);
  }
  return buffer;
}

export async function saveSignedPdfToAgreement(input: {
  agreementId: string;
  path: string;
  buffer: Buffer;
}) {
  await run(
    `UPDATE agreements
     SET signed_pdf_path = ?, signed_pdf_base64 = ?, signed_pdf_sha256 = ?, signed_pdf_bytes = ?
     WHERE id = ?`,
    input.path,
    input.buffer.toString("base64"),
    pdfSha256(input.buffer),
    input.buffer.byteLength,
    input.agreementId
  );
}

export async function pdfBufferForAgreement(agreement: Agreement) {
  if (agreement.status === "completed" && agreement.signed_pdf_base64) {
    const buffer = Buffer.from(agreement.signed_pdf_base64, "base64");
    if (agreement.signed_pdf_bytes !== null && buffer.byteLength !== Number(agreement.signed_pdf_bytes)) {
      throw new Error(`Stored signed PDF byte length mismatch for ${agreement.id}`);
    }
    if (agreement.signed_pdf_sha256 && pdfSha256(buffer) !== agreement.signed_pdf_sha256) {
      throw new Error(`Stored signed PDF hash mismatch for ${agreement.id}`);
    }
    return buffer;
  }

  if (agreement.signed_pdf_path && existsSync(agreement.signed_pdf_path)) {
    const buffer = readFileSync(agreement.signed_pdf_path);
    if (agreement.status === "completed") {
      await saveSignedPdfToAgreement({ agreementId: agreement.id, path: agreement.signed_pdf_path, buffer });
    }
    return buffer;
  }

  const rendered = await renderAgreementPdfResult({
    agreementId: agreement.id,
    markdown: agreement.document_markdown,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    signedFields: parseJson<SignedFields | undefined>(agreement.signed_fields_json, undefined),
    auditEvents: await getAuditEvents(agreement.id),
    sourcePdf: sourcePdfBufferForAgreement(agreement),
    documentTitle: agreement.document_title
  });

  if (agreement.status === "completed") {
    await saveSignedPdfToAgreement({ agreementId: agreement.id, path: rendered.path, buffer: rendered.buffer });
  }

  return rendered.buffer;
}
