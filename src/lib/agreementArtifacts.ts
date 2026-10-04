import { PDFDocument } from "pdf-lib";
import { parseJson } from "./db.js";
import { renderPDFResult } from "./pdf.js";
import { pdfBufferForAgreement, sourcePdfBufferForAgreement } from "./pdfStorage.js";
import type { Agreement, FieldDefinition } from "./types.js";

export async function sourceDocumentBufferForAgreement(agreement: Agreement) {
  return sourcePdfBufferForAgreement(agreement) ?? (await renderPDFResult({ agreementId: `${agreement.id}-source`, markdown: agreement.document_markdown, fields: parseJson<FieldDefinition[]>(agreement.fields_json, []) })).buffer;
}

export async function certificateBufferForAgreement(agreement: Agreement) {
  const signed = await pdfBufferForAgreement(agreement, { requireCommitted: true });
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
  return signed;
}
