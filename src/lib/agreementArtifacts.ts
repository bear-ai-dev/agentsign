import { PDFDocument } from "pdf-lib";
import { getAuditEvents, parseJson } from "./db.js";
import { renderPDFResult, signatureCertificateMarkdown } from "./pdf.js";
import { pdfBufferForAgreement, pdfSha256, sourcePdfBufferForAgreement } from "./pdfStorage.js";
import type { Agreement, FieldDefinition, SignedFields } from "./types.js";

export async function sourceDocumentBufferForAgreement(agreement: Agreement) {
  return sourcePdfBufferForAgreement(agreement) ?? (await renderPDFResult({ agreementId: `${agreement.id}-source`, markdown: agreement.document_markdown, fields: parseJson<FieldDefinition[]>(agreement.fields_json, []) })).buffer;
}

export async function certificateBufferForAgreement(agreement: Agreement) {
  const signed = await pdfBufferForAgreement(agreement);
  const source = sourcePdfBufferForAgreement(agreement);
  if (source) {
    const sourceDocument = await PDFDocument.load(source);
    const signedDocument = await PDFDocument.load(signed);
    const certificate = await PDFDocument.create();
    const indexes = signedDocument.getPageIndices().slice(sourceDocument.getPageCount());
    if (!indexes.length) throw new Error("Completed agreement has no signature certificate");
    for (const page of await certificate.copyPages(signedDocument, indexes)) certificate.addPage(page);
    return Buffer.from(await certificate.save());
  }
  return (await renderPDFResult({ agreementId: `${agreement.id}-certificate`, markdown: signatureCertificateMarkdown(agreement.document_title), fields: parseJson<FieldDefinition[]>(agreement.fields_json, []), signedFields: parseJson<SignedFields>(agreement.signed_fields_json, {}), auditEvents: await getAuditEvents(agreement.id), documentSha256: pdfSha256(Buffer.from(agreement.document_markdown)) })).buffer;
}
